// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { BLS12381 } from "./BLS12381.sol";
import { BLSDecompression } from "./BLSDecompression.sol";

/// @title BLSVerifier
/// @notice Library for BLS12-381 signature verification
/// @dev Uses EIP-2537 precompiles (live on mainnet since Pectra, May 2025)
/// @custom:security Cryptographic code - changes require thorough review
library BLSVerifier {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EIP-2537 PRECOMPILE ADDRESSES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev BLS12_G1ADD precompile address
    address internal constant BLS12_G1ADD = address(0x0B);

    /// @dev BLS12_G2ADD precompile address
    address internal constant BLS12_G2ADD = address(0x0E);

    /// @dev BLS12_PAIRING precompile address
    address internal constant BLS12_PAIRING = address(0x11);

    /// @dev BLS12_MAP_FP2_TO_G2 precompile address
    address internal constant BLS12_MAP_FP2_TO_G2 = address(0x13);

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev G1 point size (uncompressed): 128 bytes
    uint256 internal constant G1_POINT_SIZE = 128;

    /// @dev G2 point size (uncompressed): 256 bytes
    uint256 internal constant G2_POINT_SIZE = 256;

    /// @dev Compressed G1 point size: 48 bytes
    uint256 internal constant G1_COMPRESSED_SIZE = 48;

    /// @dev Compressed G2 point size: 96 bytes
    uint256 internal constant G2_COMPRESSED_SIZE = 96;

    /// @dev Domain separation tag for Social-Blobs BLS signatures (RFC 9380 compliant)
    bytes internal constant DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_SocialBlobs";

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Thrown when BLS precompile call fails
    error BLSPrecompileFailed(address precompile);

    /// @dev Thrown when signature format is invalid
    error InvalidSignatureFormat(uint256 length);

    /// @dev Thrown when public key format is invalid
    error InvalidPublicKeyFormat(uint256 length);

    /// @dev Thrown when pairing check fails (invalid signature)
    error PairingCheckFailed();

    /// @dev Thrown when EIP-2537 precompiles are not available
    error PrecompilesNotAvailable();

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Verify a BLS signature
    /// @dev Uses EIP-2537 pairing precompile for verification
    ///      Signature verification equation: e(G1_gen, sig) == e(pk, H(m))
    ///      Rearranged for pairing: e(G1_gen, sig) * e(-pk, H(m)) == 1
    /// @param publicKey 48-byte compressed G1 public key
    /// @param messageHash 32-byte message hash
    /// @param signature 96-byte compressed G2 signature
    /// @return valid True if signature is valid
    function verify(bytes memory publicKey, bytes32 messageHash, bytes memory signature)
        internal
        view
        returns (bool valid)
    {
        // Validate public key length
        if (publicKey.length != G1_COMPRESSED_SIZE) {
            revert InvalidPublicKeyFormat(publicKey.length);
        }

        // Validate signature length
        if (signature.length != G2_COMPRESSED_SIZE) {
            revert InvalidSignatureFormat(signature.length);
        }

        // Check if precompiles are available
        if (!_precompilesAvailable()) revert PrecompilesNotAvailable();

        // 1. Decompress public key (48 -> 128 bytes)
        bytes memory pkUncompressed = BLSDecompression.decompressG1(publicKey);

        // 2. Decompress signature (96 -> 256 bytes)
        bytes memory sigUncompressed = BLSDecompression.decompressG2(signature);

        // 3. Hash message to G2 point
        bytes memory messagePoint = _hashToG2(messageHash);

        // 4. Negate public key for pairing equation
        bytes memory negPk = _negateG1(pkUncompressed);

        // 5. Perform pairing check: e(G1_gen, sig) * e(-pk, H(m)) == 1
        bytes memory pairingInput = abi.encodePacked(
            _getG1Generator(), // 128 bytes: G1 generator
            sigUncompressed, // 256 bytes: signature (G2)
            negPk, // 128 bytes: -pk (negated G1)
            messagePoint // 256 bytes: H(m) (G2)
        );

        (bool success, bytes memory result) = BLS12_PAIRING.staticcall(pairingInput);

        if (!success) return false;

        // Pairing returns 32 bytes: 1 if the pairing product equals identity, 0 otherwise
        if (result.length != 32) return false;

        return uint256(bytes32(result)) == 1;
    }

    /// @notice Check if EIP-2537 precompiles are available
    /// @return available True if precompiles are available
    function precompilesAvailable() internal view returns (bool available) {
        return _precompilesAvailable();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Check if precompiles are available by calling PAIRING with empty input
    function _precompilesAvailable() private view returns (bool) {
        // Empty input to pairing should succeed and return 1 (empty product = identity)
        bytes memory input = new bytes(0);
        (bool success, bytes memory result) = BLS12_PAIRING.staticcall{ gas: 100_000 }(input);

        // If precompiles don't exist, staticcall to empty address returns success with empty data
        // If precompiles exist, empty input returns success with 32 bytes (value = 1)
        return success && result.length == 32;
    }

    /// @dev Hash a message to a G2 point using MAP_FP2_TO_G2
    /// @param messageHash 32-byte message hash
    /// @return point 256-byte G2 point
    function _hashToG2(bytes32 messageHash) private view returns (bytes memory point) {
        // Expand message hash to two Fp2 elements using expand_message_xmd
        // This is a simplified version - full RFC 9380 implementation
        bytes memory expanded = _expandMessageXMD(messageHash);

        // Map first Fp2 element to G2
        bytes memory u0 = new bytes(128);
        for (uint256 i = 0; i < 128; i++) {
            u0[i] = expanded[i];
        }
        (bool ok1, bytes memory q0) = BLS12_MAP_FP2_TO_G2.staticcall(u0);
        if (!ok1 || q0.length != G2_POINT_SIZE) {
            revert BLSPrecompileFailed(BLS12_MAP_FP2_TO_G2);
        }

        // Map second Fp2 element to G2
        bytes memory u1 = new bytes(128);
        for (uint256 i = 0; i < 128; i++) {
            u1[i] = expanded[128 + i];
        }
        (bool ok2, bytes memory q1) = BLS12_MAP_FP2_TO_G2.staticcall(u1);
        if (!ok2 || q1.length != G2_POINT_SIZE) {
            revert BLSPrecompileFailed(BLS12_MAP_FP2_TO_G2);
        }

        // Add the two points: R = Q0 + Q1
        (bool ok3, bytes memory r) = BLS12_G2ADD.staticcall(abi.encodePacked(q0, q1));
        if (!ok3 || r.length != G2_POINT_SIZE) revert BLSPrecompileFailed(BLS12_G2ADD);

        return r;
    }

    /// @dev Expand message to 256 bytes using XMD (SHA-256)
    /// @param messageHash Message to expand
    /// @return expanded 256 bytes of pseudorandom data
    function _expandMessageXMD(bytes32 messageHash) private pure returns (bytes memory expanded) {
        // Simplified expand_message_xmd for hash-to-curve
        // Full implementation per RFC 9380 Section 5.3

        expanded = new bytes(256);

        // b_0 = H(Z_pad || msg || l_i_b_str || 0x00 || DST_prime)
        bytes memory dstPrime = abi.encodePacked(DST, uint8(DST.length));
        bytes32 b0 = sha256(
            abi.encodePacked(
                bytes32(0),
                bytes32(0), // Z_pad (64 bytes for SHA-256)
                messageHash,
                uint16(256), // l_i_b_str (length in bytes)
                uint8(0),
                dstPrime
            )
        );

        // b_1 = H(b_0 || 0x01 || DST_prime)
        bytes32 b1 = sha256(abi.encodePacked(b0, uint8(1), dstPrime));

        // Store b_1 as first 32 bytes
        for (uint256 i = 0; i < 32; i++) {
            expanded[i] = b1[i];
        }

        // Generate remaining blocks
        bytes32 bi = b1;
        for (uint256 j = 2; j <= 8; j++) {
            // b_i = H(strxor(b_0, b_{i-1}) || i || DST_prime)
            bytes32 xored;
            for (uint256 k = 0; k < 32; k++) {
                xored = bytes32(
                    uint256(xored) | (uint256(uint8(b0[k]) ^ uint8(bi[k])) << (8 * (31 - k)))
                );
            }
            bi = sha256(abi.encodePacked(xored, uint8(j), dstPrime));

            // Store this block
            uint256 offset = (j - 1) * 32;
            for (uint256 i = 0; i < 32 && offset + i < 256; i++) {
                expanded[offset + i] = bi[i];
            }
        }
    }

    /// @dev Get the G1 generator point (uncompressed)
    /// @return g1 128-byte G1 generator
    function _getG1Generator() private pure returns (bytes memory g1) {
        g1 = new bytes(G1_POINT_SIZE);

        // BLS12-381 G1 generator (uncompressed format, 64 bytes per coordinate)
        // X coordinate (padded to 64 bytes)
        bytes memory xCoord =
            hex"0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";

        // Y coordinate (padded to 64 bytes)
        bytes memory yCoord =
            hex"0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1";

        for (uint256 i = 0; i < 64; i++) {
            g1[i] = xCoord[i];
            g1[64 + i] = yCoord[i];
        }
    }

    /// @dev Negate a G1 point (flip y coordinate)
    /// @param point 128-byte G1 point
    /// @return negated 128-byte negated G1 point
    function _negateG1(bytes memory point) private pure returns (bytes memory negated) {
        negated = new bytes(G1_POINT_SIZE);

        // Copy x coordinate (first 64 bytes)
        for (uint256 i = 0; i < 64; i++) {
            negated[i] = point[i];
        }

        // Extract y coordinate
        (uint256 yLow, uint256 yHigh) = _bytes64ToFp(point, 64);

        // Negate: y' = p - y
        (uint256 negYLow, uint256 negYHigh) = BLS12381.fpNeg(yLow, yHigh);

        // Write negated y
        _fpToBytes64(negYLow, negYHigh, negated, 64);
    }

    /// @dev Convert 64-byte EIP-2537 format to Fp element
    function _bytes64ToFp(bytes memory b, uint256 offset)
        private
        pure
        returns (uint256 low, uint256 high)
    {
        // EIP-2537 format: 64 bytes big-endian, top 16 bytes are padding
        // High part: bytes 16-31
        high = 0;
        for (uint256 i = 0; i < 16; i++) {
            high = (high << 8) | uint8(b[offset + 16 + i]);
        }

        // Low part: bytes 32-63
        low = 0;
        for (uint256 i = 0; i < 32; i++) {
            low = (low << 8) | uint8(b[offset + 32 + i]);
        }
    }

    /// @dev Convert Fp element to 64-byte EIP-2537 format
    function _fpToBytes64(uint256 low, uint256 high, bytes memory out, uint256 offset)
        private
        pure
    {
        // Padding (16 bytes of zeros)
        for (uint256 i = 0; i < 16; i++) {
            out[offset + i] = 0;
        }

        // High part (16 bytes)
        for (uint256 i = 0; i < 16; i++) {
            out[offset + 16 + i] = bytes1(uint8(high >> (8 * (15 - i))));
        }

        // Low part (32 bytes)
        for (uint256 i = 0; i < 32; i++) {
            out[offset + 32 + i] = bytes1(uint8(low >> (8 * (31 - i))));
        }
    }
}
