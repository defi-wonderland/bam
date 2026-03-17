// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SocialBlobsTypes } from "./SocialBlobsTypes.sol";

/// @title KZGVerifier
/// @notice Library for KZG proof verification using EIP-4844 point evaluation precompile
/// @dev Wraps the point evaluation precompile at address 0x0A
library KZGVerifier {
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Address of the point evaluation precompile (EIP-4844)
    address internal constant POINT_EVALUATION_PRECOMPILE = address(0x0A);

    /// @dev BLS modulus (the field prime for BLS12-381)
    uint256 internal constant BLS_MODULUS =
        52_435_875_175_126_190_479_447_740_508_185_965_837_690_552_500_527_637_822_603_658_699_938_581_184_513;

    /// @dev Number of field elements in a blob (4096)
    uint256 internal constant BLOB_FIELD_ELEMENTS = 4096;

    /// @dev Bytes per field element (32 bytes, but only 31 usable due to BLS modulus)
    uint256 internal constant BYTES_PER_FIELD_ELEMENT = 32;

    /// @dev Expected output from successful precompile call
    bytes32 internal constant EXPECTED_OUTPUT_HASH =
        keccak256(abi.encodePacked(uint256(BLOB_FIELD_ELEMENTS), BLS_MODULUS));

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Thrown when point evaluation precompile call fails
    error PointEvaluationFailed();

    /// @dev Thrown when precompile returns unexpected output
    error UnexpectedPrecompileOutput();

    /// @dev Thrown when proof array is empty
    error EmptyProofArray();

    /// @dev Thrown when byte range is invalid
    error InvalidByteRange(uint256 offset, uint256 length);

    /// @dev Thrown when field element index is out of range
    error FieldElementOutOfRange(uint256 index);

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Verify a single KZG point evaluation proof
    /// @dev Calls the point evaluation precompile (0x0A)
    /// @param versionedHash The blob's versioned hash
    /// @param proof The KZG proof to verify
    /// @return valid True if proof is valid
    function verifyProof(bytes32 versionedHash, SocialBlobsTypes.KZGProof calldata proof)
        internal
        view
        returns (bool valid)
    {
        // Validate field element index
        if (proof.z >= BLOB_FIELD_ELEMENTS) revert FieldElementOutOfRange(proof.z);

        // Encode input for precompile:
        // - versioned_hash: 32 bytes
        // - z: 32 bytes (field element index)
        // - y: 32 bytes (field element value)
        // - commitment: 48 bytes
        // - proof: 48 bytes
        // Total: 192 bytes
        bytes memory input = abi.encodePacked(
            versionedHash, // 32 bytes
            proof.z, // 32 bytes
            proof.y, // 32 bytes
            proof.commitment, // 48 bytes
            proof.proof // 48 bytes
        );

        // Call precompile
        (bool success, bytes memory output) = POINT_EVALUATION_PRECOMPILE.staticcall(input);

        if (!success) return false;

        // Verify output (64 bytes: field_elements_per_blob, bls_modulus)
        if (output.length != 64) revert UnexpectedPrecompileOutput();

        // Verify the output matches expected constants
        bytes32 outputHash = keccak256(output);
        if (outputHash != EXPECTED_OUTPUT_HASH) revert UnexpectedPrecompileOutput();

        return true;
    }

    /// @notice Verify multiple KZG proofs and extract bytes
    /// @dev Verifies all proofs and reconstructs the byte sequence
    /// @param versionedHash The blob's versioned hash
    /// @param proofs Array of KZG proofs (must be in order of field element indices)
    /// @param byteOffset Starting byte offset in the blob
    /// @param byteLength Number of bytes to extract
    /// @return extractedBytes The reconstructed bytes from verified field elements
    function verifyAndExtract(
        bytes32 versionedHash,
        SocialBlobsTypes.KZGProof[] calldata proofs,
        uint256 byteOffset,
        uint256 byteLength
    ) internal view returns (bytes memory extractedBytes) {
        if (proofs.length == 0) revert EmptyProofArray();

        // Validate byte range
        if (byteOffset + byteLength > BLOB_FIELD_ELEMENTS * 31) {
            revert InvalidByteRange(byteOffset, byteLength);
        }

        // Calculate which field elements we need
        uint256 startFE = byteOffset / 31;
        uint256 requiredFEs = ((byteOffset + byteLength - 1) / 31) - startFE + 1;

        // Verify we have enough proofs
        if (proofs.length < requiredFEs) revert InvalidByteRange(byteOffset, byteLength);

        // Verify proofs and collect field element values
        uint256[] memory yValues =
            _verifyProofsAndCollect(versionedHash, proofs, startFE, requiredFEs);

        // Extract bytes from field elements
        return _extractBytes(yValues, byteOffset % 31, byteLength, requiredFEs);
    }

    /// @dev Verify proofs and collect y values
    function _verifyProofsAndCollect(
        bytes32 versionedHash,
        SocialBlobsTypes.KZGProof[] calldata proofs,
        uint256 startFE,
        uint256 requiredFEs
    ) private view returns (uint256[] memory yValues) {
        yValues = new uint256[](requiredFEs);

        for (uint256 i = 0; i < requiredFEs; i++) {
            if (!verifyProof(versionedHash, proofs[i])) revert PointEvaluationFailed();
            if (proofs[i].z != startFE + i) revert FieldElementOutOfRange(proofs[i].z);
            yValues[i] = proofs[i].y;
        }
    }

    /// @dev Extract bytes from field element y values
    function _extractBytes(
        uint256[] memory yValues,
        uint256 srcOffset,
        uint256 byteLength,
        uint256 requiredFEs
    ) private pure returns (bytes memory result) {
        result = new bytes(byteLength);
        uint256 dstOffset;
        uint256 remaining = byteLength;

        for (uint256 fe = 0; fe < requiredFEs && remaining > 0; fe++) {
            uint256 feStart = (fe == 0) ? srcOffset : 0;
            uint256 available = 31 - feStart;
            uint256 toCopy = remaining < available ? remaining : available;

            _copyBytesFromFE(result, dstOffset, yValues[fe], feStart, toCopy);

            dstOffset += toCopy;
            remaining -= toCopy;
        }
    }

    /// @dev Copy bytes from a field element to output buffer
    function _copyBytesFromFE(
        bytes memory output,
        uint256 dstOffset,
        uint256 y,
        uint256 feStartByte,
        uint256 count
    ) private pure {
        // Each FE has 31 usable bytes at positions 1-31 (byte 0 must be 0)
        for (uint256 j = 0; j < count; j++) {
            uint256 bytePos = 30 - feStartByte - j;
            output[dstOffset + j] = bytes1(uint8((y >> (bytePos * 8)) & 0xFF));
        }
    }

    /// @notice Calculate which field elements are needed for a byte range
    /// @param byteOffset Starting byte offset
    /// @param byteLength Number of bytes
    /// @return startFE First field element index
    /// @return endFE Last field element index (inclusive)
    /// @return count Number of field elements needed
    function calculateFieldElements(uint256 byteOffset, uint256 byteLength)
        internal
        pure
        returns (uint256 startFE, uint256 endFE, uint256 count)
    {
        startFE = byteOffset / 31;
        endFE = (byteOffset + byteLength - 1) / 31;
        count = endFE - startFE + 1;
    }
}
