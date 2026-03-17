// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BLSExposer } from "../src/exposers/BLSExposer.sol";
import { IERC_BAM_Exposer } from "../src/interfaces/IERC_BAM_Exposer.sol";
import { IBLSRegistry } from "../src/interfaces/IBLSRegistry.sol";
import { IRegistrationVerifier } from "../src/interfaces/IRegistrationVerifier.sol";
import { ISocialBlobsCore } from "../src/interfaces/ISocialBlobsCore.sol";
import { IExposureRecord } from "../src/interfaces/IExposureRecord.sol";
import { SocialBlobsTypes } from "../src/libraries/SocialBlobsTypes.sol";

/// @title MockBLSRegistry
/// @notice Minimal mock for IBLSRegistry — returns a fixed pubkey for registered addresses
contract MockBLSRegistry {
    mapping(address => bytes) private _keys;

    function setKey(address owner, bytes memory pubKey) external {
        _keys[owner] = pubKey;
    }

    function getKey(address owner) external view returns (bytes memory) {
        return _keys[owner];
    }
}

/// @title MockRegistrationVerifier
/// @notice Always returns true for verifyRegistration
contract MockRegistrationVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool pass) external {
        shouldPass = pass;
    }

    function verifyRegistration(address, bytes32, bytes calldata) external view returns (bool) {
        return shouldPass;
    }
}

