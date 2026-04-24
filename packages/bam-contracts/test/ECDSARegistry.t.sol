// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ECDSARegistry } from "../src/core/ECDSARegistry.sol";
import { IECDSARegistry } from "../src/interfaces/IECDSARegistry.sol";
import { IERC_BAM_SignatureRegistry } from "../src/interfaces/IERC_BAM_SignatureRegistry.sol";

/// @title ECDSARegistryTest
/// @notice Tests for the ERC-8180 scheme-0x01 ECDSA registry.
contract ECDSARegistryTest is Test {
    ECDSARegistry internal registry;

    /// @dev Owner EOAs used across tests.
    uint256 internal aliceKey;
    address internal alice;
    uint256 internal bobKey;
    address internal bob;

    /// @dev Delegate EOAs (separate from owners) used across tests.
    uint256 internal aliceDelegateKey;
    address internal aliceDelegate;
    uint256 internal bobDelegateKey;
    address internal bobDelegate;

    string internal constant POP_DOMAIN = "ERC-BAM-ECDSA-PoP.v1";

    function setUp() public {
        registry = new ECDSARegistry();

        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        (aliceDelegate, aliceDelegateKey) = makeAddrAndKey("alice-delegate");
        (bobDelegate, bobDelegateKey) = makeAddrAndKey("bob-delegate");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    function _popInner(address owner) internal view returns (bytes32) {
        return keccak256(abi.encode(POP_DOMAIN, block.chainid, address(registry), owner));
    }

    function _ethSigned(bytes32 inner) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    function _sign(uint256 signerKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Well-formed PoP for `delegateKey` over `owner`.
    function _pop(uint256 delegateKey, address owner) internal view returns (bytes memory) {
        return _sign(delegateKey, _ethSigned(_popInner(owner)));
    }

    function _pubKey(address delegate) internal pure returns (bytes memory) {
        return abi.encodePacked(delegate);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // METADATA
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_metadata_schemeId() public view {
        assertEq(registry.schemeId(), 0x01, "schemeId must be 0x01");
    }

    function test_metadata_schemeName() public view {
        assertEq(registry.schemeName(), "ECDSA-secp256k1", "schemeName mismatch");
    }

    function test_metadata_pubKeySize() public view {
        assertEq(registry.pubKeySize(), 20, "pubKeySize must be 20");
    }

    function test_metadata_signatureSize() public view {
        assertEq(registry.signatureSize(), 65, "signatureSize must be 65");
    }

    function test_metadata_supportsAggregation() public view {
        assertFalse(registry.supportsAggregation(), "ECDSA must not advertise aggregation");
    }

    function test_verifyAggregated_reverts() public {
        bytes[] memory keys = new bytes[](0);
        bytes32[] memory hashes = new bytes32[](0);
        vm.expectRevert(ECDSARegistry.AggregationNotSupported.selector);
        registry.verifyAggregated(keys, hashes, "");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTER
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_register_happy() public {
        bytes memory pubKey = _pubKey(aliceDelegate);
        bytes memory pop = _pop(aliceDelegateKey, alice);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IERC_BAM_SignatureRegistry.KeyRegistered(alice, pubKey, 1);

        vm.prank(alice);
        uint256 index = registry.register(pubKey, pop);
        assertEq(index, 1, "first register assigns index 1");
    }

    function test_register_assignsIncrementingIndices() public {
        vm.prank(alice);
        uint256 aliceIndex = registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        vm.prank(bob);
        uint256 bobIndex = registry.register(_pubKey(bobDelegate), _pop(bobDelegateKey, bob));

        assertEq(aliceIndex, 1);
        assertEq(bobIndex, 2);
    }

    function test_register_invalidPubKeyLength_short() public {
        bytes memory pop = _pop(aliceDelegateKey, alice);
        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidPublicKey.selector);
        registry.register(hex"0102030405", pop);
    }

    function test_register_invalidPubKeyLength_long() public {
        bytes memory longKey = abi.encodePacked(aliceDelegate, uint8(0xff));
        bytes memory pop = _pop(aliceDelegateKey, alice);
        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidPublicKey.selector);
        registry.register(longKey, pop);
    }

    function test_register_doubleRegister_reverts() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BAM_SignatureRegistry.AlreadyRegistered.selector, alice)
        );
        registry.register(_pubKey(bobDelegate), _pop(bobDelegateKey, alice));
    }

    function test_register_popSignedByWrongKey_reverts() public {
        // PoP over alice's envelope but signed by bob's delegate key.
        bytes memory badPop = _pop(bobDelegateKey, alice);

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidProofOfPossession.selector);
        registry.register(_pubKey(aliceDelegate), badPop);
    }

    function test_register_popForWrongOwner_reverts() public {
        // PoP signed by alice's delegate key but binding bob as owner —
        // when alice submits it, the PoP envelope (owner=bob) mismatches
        // the msg.sender (alice), so the recovered delegate address
        // won't equal aliceDelegate under alice's envelope.
        bytes memory badPop = _pop(aliceDelegateKey, bob);

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidProofOfPossession.selector);
        registry.register(_pubKey(aliceDelegate), badPop);
    }

    function test_register_popMissingEthPrefix_reverts() public {
        // Sign the bare popInner without the "\x19Ethereum Signed Message:\n32"
        // prefix. On-chain, the registry wraps it before recovery, so the
        // signature will recover to a different address.
        bytes memory unprefixedPop = _sign(aliceDelegateKey, _popInner(alice));

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidProofOfPossession.selector);
        registry.register(_pubKey(aliceDelegate), unprefixedPop);
    }

    function test_register_garbagePopRecoversToZero_reverts() public {
        // Garbage signature whose v is canonical (27) but r/s will cause
        // ECDSA.tryRecover to return an arbitrary address (or, for high-s
        // or invalid curve points, an error). Either way this must revert
        // InvalidProofOfPossession and not succeed with `address(0)` as
        // delegate.
        bytes memory garbage = new bytes(65);
        garbage[64] = bytes1(uint8(27));

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidProofOfPossession.selector);
        registry.register(_pubKey(aliceDelegate), garbage);
    }

    function test_register_popLengthMismatch_reverts() public {
        bytes memory shortSig = hex"0102";

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidProofOfPossession.selector);
        registry.register(_pubKey(aliceDelegate), shortSig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFY
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev secp256k1 curve order.
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function _personalHash(bytes32 raw) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", raw));
    }

    function test_verify_happy_personalSign() public view {
        bytes32 raw = keccak256("hello");
        bytes32 envelope = _personalHash(raw);
        bytes memory sig = _sign(aliceDelegateKey, envelope);

        assertTrue(registry.verify(_pubKey(aliceDelegate), envelope, sig));
    }

    function test_verify_happy_rawHash() public view {
        // Registry is envelope-agnostic: if the caller hands in a raw
        // pre-image hash and signs the same hash, verify must return true.
        bytes32 raw = keccak256("raw-signing-path");
        bytes memory sig = _sign(aliceDelegateKey, raw);

        assertTrue(registry.verify(_pubKey(aliceDelegate), raw, sig));
    }

    function test_verify_wrongSigner_returnsFalse() public view {
        bytes32 envelope = _personalHash(keccak256("hello"));
        bytes memory sig = _sign(bobDelegateKey, envelope);

        assertFalse(registry.verify(_pubKey(aliceDelegate), envelope, sig));
    }

    function test_verify_highS_returnsFalse() public view {
        bytes32 envelope = _personalHash(keccak256("malleability"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceDelegateKey, envelope);
        // Flip to the malleated-but-equivalent (r, n-s, v^1).
        bytes32 mal_s = bytes32(SECP256K1_N - uint256(s));
        uint8 mal_v = v ^ 1;
        bytes memory malSig = abi.encodePacked(r, mal_s, mal_v);

        assertFalse(registry.verify(_pubKey(aliceDelegate), envelope, malSig));
    }

    function test_verify_nonCanonicalV_returnsFalse() public view {
        bytes32 envelope = _personalHash(keccak256("v-scope"));
        (, bytes32 r, bytes32 s) = vm.sign(aliceDelegateKey, envelope);

        // v values outside {27, 28} must not verify. OZ ECDSA.tryRecover
        // returns RecoverError.InvalidSignature for these.
        uint8[4] memory bad = [uint8(0), uint8(1), uint8(29), uint8(35)];
        for (uint256 i = 0; i < bad.length; i++) {
            bytes memory sig = abi.encodePacked(r, s, bad[i]);
            assertFalse(
                registry.verify(_pubKey(aliceDelegate), envelope, sig),
                "non-canonical v must not verify"
            );
        }
    }

    function test_verify_zeroAddressRecovery_returnsFalse() public view {
        // A zero-filled signature with a canonical v cannot recover to a
        // valid address; the library returns InvalidSignature and the
        // registry returns false (does NOT accept `address(0)` as match).
        bytes memory garbage = new bytes(65);
        garbage[64] = bytes1(uint8(27));
        bytes32 raw = keccak256("irrelevant");

        assertFalse(registry.verify(_pubKey(aliceDelegate), raw, garbage));
    }

    function test_verify_invalidPubKeyLength_reverts() public {
        bytes32 raw = keccak256("hello");
        bytes memory sig = _sign(aliceDelegateKey, raw);

        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidPublicKey.selector);
        registry.verify(hex"01020304", raw, sig);
    }

    function test_verify_invalidSignatureLength_returnsFalse() public view {
        // Signature-length malformedness is modeled as a verification failure
        // (return false), not a revert — keeps `verify` / `verifyWithRegisteredKey`
        // / SDK `verifyEcdsaLocal` in lock-step on malformed input.
        bytes32 raw = keccak256("hello");
        assertFalse(registry.verify(_pubKey(aliceDelegate), raw, hex"010203"));
        assertFalse(registry.verify(_pubKey(aliceDelegate), raw, new bytes(64)));
        assertFalse(registry.verify(_pubKey(aliceDelegate), raw, new bytes(66)));
    }

    function test_verifyWithRegisteredKey_invalidSignatureLength_returnsFalse() public view {
        // Symmetric to `verify` — must also return false, not revert.
        bytes32 envelope = _personalHash(keccak256("bad-len"));
        assertFalse(registry.verifyWithRegisteredKey(alice, envelope, hex"010203"));
        assertFalse(registry.verifyWithRegisteredKey(alice, envelope, new bytes(64)));
        assertFalse(registry.verifyWithRegisteredKey(alice, envelope, new bytes(66)));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // isRegistered / getKey / verifyWithRegisteredKey
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_isRegistered_alwaysTrue() public view {
        assertTrue(registry.isRegistered(alice));
        assertTrue(registry.isRegistered(bob));
        assertTrue(registry.isRegistered(address(0)));
        assertTrue(registry.isRegistered(address(0xdead)));
    }

    function test_getKey_unregistered_returnsEmpty() public view {
        bytes memory k = registry.getKey(alice);
        assertEq(k.length, 0, "unregistered owner must return empty bytes");
    }

    function test_getKey_registered_returnsDelegate() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        bytes memory k = registry.getKey(alice);
        assertEq(k.length, 20, "keyed owner must return 20-byte delegate");
        assertEq(address(bytes20(k)), aliceDelegate);
    }

    function test_verifyWithRegisteredKey_keyless_happy() public view {
        bytes32 envelope = _personalHash(keccak256("keyless-msg"));
        bytes memory sig = _sign(aliceKey, envelope);

        assertTrue(registry.verifyWithRegisteredKey(alice, envelope, sig));
    }

    function test_verifyWithRegisteredKey_keyless_wrongSigner() public view {
        bytes32 envelope = _personalHash(keccak256("keyless-msg"));
        bytes memory sig = _sign(bobKey, envelope);

        assertFalse(registry.verifyWithRegisteredKey(alice, envelope, sig));
    }

    function test_verifyWithRegisteredKey_keyed_happy() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        bytes32 envelope = _personalHash(keccak256("keyed-msg"));
        bytes memory sig = _sign(aliceDelegateKey, envelope);

        assertTrue(registry.verifyWithRegisteredKey(alice, envelope, sig));
    }

    function test_verifyWithRegisteredKey_keyed_rejectsOwnerEoa() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        // Alice's own EOA key must NOT verify once she has a delegate bound.
        bytes32 envelope = _personalHash(keccak256("keyed-msg"));
        bytes memory ownerSig = _sign(aliceKey, envelope);

        assertFalse(registry.verifyWithRegisteredKey(alice, envelope, ownerSig));
    }

    function test_verifyWithRegisteredKey_unregisteredNeverReverts() public view {
        // Empty sig, random owner — must return false, never revert NotRegistered.
        bytes memory emptySig = "";
        bool ok = registry.verifyWithRegisteredKey(alice, bytes32(0), emptySig);
        assertFalse(ok);
    }

    function test_verifyWithRegisteredKey_zeroOwner_garbageSig_returnsFalse() public view {
        // Attacker submits garbage against owner = 0x0 hoping ecrecover
        // returns 0x0 and the registry matches — must be rejected.
        bytes memory garbage = new bytes(65);
        garbage[64] = bytes1(uint8(27));
        assertFalse(registry.verifyWithRegisteredKey(address(0), bytes32(0), garbage));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ROTATE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_rotate_happy() public {
        vm.prank(alice);
        uint256 firstIndex =
            registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        vm.expectEmit(true, false, false, true, address(registry));
        emit IECDSARegistry.KeyRotated(alice, aliceDelegate, bobDelegate, firstIndex + 1);

        vm.prank(alice);
        uint256 newIndex = registry.rotate(_pubKey(bobDelegate), _pop(bobDelegateKey, alice));
        assertEq(newIndex, firstIndex + 1, "rotation assigns a fresh index");

        bytes memory k = registry.getKey(alice);
        assertEq(address(bytes20(k)), bobDelegate, "getKey reflects new delegate");
    }

    function test_rotate_withoutPriorRegister_reverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BAM_SignatureRegistry.NotRegistered.selector, alice)
        );
        registry.rotate(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));
    }

    function test_rotate_badPop_reverts() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        // PoP signed by alice's delegate, not bob's — must fail.
        bytes memory badPop = _pop(aliceDelegateKey, alice);

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidProofOfPossession.selector);
        registry.rotate(_pubKey(bobDelegate), badPop);
    }

    function test_rotate_badPubKeyLength_reverts() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidPublicKey.selector);
        registry.rotate(hex"deadbeef", _pop(bobDelegateKey, alice));
    }

    function test_rotate_staleIndexCleared() public {
        vm.prank(alice);
        uint256 oldIndex =
            registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));
        assertEq(registry.ownerOfIndex(oldIndex), alice, "pre-rotation invariant");

        vm.prank(alice);
        uint256 newIndex =
            registry.rotate(_pubKey(bobDelegate), _pop(bobDelegateKey, alice));

        assertEq(registry.ownerOfIndex(oldIndex), address(0), "old index must be cleared");
        assertEq(registry.ownerOfIndex(newIndex), alice, "new index points at alice");
        assertEq(registry.indexOf(alice), newIndex, "alice indexOf updated");
    }

    function test_rotate_verifyWithRegisteredKey_acceptsNewRejectsOld() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        vm.prank(alice);
        registry.rotate(_pubKey(bobDelegate), _pop(bobDelegateKey, alice));

        bytes32 envelope = _personalHash(keccak256("post-rotation-msg"));
        bytes memory oldSig = _sign(aliceDelegateKey, envelope);
        bytes memory newSig = _sign(bobDelegateKey, envelope);

        assertFalse(
            registry.verifyWithRegisteredKey(alice, envelope, oldSig),
            "old delegate sig must no longer verify"
        );
        assertTrue(
            registry.verifyWithRegisteredKey(alice, envelope, newSig),
            "new delegate sig must verify"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // hasDelegate
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_hasDelegate_falseForKeyless() public view {
        assertFalse(registry.hasDelegate(alice));
        assertFalse(registry.hasDelegate(address(0)));
    }

    function test_hasDelegate_trueAfterRegister() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));
        assertTrue(registry.hasDelegate(alice));
    }

    function test_hasDelegate_trueAfterRotate() public {
        vm.prank(alice);
        registry.register(_pubKey(aliceDelegate), _pop(aliceDelegateKey, alice));

        vm.prank(alice);
        registry.rotate(_pubKey(bobDelegate), _pop(bobDelegateKey, alice));

        assertTrue(registry.hasDelegate(alice));
        bytes memory k = registry.getKey(alice);
        assertEq(address(bytes20(k)), bobDelegate);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUZZ
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Bound a fuzzed private-key seed to the secp256k1 group order.
    function _boundKey(uint256 seed) internal pure returns (uint256) {
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        return bound(seed, 1, n - 1);
    }

    function testFuzz_register_thenVerify_happy(uint256 ownerSeed, uint256 delegateSeed) public {
        ownerSeed = _boundKey(ownerSeed);
        delegateSeed = _boundKey(delegateSeed);
        vm.assume(ownerSeed != delegateSeed);

        address ownerAddr = vm.addr(ownerSeed);
        address delegateAddr = vm.addr(delegateSeed);
        vm.assume(ownerAddr != address(0) && delegateAddr != address(0));
        vm.assume(ownerAddr != delegateAddr);

        // PoP: delegate signs the registry-scoped envelope for ownerAddr.
        bytes32 popInner = keccak256(
            abi.encode(POP_DOMAIN, block.chainid, address(registry), ownerAddr)
        );
        bytes memory pop = _sign(delegateSeed, _ethSigned(popInner));

        vm.prank(ownerAddr);
        registry.register(abi.encodePacked(delegateAddr), pop);

        // Now sign a random message with the delegate and expect verify to pass.
        bytes32 envelope = _personalHash(keccak256(abi.encode(ownerSeed, delegateSeed)));
        bytes memory msgSig = _sign(delegateSeed, envelope);

        assertTrue(registry.verify(abi.encodePacked(delegateAddr), envelope, msgSig));
        assertTrue(registry.verifyWithRegisteredKey(ownerAddr, envelope, msgSig));
    }

    function testFuzz_rotate_then_verifyWithRegisteredKey(
        uint256 ownerSeed,
        uint256 firstDelegateSeed,
        uint256 secondDelegateSeed
    ) public {
        ownerSeed = _boundKey(ownerSeed);
        firstDelegateSeed = _boundKey(firstDelegateSeed);
        secondDelegateSeed = _boundKey(secondDelegateSeed);
        vm.assume(ownerSeed != firstDelegateSeed);
        vm.assume(ownerSeed != secondDelegateSeed);
        vm.assume(firstDelegateSeed != secondDelegateSeed);

        address ownerAddr = vm.addr(ownerSeed);
        address firstDelegateAddr = vm.addr(firstDelegateSeed);
        address secondDelegateAddr = vm.addr(secondDelegateSeed);
        vm.assume(ownerAddr != address(0));
        vm.assume(firstDelegateAddr != address(0));
        vm.assume(secondDelegateAddr != address(0));
        vm.assume(ownerAddr != firstDelegateAddr && ownerAddr != secondDelegateAddr);
        vm.assume(firstDelegateAddr != secondDelegateAddr);

        bytes32 inner = keccak256(
            abi.encode(POP_DOMAIN, block.chainid, address(registry), ownerAddr)
        );
        bytes memory firstPop = _sign(firstDelegateSeed, _ethSigned(inner));
        bytes memory secondPop = _sign(secondDelegateSeed, _ethSigned(inner));

        vm.prank(ownerAddr);
        registry.register(abi.encodePacked(firstDelegateAddr), firstPop);
        vm.prank(ownerAddr);
        registry.rotate(abi.encodePacked(secondDelegateAddr), secondPop);

        bytes32 envelope = _personalHash(keccak256(abi.encode(ownerSeed)));
        bytes memory newSig = _sign(secondDelegateSeed, envelope);
        bytes memory oldSig = _sign(firstDelegateSeed, envelope);

        assertTrue(registry.verifyWithRegisteredKey(ownerAddr, envelope, newSig));
        assertFalse(registry.verifyWithRegisteredKey(ownerAddr, envelope, oldSig));
    }

    function testFuzz_verify_wrongSignerRejected(uint256 signerSeed, uint256 expectedSeed)
        public
        view
    {
        signerSeed = _boundKey(signerSeed);
        expectedSeed = _boundKey(expectedSeed);
        vm.assume(signerSeed != expectedSeed);

        address expected = vm.addr(expectedSeed);
        vm.assume(expected != address(0));

        bytes32 envelope = _personalHash(keccak256(abi.encode(signerSeed)));
        bytes memory sig = _sign(signerSeed, envelope);

        assertFalse(registry.verify(abi.encodePacked(expected), envelope, sig));
    }
}
