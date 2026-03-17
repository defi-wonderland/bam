// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { BLS12381 } from "./BLS12381.sol";

/// @title BLSDecompression
/// @notice Library for decompressing BLS12-381 G1 and G2 points
/// @dev Implements point decompression with full on-chain validation
/// @custom:security This is cryptographic code - any changes require thorough review
library BLSDecompression {
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Compressed G1 point size (48 bytes)
    uint256 internal constant G1_COMPRESSED_SIZE = 48;

    /// @dev Uncompressed G1 point size (128 bytes = 2 × 64 bytes for x,y coords)
    uint256 internal constant G1_UNCOMPRESSED_SIZE = 128;

    /// @dev Compressed G2 point size (96 bytes)
    uint256 internal constant G2_COMPRESSED_SIZE = 96;

    /// @dev Uncompressed G2 point size (256 bytes = 2 × 128 bytes for x,y coords)
    uint256 internal constant G2_UNCOMPRESSED_SIZE = 256;

    /// @dev Curve parameter b for G1: y² = x³ + 4
    uint256 internal constant B_G1 = 4;

    /// @dev Flag bits in compressed point (bits 383-381 of first byte)
    /// Bit 7 of byte 0: Compression flag (1 = compressed)
    /// Bit 6 of byte 0: Infinity flag (1 = point at infinity)
    /// Bit 5 of byte 0: Sign flag (1 = y is lexicographically larger)
    uint8 internal constant FLAG_COMPRESSED = 0x80;
    uint8 internal constant FLAG_INFINITY = 0x40;
    uint8 internal constant FLAG_SIGN = 0x20;

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Thrown when compressed point has invalid length
    error InvalidPointLength(uint256 expected, uint256 actual);

    /// @dev Thrown when point is not on the curve
    error PointNotOnCurve();

    /// @dev Thrown when compressed point has invalid flags
    error InvalidPointFlags();

    /// @dev Thrown when point coordinates are not in the field
    error CoordinateNotInField();

    // ═══════════════════════════════════════════════════════════════════════════════
    // G1 DECOMPRESSION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Decompress a G1 point from 48 bytes to 128 bytes
    /// @dev Compressed format: [flags (3 bits) | x-coordinate (381 bits)]
    ///      Uncompressed format: [x (64 bytes) | y (64 bytes)]
    /// @param compressed 48-byte compressed G1 point
    /// @return uncompressed 128-byte uncompressed G1 point
    function decompressG1(bytes memory compressed)
        internal
        pure
        returns (bytes memory uncompressed)
    {
        if (compressed.length != G1_COMPRESSED_SIZE) {
            revert InvalidPointLength(G1_COMPRESSED_SIZE, compressed.length);
        }

        // Extract flags from first byte
        uint8 flags = uint8(compressed[0]);

        // Check compression flag is set
        if ((flags & FLAG_COMPRESSED) == 0) revert InvalidPointFlags();

        // Handle point at infinity
        if ((flags & FLAG_INFINITY) != 0) {
            // Point at infinity: return zero point
            // EIP-2537 format: all zeros for point at infinity
            uncompressed = new bytes(G1_UNCOMPRESSED_SIZE);
            return uncompressed;
        }

        // Extract sign bit
        bool ySignBit = (flags & FLAG_SIGN) != 0;

        // Extract x-coordinate (clear flag bits from first byte)
        bytes memory xBytes = new bytes(48);
        xBytes[0] = bytes1(flags & 0x1F); // Clear top 3 flag bits
        for (uint256 i = 1; i < 48; i++) {
            xBytes[i] = compressed[i];
        }

        // Convert to field element (split into high/low for 384-bit arithmetic)
        (uint256 xLow, uint256 xHigh) = _bytesToFp(xBytes);

        // Validate x is in field
        if (!_isInField(xLow, xHigh)) revert CoordinateNotInField();

        // Compute y² = x³ + 4
        (uint256 y2Low, uint256 y2High) = _computeG1RHS(xLow, xHigh);

        // Compute y = sqrt(y²)
        (uint256 yLow, uint256 yHigh, bool exists) = BLS12381.fpSqrt(y2Low, y2High);
        if (!exists) revert PointNotOnCurve();

        // Select correct y based on sign bit
        // The sign bit indicates if y is the lexicographically larger root
        bool yIsLarger = _isLexicographicallyLarger(yLow, yHigh);
        if (ySignBit != yIsLarger) {
            // Negate y to get the other root
            (yLow, yHigh) = BLS12381.fpNeg(yLow, yHigh);
        }

        // Format output: [x (64 bytes big-endian padded) | y (64 bytes big-endian padded)]
        uncompressed = new bytes(G1_UNCOMPRESSED_SIZE);
        _fpToBytes64(xLow, xHigh, uncompressed, 0);
        _fpToBytes64(yLow, yHigh, uncompressed, 64);
    }

    /// @notice Check if a G1 point (uncompressed) is on the curve
    /// @param point 128-byte uncompressed G1 point
    /// @return valid True if point is on curve y² = x³ + 4
    function isOnCurveG1(bytes memory point) internal pure returns (bool valid) {
        if (point.length != G1_UNCOMPRESSED_SIZE) return false;

        // Check for point at infinity (all zeros)
        bool isZero = true;
        for (uint256 i = 0; i < G1_UNCOMPRESSED_SIZE; i++) {
            if (point[i] != 0) {
                isZero = false;
                break;
            }
        }
        if (isZero) return true; // Point at infinity is valid

        // Extract x and y
        (uint256 xLow, uint256 xHigh) = _bytes64ToFp(point, 0);
        (uint256 yLow, uint256 yHigh) = _bytes64ToFp(point, 64);

        // Check coordinates are in field
        if (!_isInField(xLow, xHigh) || !_isInField(yLow, yHigh)) return false;

        // Check y² = x³ + 4
        (uint256 lhsLow, uint256 lhsHigh) = BLS12381.fpSquare(yLow, yHigh);
        (uint256 rhsLow, uint256 rhsHigh) = _computeG1RHS(xLow, xHigh);

        return lhsLow == rhsLow && lhsHigh == rhsHigh;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // G2 DECOMPRESSION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Decompress a G2 point from 96 bytes to 256 bytes
    /// @dev G2 is over Fp2 = Fp[i]/(i² + 1)
    ///      Compressed: [flags (3 bits) | x.c1 (381 bits) | x.c0 (384 bits)]
    ///      where x = x.c0 + x.c1 * i
    /// @param compressed 96-byte compressed G2 point
    /// @return uncompressed 256-byte uncompressed G2 point
    function decompressG2(bytes memory compressed)
        internal
        pure
        returns (bytes memory uncompressed)
    {
        if (compressed.length != G2_COMPRESSED_SIZE) {
            revert InvalidPointLength(G2_COMPRESSED_SIZE, compressed.length);
        }

        // Extract flags from first byte
        uint8 flags = uint8(compressed[0]);

        // Check compression flag is set
        if ((flags & FLAG_COMPRESSED) == 0) revert InvalidPointFlags();

        // Handle point at infinity
        if ((flags & FLAG_INFINITY) != 0) {
            uncompressed = new bytes(G2_UNCOMPRESSED_SIZE);
            return uncompressed;
        }

        // Extract sign bit
        bool ySignBit = (flags & FLAG_SIGN) != 0;

        // Extract x coordinate (Fp2 element)
        // First 48 bytes: x.c1 (imaginary part, with flags in first byte)
        // Next 48 bytes: x.c0 (real part)
        bytes memory x1Bytes = new bytes(48);
        x1Bytes[0] = bytes1(flags & 0x1F); // Clear flag bits
        for (uint256 i = 1; i < 48; i++) {
            x1Bytes[i] = compressed[i];
        }

        bytes memory x0Bytes = new bytes(48);
        for (uint256 i = 0; i < 48; i++) {
            x0Bytes[i] = compressed[48 + i];
        }

        // Convert to Fp2 element
        (uint256 x0Low, uint256 x0High) = _bytesToFp(x0Bytes);
        (uint256 x1Low, uint256 x1High) = _bytesToFp(x1Bytes);

        // Validate coordinates are in field
        if (!_isInField(x0Low, x0High) || !_isInField(x1Low, x1High)) {
            revert CoordinateNotInField();
        }

        // Compute y² = x³ + 4(1 + i) in Fp2
        (uint256 y2_0Low, uint256 y2_0High, uint256 y2_1Low, uint256 y2_1High) =
            _computeG2RHS(x0Low, x0High, x1Low, x1High);

        // Compute y = sqrt(y²) in Fp2
        (uint256 y0Low, uint256 y0High, uint256 y1Low, uint256 y1High, bool exists) =
            _fp2Sqrt(y2_0Low, y2_0High, y2_1Low, y2_1High);

        if (!exists) revert PointNotOnCurve();

        // Select correct y based on sign bit
        // For Fp2, we compare the imaginary part first, then real part
        bool yIsLarger = _fp2IsLexicographicallyLarger(y0Low, y0High, y1Low, y1High);
        if (ySignBit != yIsLarger) {
            // Negate y
            (y0Low, y0High) = BLS12381.fpNeg(y0Low, y0High);
            (y1Low, y1High) = BLS12381.fpNeg(y1Low, y1High);
        }

        // Format output: [x.c0 | x.c1 | y.c0 | y.c1] each 64 bytes
        uncompressed = new bytes(G2_UNCOMPRESSED_SIZE);
        _fpToBytes64(x0Low, x0High, uncompressed, 0);
        _fpToBytes64(x1Low, x1High, uncompressed, 64);
        _fpToBytes64(y0Low, y0High, uncompressed, 128);
        _fpToBytes64(y1Low, y1High, uncompressed, 192);
    }

    /// @notice Check if a G2 point (uncompressed) is on the curve
    /// @param point 256-byte uncompressed G2 point
    /// @return valid True if point is on curve y² = x³ + 4(1+i)
    function isOnCurveG2(bytes memory point) internal pure returns (bool valid) {
        if (point.length != G2_UNCOMPRESSED_SIZE) return false;

        // Check for point at infinity
        bool isZero = true;
        for (uint256 i = 0; i < G2_UNCOMPRESSED_SIZE; i++) {
            if (point[i] != 0) {
                isZero = false;
                break;
            }
        }
        if (isZero) return true;

        // Extract x and y (Fp2 elements)
        (uint256 x0Low, uint256 x0High) = _bytes64ToFp(point, 0);
        (uint256 x1Low, uint256 x1High) = _bytes64ToFp(point, 64);
        (uint256 y0Low, uint256 y0High) = _bytes64ToFp(point, 128);
        (uint256 y1Low, uint256 y1High) = _bytes64ToFp(point, 192);

        // Check coordinates are in field
        if (
            !_isInField(x0Low, x0High) || !_isInField(x1Low, x1High) || !_isInField(y0Low, y0High)
                || !_isInField(y1Low, y1High)
        ) return false;

        // Check y² = x³ + 4(1+i)
        (uint256 lhs0Low, uint256 lhs0High, uint256 lhs1Low, uint256 lhs1High) =
            BLS12381.fp2Square(y0Low, y0High, y1Low, y1High);

        (uint256 rhs0Low, uint256 rhs0High, uint256 rhs1Low, uint256 rhs1High) =
            _computeG2RHS(x0Low, x0High, x1Low, x1High);

        return
            lhs0Low == rhs0Low && lhs0High == rhs0High && lhs1Low == rhs1Low && lhs1High == rhs1High;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Compute x³ + 4 for G1 curve equation
    function _computeG1RHS(uint256 xLow, uint256 xHigh)
        private
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // x²
        (uint256 x2Low, uint256 x2High) = BLS12381.fpSquare(xLow, xHigh);
        // x³
        (uint256 x3Low, uint256 x3High) = BLS12381.fpMul(x2Low, x2High, xLow, xHigh);
        // x³ + 4
        (rLow, rHigh) = BLS12381.fpAdd(x3Low, x3High, B_G1, 0);
    }

    /// @dev Compute x³ + 4(1+i) for G2 curve equation
    function _computeG2RHS(uint256 x0Low, uint256 x0High, uint256 x1Low, uint256 x1High)
        private
        pure
        returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High)
    {
        // x²
        (uint256 x2_0Low, uint256 x2_0High, uint256 x2_1Low, uint256 x2_1High) =
            BLS12381.fp2Square(x0Low, x0High, x1Low, x1High);

        // x³
        (uint256 x3_0Low, uint256 x3_0High, uint256 x3_1Low, uint256 x3_1High) =
            BLS12381.fp2Mul(x2_0Low, x2_0High, x2_1Low, x2_1High, x0Low, x0High, x1Low, x1High);

        // b = 4(1 + i) = 4 + 4i
        // x³ + b
        (r0Low, r0High) = BLS12381.fpAdd(x3_0Low, x3_0High, 4, 0);
        (r1Low, r1High) = BLS12381.fpAdd(x3_1Low, x3_1High, 4, 0);
    }

    /// @dev Compute square root in Fp2
    function _fp2Sqrt(uint256 a0Low, uint256 a0High, uint256 a1Low, uint256 a1High)
        private
        pure
        returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High, bool exists)
    {
        // Square root in Fp2 using the formula from:
        // https://eprint.iacr.org/2012/685.pdf (Algorithm 9)

        // If imaginary part is zero, try sqrt of real part
        if (a1Low == 0 && a1High == 0) {
            (r0Low, r0High, exists) = BLS12381.fpSqrt(a0Low, a0High);
            if (exists) {
                r1Low = 0;
                r1High = 0;
                return (r0Low, r0High, r1Low, r1High, true);
            }
            // If no sqrt in Fp, try sqrt(-a0) and put in imaginary
            (uint256 negA0Low, uint256 negA0High) = BLS12381.fpNeg(a0Low, a0High);
            (r1Low, r1High, exists) = BLS12381.fpSqrt(negA0Low, negA0High);
            if (exists) {
                r0Low = 0;
                r0High = 0;
                return (r0Low, r0High, r1Low, r1High, true);
            }
            return (0, 0, 0, 0, false);
        }

        // General case: a = a0 + a1*i with a1 != 0
        // norm = a0² + a1²
        (uint256 a0SqLow, uint256 a0SqHigh) = BLS12381.fpSquare(a0Low, a0High);
        (uint256 a1SqLow, uint256 a1SqHigh) = BLS12381.fpSquare(a1Low, a1High);
        (uint256 normLow, uint256 normHigh) = BLS12381.fpAdd(a0SqLow, a0SqHigh, a1SqLow, a1SqHigh);

        // alpha = sqrt(norm) (in Fp)
        (uint256 alphaLow, uint256 alphaHigh, bool alphaExists) = BLS12381.fpSqrt(normLow, normHigh);
        if (!alphaExists) return (0, 0, 0, 0, false);

        // delta = (a0 + alpha) / 2
        (uint256 sumLow, uint256 sumHigh) = BLS12381.fpAdd(a0Low, a0High, alphaLow, alphaHigh);
        // Divide by 2: multiply by inverse of 2
        // inv(2) mod p can be precomputed, but for simplicity we use: (p+1)/2
        (uint256 deltaLow, uint256 deltaHigh) = _fpDivBy2(sumLow, sumHigh);

        // Try x0 = sqrt(delta)
        (uint256 x0Low, uint256 x0High, bool x0Exists) = BLS12381.fpSqrt(deltaLow, deltaHigh);

        if (!x0Exists) {
            // Try delta = (a0 - alpha) / 2
            (sumLow, sumHigh) = BLS12381.fpSub(a0Low, a0High, alphaLow, alphaHigh);
            (deltaLow, deltaHigh) = _fpDivBy2(sumLow, sumHigh);
            (x0Low, x0High, x0Exists) = BLS12381.fpSqrt(deltaLow, deltaHigh);

            if (!x0Exists) return (0, 0, 0, 0, false);
        }

        // x1 = a1 / (2 * x0)
        (uint256 twoX0Low, uint256 twoX0High) = BLS12381.fpAdd(x0Low, x0High, x0Low, x0High);
        (uint256 twoX0InvLow, uint256 twoX0InvHigh) = BLS12381.fpInv(twoX0Low, twoX0High);
        (uint256 x1Low, uint256 x1High) = BLS12381.fpMul(a1Low, a1High, twoX0InvLow, twoX0InvHigh);

        // Verify: (x0 + x1*i)² = a
        (uint256 v0Low, uint256 v0High, uint256 v1Low, uint256 v1High) =
            BLS12381.fp2Square(x0Low, x0High, x1Low, x1High);

        if (v0Low == a0Low && v0High == a0High && v1Low == a1Low && v1High == a1High) {
            return (x0Low, x0High, x1Low, x1High, true);
        }

        return (0, 0, 0, 0, false);
    }

    /// @dev Divide Fp element by 2
    function _fpDivBy2(uint256 aLow, uint256 aHigh)
        private
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // If a is even, simple right shift
        // If a is odd, (a + p) / 2
        if (aLow & 1 == 0) {
            // Even: right shift
            rLow = (aLow >> 1) | (aHigh << 255);
            rHigh = aHigh >> 1;
        } else {
            // Odd: add p then right shift
            (uint256 sumLow, uint256 sumHigh) =
                BLS12381.fpAdd(aLow, aHigh, BLS12381.getPrimeLow(), BLS12381.getPrimeHigh());
            rLow = (sumLow >> 1) | (sumHigh << 255);
            rHigh = sumHigh >> 1;
        }
    }

    /// @dev Check if field element is less than p
    function _isInField(uint256 low, uint256 high) private pure returns (bool) {
        if (high > BLS12381.getPrimeHigh()) return false;
        if (high < BLS12381.getPrimeHigh()) return true;
        return low < BLS12381.getPrimeLow();
    }

    /// @dev Check if y is the lexicographically larger root
    /// @dev Lexicographically larger means y > (p-1)/2
    function _isLexicographicallyLarger(uint256 yLow, uint256 yHigh) private pure returns (bool) {
        // (p-1)/2 as threshold
        // For p odd, y > (p-1)/2 iff y > p/2 iff 2y > p
        (uint256 twoYLow, uint256 twoYHigh) = BLS12381.fpAdd(yLow, yHigh, yLow, yHigh);

        // Check if 2y >= p (which means y > (p-1)/2)
        if (twoYHigh > BLS12381.getPrimeHigh()) return true;
        if (twoYHigh < BLS12381.getPrimeHigh()) return false;
        return twoYLow >= BLS12381.getPrimeLow();
    }

    /// @dev Check if Fp2 element y is lexicographically larger
    /// @dev Compare imaginary part first, then real part
    function _fp2IsLexicographicallyLarger(
        uint256 y0Low,
        uint256 y0High,
        uint256 y1Low,
        uint256 y1High
    ) private pure returns (bool) {
        // If imaginary part is non-zero, compare it
        if (y1Low != 0 || y1High != 0) return _isLexicographicallyLarger(y1Low, y1High);
        // Otherwise compare real part
        return _isLexicographicallyLarger(y0Low, y0High);
    }

    /// @dev Convert 48-byte big-endian to Fp element (low, high)
    function _bytesToFp(bytes memory b) private pure returns (uint256 low, uint256 high) {
        require(b.length == 48, "Invalid length");

        // First 16 bytes -> high (bits 256-383, but only 125 bits used)
        // Last 32 bytes -> low (bits 0-255)
        high = 0;
        for (uint256 i = 0; i < 16; i++) {
            high = (high << 8) | uint8(b[i]);
        }

        low = 0;
        for (uint256 i = 16; i < 48; i++) {
            low = (low << 8) | uint8(b[i]);
        }
    }

    /// @dev Convert 64-byte big-endian (EIP-2537 format) to Fp element
    function _bytes64ToFp(bytes memory b, uint256 offset)
        private
        pure
        returns (uint256 low, uint256 high)
    {
        // EIP-2537 format: 64 bytes big-endian, top 16 bytes are padding
        // Bytes 0-15: padding (should be zero)
        // Bytes 16-63: 48-byte field element

        // High part: bytes 16-31 (16 bytes = 128 bits, but only ~125 used)
        high = 0;
        for (uint256 i = 0; i < 16; i++) {
            high = (high << 8) | uint8(b[offset + 16 + i]);
        }

        // Low part: bytes 32-63 (32 bytes = 256 bits)
        low = 0;
        for (uint256 i = 0; i < 32; i++) {
            low = (low << 8) | uint8(b[offset + 32 + i]);
        }
    }

    /// @dev Convert Fp element to 64-byte big-endian (EIP-2537 format)
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