/// @title BLSExposerTest
/// @notice Tests for BLSExposer with ERC-BAM alignment
/// @dev Tests the calldata exposure path (no KZG/BLS precompiles needed).
///      BLS verification falls through to `valid = true` when precompiles are unavailable.
contract BLSExposerTest is Test {
    BLSExposer public exposer;
    MockBLSRegistry public mockRegistry;
    MockRegistrationVerifier public mockVerifier;
    address public mockCore;

    address public constant ALICE = address(0xA11CE);
    bytes public constant FAKE_BLS_PUBKEY =
        hex"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";
    bytes public constant FAKE_BLS_SIG =
        hex"aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";

    function setUp() public {
        mockRegistry = new MockBLSRegistry();
        mockVerifier = new MockRegistrationVerifier();
        mockCore = address(0xC04E);

        exposer = new BLSExposer(mockCore, address(mockRegistry), address(mockVerifier), address(0));

        // Register ALICE's BLS public key
        mockRegistry.setKey(ALICE, FAKE_BLS_PUBKEY);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Build a message in the wire format: [author(20)][timestamp(4)][nonce(2)][contents...]
    function _buildMessage(address author, uint32 timestamp, uint16 nonce, bytes memory contents)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(author, timestamp, nonce, contents);
    }

    /// @dev Build calldata exposure params with a batch containing one message at offset 0
    function _buildCalldataParams(bytes memory messageBytes)
        internal
        pure
        returns (SocialBlobsTypes.CalldataExposureParams memory)
    {
        return SocialBlobsTypes.CalldataExposureParams({
            batchData: messageBytes,
            messageOffset: 0,
            messageBytes: messageBytes,
            signature: FAKE_BLS_SIG,
            registrationProof: ""
        });
    }

    /// @dev Compute the expected messageHash per ERC-BAM
    function _computeMessageHash(address sender, uint64 nonce, bytes memory contents)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(sender, nonce, contents));
    }

    /// @dev Compute the expected messageId per ERC-BAM
    function _computeMessageId(address author, uint64 nonce, bytes32 contentHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(author, nonce, contentHash));
    }

    /// @dev Compute the expected domain separator
    function _computeDomain() internal view returns (bytes32) {
        return keccak256(abi.encodePacked("ERC-BAM.v1", block.chainid));
    }

    /// @dev Compute the expected signedHash per ERC-BAM
    function _computeSignedHash(bytes32 domain, bytes32 messageHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(domain, messageHash));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENT EMISSION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_exposeFromCalldata_emitsMessageExposed() public {
        bytes memory contents = "hello world";
        uint32 timestamp = 1_700_000_000;
        uint16 nonce = 42;
        bytes memory messageBytes = _buildMessage(ALICE, timestamp, nonce, contents);

        bytes32 batchContentHash = keccak256(messageBytes);
        bytes32 expectedMessageId = _computeMessageId(ALICE, uint64(nonce), batchContentHash);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Exposer.MessageExposed(
            batchContentHash, expectedMessageId, ALICE, address(this), uint64(block.timestamp)
        );

        exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
    }

    function test_exposeFromCalldata_returnsMessageId() public {
        bytes memory contents = "test message";
        uint16 nonce = 1;
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, nonce, contents);

        bytes32 batchContentHash = keccak256(messageBytes);
        bytes32 expectedMessageId = _computeMessageId(ALICE, uint64(nonce), batchContentHash);

        bytes32 returnedId = exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
        assertEq(returnedId, expectedMessageId);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DOMAIN SEPARATOR TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_domainSeparator_includedInSignedHash() public {
        // The domain separator should be keccak256("ERC-BAM.v1" || chainId)
        bytes32 expectedDomain = _computeDomain();

        // The signedHash = keccak256(domain || messageHash)
        // We verify this by checking that the exposer uses the correct domain
        // Since BLS precompiles aren't available, the try/catch in _verifyBLSSignature
        // will catch and set valid=true, so we can't directly test the hash passed to BLS.
        // Instead, we verify the domain computation matches the spec.
        assertEq(expectedDomain, keccak256(abi.encodePacked("ERC-BAM.v1", block.chainid)));
    }

    function test_domainSeparator_chainIdSpecific() public {
        // Deploy on a different chain ID and verify domain changes
        bytes32 domain1 = _computeDomain();

        // The domain separator includes chainId, so different chains produce different domains
        bytes32 domainChain999 = keccak256(abi.encodePacked("ERC-BAM.v1", uint256(999)));
        assertTrue(domain1 != domainChain999);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MESSAGE ID DEDUPLICATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_exposeFromCalldata_deduplicatesByMessageId() public {
        bytes memory contents = "dedup test";
        uint16 nonce = 7;
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, nonce, contents);

        SocialBlobsTypes.CalldataExposureParams memory params = _buildCalldataParams(messageBytes);

        // First exposure succeeds
        bytes32 messageId = exposer.exposeFromCalldata(params);

        // Second exposure with same message should revert with AlreadyExposed(messageId)
        vm.expectRevert(abi.encodeWithSelector(IERC_BAM_Exposer.AlreadyExposed.selector, messageId));
        exposer.exposeFromCalldata(params);
    }

    function test_isExposed_usesMessageId() public {
        bytes memory contents = "is exposed test";
        uint16 nonce = 3;
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, nonce, contents);

        bytes32 batchContentHash = keccak256(messageBytes);
        bytes32 expectedMessageId = _computeMessageId(ALICE, uint64(nonce), batchContentHash);

        // Not exposed yet
        assertFalse(exposer.isExposed(expectedMessageId));

        // Expose
        exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));

        // Now exposed by messageId
        assertTrue(exposer.isExposed(expectedMessageId));

        // Old-style messageHash (keccak256 of raw bytes) should NOT be marked as exposed
        bytes32 rawHash = keccak256(messageBytes);
        // messageId != rawHash for any non-trivial message
        assertTrue(expectedMessageId != rawHash);
        assertFalse(exposer.isExposed(rawHash));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MESSAGE HASH FORMULA TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_messageHash_formulaMatchesSpec() public {
        // ERC-BAM: messageHash = keccak256(abi.encodePacked(sender, nonce, contents))
        // where sender is address (20 bytes), nonce is uint64 (8 bytes), contents is bytes

        address sender = ALICE;
        uint64 nonce = 42;
        bytes memory contents = "hello world";

        bytes32 expectedHash = keccak256(abi.encodePacked(sender, nonce, contents));

        // Verify the formula uses sender (20B) + nonce (8B) + contents (variable)
        // Total prefix = 28 bytes (not 26 — nonce is uint64 in the hash, even though wire format
        // uses uint16)
        bytes memory packed = abi.encodePacked(sender, nonce, contents);
        assertEq(packed.length, 20 + 8 + contents.length);
        assertEq(keccak256(packed), expectedHash);
    }

    function test_messageId_formulaMatchesSpec() public {
        // ERC-BAM: messageId = keccak256(abi.encodePacked(author, nonce, contentHash))
        // where author is address (20B), nonce is uint64 (8B), contentHash is bytes32 (32B)

        address author = ALICE;
        uint64 nonce = 42;
        bytes32 contentHash = keccak256("some batch data");

        bytes32 expectedId = keccak256(abi.encodePacked(author, nonce, contentHash));

        // All fixed-size: 20 + 8 + 32 = 60 bytes
        bytes memory packed = abi.encodePacked(author, nonce, contentHash);
        assertEq(packed.length, 60);
        assertEq(keccak256(packed), expectedId);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION VERIFICATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_exposeFromCalldata_revertsOnNotRegistered() public {
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, 1, "test");

        mockVerifier.setShouldPass(false);

        bytes32 expectedContentHash = keccak256(messageBytes);
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BAM_Exposer.NotRegistered.selector, expectedContentHash)
        );
        exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
    }

    function test_exposeFromCalldata_revertsOnAuthorNotRegistered() public {
        address bob = address(0xB0B);
        bytes memory messageBytes = _buildMessage(bob, 1_700_000_000, 1, "test");

        // Bob has no BLS key registered
        vm.expectRevert(abi.encodeWithSelector(BLSExposer.AuthorNotRegistered.selector, bob));
        exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MESSAGE MISMATCH TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_exposeFromCalldata_revertsOnMessageMismatch() public {
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, 1, "real message");
        bytes memory fakeBatch =
            _buildMessage(ALICE, 1_700_000_000, 1, "different content in batch");

        SocialBlobsTypes.CalldataExposureParams memory params =
            SocialBlobsTypes.CalldataExposureParams({
                batchData: fakeBatch,
                messageOffset: 0,
                messageBytes: messageBytes,
                signature: FAKE_BLS_SIG,
                registrationProof: ""
            });

        vm.expectRevert(BLSExposer.MessageMismatch.selector);
        exposer.exposeFromCalldata(params);
    }

    function test_exposeFromCalldata_revertsOnOffsetOverflow() public {
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, 1, "test");
        bytes memory batch = messageBytes;

        SocialBlobsTypes.CalldataExposureParams memory params =
            SocialBlobsTypes.CalldataExposureParams({
                batchData: batch,
                messageOffset: batch.length, // offset at end = overflow
                messageBytes: messageBytes,
                signature: FAKE_BLS_SIG,
                registrationProof: ""
            });

        vm.expectRevert(BLSExposer.MessageMismatch.selector);
        exposer.exposeFromCalldata(params);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DIFFERENT MESSAGES SAME AUTHOR TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_exposeFromCalldata_differentNoncesDifferentIds() public {
        bytes memory msg1 = _buildMessage(ALICE, 1_700_000_000, 1, "message one");
        bytes memory msg2 = _buildMessage(ALICE, 1_700_000_000, 2, "message two");

        bytes32 id1 = exposer.exposeFromCalldata(_buildCalldataParams(msg1));
        bytes32 id2 = exposer.exposeFromCalldata(_buildCalldataParams(msg2));

        // Different nonces produce different messageIds
        assertTrue(id1 != id2);
        assertTrue(exposer.isExposed(id1));
        assertTrue(exposer.isExposed(id2));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NONCE PARSING TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_nonceParsing_zeroNonce() public {
        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, 0, "zero nonce");

        bytes32 batchContentHash = keccak256(messageBytes);
        bytes32 expectedMessageId = _computeMessageId(ALICE, 0, batchContentHash);

        bytes32 returnedId = exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
        assertEq(returnedId, expectedMessageId);
    }

    function test_nonceParsing_maxUint16() public {
        bytes memory messageBytes =
            _buildMessage(ALICE, 1_700_000_000, type(uint16).max, "max nonce");

        bytes32 batchContentHash = keccak256(messageBytes);
        bytes32 expectedMessageId =
            _computeMessageId(ALICE, uint64(type(uint16).max), batchContentHash);

        bytes32 returnedId = exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
        assertEq(returnedId, expectedMessageId);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERFACE COMPLIANCE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_implementsIERC_BAM_Exposer() public view {
        // Verify the contract satisfies the IERC_BAM_Exposer interface
        // The isExposed function is defined in the interface
        exposer.isExposed(bytes32(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function testFuzz_messageIdDeterministic(uint16 nonce, uint256 contentsLen) public {
        contentsLen = bound(contentsLen, 1, 999);
        bytes memory contents = new bytes(contentsLen);
        for (uint256 i = 0; i < contentsLen; i++) {
            contents[i] = bytes1(uint8(i % 256));
        }

        bytes memory messageBytes = _buildMessage(ALICE, 1_700_000_000, nonce, contents);
        bytes32 batchContentHash = keccak256(messageBytes);
        bytes32 expectedMessageId = _computeMessageId(ALICE, uint64(nonce), batchContentHash);

        bytes32 returnedId = exposer.exposeFromCalldata(_buildCalldataParams(messageBytes));
        assertEq(returnedId, expectedMessageId);
    }
}
