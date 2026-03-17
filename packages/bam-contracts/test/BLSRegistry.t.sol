// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BLSRegistry } from "../src/core/BLSRegistry.sol";
import { IBLSRegistry } from "../src/interfaces/IBLSRegistry.sol";
import { IERC_BAM_SignatureRegistry } from "../src/interfaces/IERC_BAM_SignatureRegistry.sol";

/// @title BLSRegistryTest
/// @notice Tests for BLSRegistry contract
contract BLSRegistryTest is Test {
    BLSRegistry public registry;

    address public alice = address(0x1);
    address public bob = address(0x2);

    // Valid 48-byte BLS public key (placeholder - not cryptographically valid)
    bytes public validPubKey =
        hex"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";

    bytes public anotherPubKey =
        hex"112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00";

    // Placeholder 96-byte signature (won't pass real BLS verification)
    bytes public validSignature =
        hex"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";

    function setUp() public {
        registry = new BLSRegistry();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_register_invalidPubKeyLength() public {
        bytes memory shortKey = hex"0102030405";

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidPublicKey.selector);
        registry.register(shortKey, validSignature);
    }

    function test_register_zeroPubKey() public {
        bytes memory zeroKey = new bytes(48);

        vm.prank(alice);
        vm.expectRevert(IERC_BAM_SignatureRegistry.InvalidPublicKey.selector);
        registry.register(zeroKey, validSignature);
    }

    function test_register_invalidSignatureLength() public {
        bytes memory shortSig = hex"0102030405";

        vm.prank(alice);
        // This will fail at BLS verification with wrong signature length
        vm.expectRevert();
        registry.register(validPubKey, shortSig);
    }

    // Note: Full registration test would require valid BLS signatures
    // which need EIP-2537 precompiles or mock setup

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERY TESTS (for unregistered addresses)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_getKey_unregistered() public view {
        bytes memory key = registry.getKey(alice);
        assertEq(key.length, 0, "Unregistered address should return empty key");
    }

    function test_getIndex_unregistered() public view {
        uint256 index = registry.getIndex(alice);
        assertEq(index, 0, "Unregistered address should have index 0");
    }

    function test_isRegistered_unregistered() public view {
        bool registered = registry.isRegistered(alice);
        assertFalse(registered, "Unregistered address should return false");
    }

    function test_totalRegistered_initial() public view {
        uint256 count = registry.totalRegistered();
        assertEq(count, 0, "Initial count should be 0");
    }

    function test_getKeyByIndex_invalidIndex() public {
        vm.expectRevert(abi.encodeWithSelector(IBLSRegistry.InvalidIndex.selector, 0));
        registry.getKeyByIndex(0);

        vm.expectRevert(abi.encodeWithSelector(IBLSRegistry.InvalidIndex.selector, 1));
        registry.getKeyByIndex(1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REVOKE TESTS (for unregistered addresses)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_revoke_unregistered() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BAM_SignatureRegistry.NotRegistered.selector, alice)
        );
        registry.revoke();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ROTATE TESTS (for unregistered addresses)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_rotate_unregistered() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BAM_SignatureRegistry.NotRegistered.selector, alice)
        );
        registry.rotate(anotherPubKey, validSignature);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ISignatureRegistry INTERFACE COMPLIANCE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_schemeId_returnsBLS() public view {
        uint8 id = registry.schemeId();
        assertEq(id, 0x02, "Scheme ID should be 0x02 for BLS12-381");
    }

    function test_schemeName_returnsBLS12381() public view {
        string memory name = registry.schemeName();
        assertEq(name, "BLS12-381", "Scheme name should be BLS12-381");
    }

    function test_pubKeySize_returns48() public view {
        uint256 size = registry.pubKeySize();
        assertEq(size, 48, "BLS public key size should be 48 bytes");
    }

    function test_signatureSize_returns96() public view {
        uint256 size = registry.signatureSize();
        assertEq(size, 96, "BLS signature size should be 96 bytes");
    }

    function test_supportsAggregation_returnsFalse() public view {
        bool supported = registry.supportsAggregation();
        assertFalse(supported, "BLS aggregation not yet supported");
    }

    function test_verify_invalidSignatureLength() public {
        bytes memory shortSig = hex"0102030405";

        vm.expectRevert();
        registry.verify(validPubKey, bytes32(0), shortSig);
    }

    function test_verifyWithRegisteredKey_unregisteredOwner() public {
        // Unregistered owner should revert with NotRegistered (per ERC-BAM spec)
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BAM_SignatureRegistry.NotRegistered.selector, alice)
        );
        registry.verifyWithRegisteredKey(alice, bytes32(0), validSignature);
    }

    function test_verifyAggregated_reverts() public {
        bytes[] memory pubKeys = new bytes[](1);
        pubKeys[0] = validPubKey;

        bytes32[] memory messageHashes = new bytes32[](1);
        messageHashes[0] = bytes32(0);

        vm.expectRevert(BLSRegistry.AggregationNotSupported.selector);
        registry.verifyAggregated(pubKeys, messageHashes, validSignature);
    }

    function test_verifyAggregated_revertsOnEmptyArrays() public {
        bytes[] memory pubKeys = new bytes[](0);
        bytes32[] memory messageHashes = new bytes32[](0);

        vm.expectRevert(BLSRegistry.AggregationNotSupported.selector);
        registry.verifyAggregated(pubKeys, messageHashes, validSignature);
    }

    function test_verifyAggregated_revertsOnLengthMismatch() public {
        bytes[] memory pubKeys = new bytes[](2);
        pubKeys[0] = validPubKey;
        pubKeys[1] = anotherPubKey;

        bytes32[] memory messageHashes = new bytes32[](1);
        messageHashes[0] = bytes32(0);

        vm.expectRevert(BLSRegistry.AggregationNotSupported.selector);
        registry.verifyAggregated(pubKeys, messageHashes, validSignature);
    }
}
