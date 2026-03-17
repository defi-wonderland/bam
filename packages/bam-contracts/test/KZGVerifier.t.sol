// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { KZGVerifier } from "../src/libraries/KZGVerifier.sol";
import { SocialBlobsTypes } from "../src/libraries/SocialBlobsTypes.sol";

/// @title KZGVerifierHarness
/// @notice Test harness to expose internal library functions
contract KZGVerifierHarness {
    function verifyProof(bytes32 versionedHash, SocialBlobsTypes.KZGProof calldata proof)
        external
        view
        returns (bool)
    {
        return KZGVerifier.verifyProof(versionedHash, proof);
    }

    function verifyAndExtract(
        bytes32 versionedHash,
        SocialBlobsTypes.KZGProof[] calldata proofs,
        uint256 byteOffset,
        uint256 byteLength
    ) external view returns (bytes memory) {
        return KZGVerifier.verifyAndExtract(versionedHash, proofs, byteOffset, byteLength);
    }

    function calculateFieldElements(uint256 byteOffset, uint256 byteLength)
        external
        pure
        returns (uint256 startFE, uint256 endFE, uint256 count)
    {
        return KZGVerifier.calculateFieldElements(byteOffset, byteLength);
    }
}

/// @title KZGVerifierTest
/// @notice Tests for KZGVerifier library
contract KZGVerifierTest is Test {
    KZGVerifierHarness public harness;

    bytes32 public constant VERSIONED_HASH =
        0x01a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1;

    // Valid 48-byte KZG commitment (placeholder)
    bytes public validCommitment =
        hex"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";

    // Valid 48-byte KZG proof (placeholder)
    bytes public validProof =
        hex"101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

    function setUp() public {
        harness = new KZGVerifierHarness();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CALCULATE FIELD ELEMENTS TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_calculateFieldElements_singleFE() public view {
        // Single byte at offset 0
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(0, 1);
        assertEq(start, 0, "Start FE should be 0");
        assertEq(end, 0, "End FE should be 0");
        assertEq(count, 1, "Count should be 1");
    }

    function test_calculateFieldElements_wholeFE() public view {
        // 31 bytes starting at offset 0 (fits in one FE)
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(0, 31);
        assertEq(start, 0);
        assertEq(end, 0);
        assertEq(count, 1);
    }

    function test_calculateFieldElements_spansTwoFEs() public view {
        // 32 bytes starting at offset 0 (spans FE 0 and FE 1)
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(0, 32);
        assertEq(start, 0);
        assertEq(end, 1);
        assertEq(count, 2);
    }

    function test_calculateFieldElements_middleOffset() public view {
        // 10 bytes starting at offset 31 (FE 1)
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(31, 10);
        assertEq(start, 1);
        assertEq(end, 1);
        assertEq(count, 1);
    }

    function test_calculateFieldElements_crossesBoundary() public view {
        // 10 bytes starting at offset 25 (crosses from FE 0 to FE 1)
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(25, 10);
        assertEq(start, 0);
        assertEq(end, 1);
        assertEq(count, 2);
    }

    function test_calculateFieldElements_multipleFEs() public view {
        // 100 bytes starting at offset 0 (needs 4 FEs)
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(0, 100);
        assertEq(start, 0);
        assertEq(end, 3);
        assertEq(count, 4);
    }

    function test_calculateFieldElements_largeOffset() public view {
        // Start at byte 1000 (FE 32), length 50 bytes
        (uint256 start, uint256 end, uint256 count) = harness.calculateFieldElements(1000, 50);
        assertEq(start, 32); // 1000 / 31 = 32
        assertEq(end, 33);
        assertEq(count, 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFY AND EXTRACT TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_verifyAndExtract_emptyProofs() public {
        SocialBlobsTypes.KZGProof[] memory proofs = new SocialBlobsTypes.KZGProof[](0);

        vm.expectRevert(KZGVerifier.EmptyProofArray.selector);
        harness.verifyAndExtract(VERSIONED_HASH, proofs, 0, 10);
    }

    function test_verifyAndExtract_invalidByteRange() public {
        SocialBlobsTypes.KZGProof[] memory proofs = new SocialBlobsTypes.KZGProof[](1);
        proofs[0] = SocialBlobsTypes.KZGProof({
            z: 0, y: 0, commitment: validCommitment, proof: validProof
        });

        // Max bytes is 4096 * 31 = 126,976
        uint256 maxBytes = 4096 * 31;
        vm.expectRevert(abi.encodeWithSelector(KZGVerifier.InvalidByteRange.selector, maxBytes, 1));
        harness.verifyAndExtract(VERSIONED_HASH, proofs, maxBytes, 1);
    }

    function test_verifyAndExtract_insufficientProofs() public {
        // Request bytes that span 2 FEs but only provide 1 proof
        SocialBlobsTypes.KZGProof[] memory proofs = new SocialBlobsTypes.KZGProof[](1);
        proofs[0] = SocialBlobsTypes.KZGProof({
            z: 0, y: 0, commitment: validCommitment, proof: validProof
        });

        // 32 bytes needs 2 FEs
        vm.expectRevert(abi.encodeWithSelector(KZGVerifier.InvalidByteRange.selector, 0, 32));
        harness.verifyAndExtract(VERSIONED_HASH, proofs, 0, 32);
    }

    // Note: Full proof verification tests require the point evaluation precompile
    // which is available on Cancun-enabled networks

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFY PROOF TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    // Note: The verifyProof function doesn't validate commitment/proof lengths
    // explicitly - instead the precompile call will fail with incorrect input.
    // These tests verify the precompile failure path.

    function test_verifyProof_invalidCommitment() public view {
        SocialBlobsTypes.KZGProof memory proof = SocialBlobsTypes.KZGProof({
            z: 0,
            y: 0,
            commitment: hex"0102030405", // Too short
            proof: validProof
        });

        // Precompile call will fail (returns false) with invalid input
        bool result = harness.verifyProof(VERSIONED_HASH, proof);
        assertFalse(result, "Invalid commitment should fail verification");
    }

    function test_verifyProof_invalidProof() public view {
        SocialBlobsTypes.KZGProof memory proof = SocialBlobsTypes.KZGProof({
            z: 0,
            y: 0,
            commitment: validCommitment,
            proof: hex"0102030405" // Too short
        });

        // Precompile call will fail (returns false) with invalid input
        bool result = harness.verifyProof(VERSIONED_HASH, proof);
        assertFalse(result, "Invalid proof should fail verification");
    }

    function test_verifyProof_fieldElementOutOfRange() public {
        SocialBlobsTypes.KZGProof memory proof = SocialBlobsTypes.KZGProof({
            z: 5000, // Out of range (max 4095)
            y: 0,
            commitment: validCommitment,
            proof: validProof
        });

        vm.expectRevert(abi.encodeWithSelector(KZGVerifier.FieldElementOutOfRange.selector, 5000));
        harness.verifyProof(VERSIONED_HASH, proof);
    }
}
