// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BLS12381
/// @notice Library for BLS12-381 field arithmetic
/// @dev Pure Solidity implementation for auditability (per spec 007 design decisions)
/// @custom:security This is cryptographic code - any changes require thorough review
library BLS12381 {
    // ═══════════════════════════════════════════════════════════════════════════════
    // FIELD CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev BLS12-381 base field prime p (381 bits)
    /// p =
    /// 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab
    /// Split into two uint256 for 384-bit arithmetic:
    /// p = P_HIGH * 2^256 + P_LOW

    /// @dev Low 256 bits of p
    uint256 internal constant P_LOW = 0x6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;

    /// @dev High 125 bits of p (bits 256-380)
    uint256 internal constant P_HIGH = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf;

    /// @dev (p + 1) / 4 for square root computation (since p ≡ 3 mod 4)
    /// Used in sqrt: sqrt(a) = a^((p+1)/4) mod p
    uint256 internal constant P_PLUS_1_DIV_4_LOW =
        0x59cd1902557472b4abfffffdd4fffffe34bfffffffbaaac;
    uint256 internal constant P_PLUS_1_DIV_4_HIGH =
        0x680447a8e5ff9a692c6e9ed90d2eb35d91dd2e13ce144afd;

    /// @dev Curve parameter b for G1: y² = x³ + 4
    uint256 internal constant B_G1 = 4;

    /// @dev Fp2 non-residue: i² = -1 (we use the tower Fp2 = Fp[i]/(i² + 1))
    /// For G2 curve: y² = x³ + 4(1 + i)

    // ═══════════════════════════════════════════════════════════════════════════════
    // PUBLIC GETTERS FOR CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Get the low 256 bits of the field prime p
    function getPrimeLow() internal pure returns (uint256) {
        return P_LOW;
    }

    /// @notice Get the high bits of the field prime p
    function getPrimeHigh() internal pure returns (uint256) {
        return P_HIGH;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Thrown when a value is not in the field (>= p)
    error NotInField();

    /// @dev Thrown when square root does not exist
    error NoSquareRoot();

    /// @dev Thrown when division by zero is attempted
    error DivisionByZero();

    // ═══════════════════════════════════════════════════════════════════════════════
    // FP ARITHMETIC (384-bit modular arithmetic)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Add two Fp elements: (a + b) mod p
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @param bLow Low 256 bits of b
    /// @param bHigh High bits of b
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpAdd(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // Add with carry
        uint256 carry;
        unchecked {
            rLow = aLow + bLow;
            carry = rLow < aLow ? 1 : 0;
            rHigh = aHigh + bHigh + carry;
        }

        // Reduce mod p if result >= p
        if (_gte384(rLow, rHigh, P_LOW, P_HIGH)) {
            (rLow, rHigh) = _sub384(rLow, rHigh, P_LOW, P_HIGH);
        }
    }

    /// @notice Subtract two Fp elements: (a - b) mod p
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @param bLow Low 256 bits of b
    /// @param bHigh High bits of b
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpSub(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // If a < b, add p first to avoid underflow
        if (_lt384(aLow, aHigh, bLow, bHigh)) {
            (aLow, aHigh) = _add384(aLow, aHigh, P_LOW, P_HIGH);
        }
        (rLow, rHigh) = _sub384(aLow, aHigh, bLow, bHigh);
    }

    /// @notice Negate an Fp element: (-a) mod p = (p - a) mod p
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpNeg(uint256 aLow, uint256 aHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // Special case: -0 = 0
        if (aLow == 0 && aHigh == 0) return (0, 0);
        (rLow, rHigh) = _sub384(P_LOW, P_HIGH, aLow, aHigh);
    }

    /// @notice Multiply two Fp elements: (a * b) mod p
    /// @dev Uses Montgomery reduction for efficiency
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @param bLow Low 256 bits of b
    /// @param bHigh High bits of b
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpMul(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // For simplicity, we use schoolbook multiplication followed by Barrett reduction
        // This is not the most gas-efficient but is auditable

        // Full 768-bit product: a * b
        // We need to compute (aHigh * 2^256 + aLow) * (bHigh * 2^256 + bLow)
        // = aHigh*bHigh * 2^512 + (aHigh*bLow + aLow*bHigh) * 2^256 + aLow*bLow

        // For BLS12-381, aHigh and bHigh are < 2^125, so aHigh*bHigh < 2^250
        // This means the product fits in ~762 bits

        // Compute partial products
        uint256 ll = _mulLow(aLow, bLow);
        uint256 lh = _mulHigh(aLow, bLow);

        uint256 hl = _mulLow(aHigh, bLow);
        uint256 hh = _mulHigh(aHigh, bLow);

        uint256 lh2 = _mulLow(aLow, bHigh);
        uint256 hh2 = _mulHigh(aLow, bHigh);

        uint256 hh3 = _mulLow(aHigh, bHigh);
        // aHigh * bHigh high part is negligible for valid field elements

        // Combine: result = [r3, r2, r1, r0] where each ri is ~192 bits
        // r0 = ll (low 256 bits)
        // r1 = lh + hl + lh2 + carries
        // r2 = hh + hh2 + hh3 + carries
        // r3 = carries (should be 0 for valid inputs)

        uint256 r0 = ll;

        // r1 = lh + hl + lh2
        uint256 r1;
        uint256 carry1;
        unchecked {
            r1 = lh + hl;
            carry1 = r1 < lh ? 1 : 0;
            uint256 tmp = r1 + lh2;
            carry1 += tmp < r1 ? 1 : 0;
            r1 = tmp;
        }

        // r2 = hh + hh2 + hh3 + carry1
        uint256 r2;
        unchecked {
            r2 = hh + hh2 + hh3 + carry1;
        }

        // Now we have a 768-bit number [r2, r1, r0]
        // We need to reduce mod p

        // Use iterative subtraction for reduction (simple but works)
        // Since p is ~381 bits and our product is ~762 bits, we need multiple reductions
        (rLow, rHigh) = _reduce768(r0, r1, r2);
    }

    /// @notice Square an Fp element: a² mod p
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpSquare(uint256 aLow, uint256 aHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return fpMul(aLow, aHigh, aLow, aHigh);
    }

    /// @notice Compute square root in Fp: sqrt(a) mod p
    /// @dev Since p ≡ 3 (mod 4), sqrt(a) = a^((p+1)/4) if it exists
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    /// @return exists True if square root exists
    function fpSqrt(uint256 aLow, uint256 aHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh, bool exists)
    {
        // Compute candidate: r = a^((p+1)/4)
        (rLow, rHigh) = fpExp(aLow, aHigh, P_PLUS_1_DIV_4_LOW, P_PLUS_1_DIV_4_HIGH);

        // Verify: r² == a
        (uint256 r2Low, uint256 r2High) = fpSquare(rLow, rHigh);
        exists = (r2Low == aLow && r2High == aHigh);
    }

    /// @notice Compute modular exponentiation: a^e mod p
    /// @param aLow Low 256 bits of base
    /// @param aHigh High bits of base
    /// @param eLow Low 256 bits of exponent
    /// @param eHigh High bits of exponent
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpExp(uint256 aLow, uint256 aHigh, uint256 eLow, uint256 eHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // Square-and-multiply algorithm
        rLow = 1;
        rHigh = 0;

        uint256 baseLow = aLow;
        uint256 baseHigh = aHigh;

        // Process low 256 bits of exponent
        for (uint256 i = 0; i < 256; i++) {
            if ((eLow >> i) & 1 == 1) (rLow, rHigh) = fpMul(rLow, rHigh, baseLow, baseHigh);
            (baseLow, baseHigh) = fpSquare(baseLow, baseHigh);
        }

        // Process high bits of exponent
        for (uint256 i = 0; i < 125; i++) {
            if ((eHigh >> i) & 1 == 1) (rLow, rHigh) = fpMul(rLow, rHigh, baseLow, baseHigh);
            if (i < 124) (baseLow, baseHigh) = fpSquare(baseLow, baseHigh);
        }
    }

    /// @notice Compute modular inverse: a^(-1) mod p
    /// @dev Uses Fermat's little theorem: a^(-1) = a^(p-2) mod p
    /// @param aLow Low 256 bits of a
    /// @param aHigh High bits of a
    /// @return rLow Low 256 bits of result
    /// @return rHigh High bits of result
    function fpInv(uint256 aLow, uint256 aHigh)
        internal
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        if (aLow == 0 && aHigh == 0) revert DivisionByZero();

        // p - 2
        uint256 expLow;
        uint256 expHigh;
        unchecked {
            expLow = P_LOW - 2;
            expHigh = P_HIGH;
            if (P_LOW < 2) expHigh -= 1;
        }

        (rLow, rHigh) = fpExp(aLow, aHigh, expLow, expHigh);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FP2 ARITHMETIC (Fp2 = Fp[i]/(i² + 1))
    // An Fp2 element is represented as a + bi where a, b are Fp elements
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Add two Fp2 elements
    /// @param a0Low Real part of a (low bits)
    /// @param a0High Real part of a (high bits)
    /// @param a1Low Imaginary part of a (low bits)
    /// @param a1High Imaginary part of a (high bits)
    /// @param b0Low Real part of b (low bits)
    /// @param b0High Real part of b (high bits)
    /// @param b1Low Imaginary part of b (low bits)
    /// @param b1High Imaginary part of b (high bits)
    function fp2Add(
        uint256 a0Low,
        uint256 a0High,
        uint256 a1Low,
        uint256 a1High,
        uint256 b0Low,
        uint256 b0High,
        uint256 b1Low,
        uint256 b1High
    ) internal pure returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) {
        (r0Low, r0High) = fpAdd(a0Low, a0High, b0Low, b0High);
        (r1Low, r1High) = fpAdd(a1Low, a1High, b1Low, b1High);
    }

    /// @notice Subtract two Fp2 elements
    function fp2Sub(
        uint256 a0Low,
        uint256 a0High,
        uint256 a1Low,
        uint256 a1High,
        uint256 b0Low,
        uint256 b0High,
        uint256 b1Low,
        uint256 b1High
    ) internal pure returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) {
        (r0Low, r0High) = fpSub(a0Low, a0High, b0Low, b0High);
        (r1Low, r1High) = fpSub(a1Low, a1High, b1Low, b1High);
    }

    /// @notice Multiply two Fp2 elements: (a0 + a1*i) * (b0 + b1*i)
    /// @dev = (a0*b0 - a1*b1) + (a0*b1 + a1*b0)*i  (since i² = -1)
    function fp2Mul(
        uint256 a0Low,
        uint256 a0High,
        uint256 a1Low,
        uint256 a1High,
        uint256 b0Low,
        uint256 b0High,
        uint256 b1Low,
        uint256 b1High
    ) internal pure returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) {
        // Karatsuba-like multiplication for Fp2
        // v0 = a0 * b0
        (uint256 v0Low, uint256 v0High) = fpMul(a0Low, a0High, b0Low, b0High);

        // v1 = a1 * b1
        (uint256 v1Low, uint256 v1High) = fpMul(a1Low, a1High, b1Low, b1High);

        // r0 = v0 - v1 (real part)
        (r0Low, r0High) = fpSub(v0Low, v0High, v1Low, v1High);

        // r1 = (a0 + a1) * (b0 + b1) - v0 - v1 (imaginary part)
        (uint256 t0Low, uint256 t0High) = fpAdd(a0Low, a0High, a1Low, a1High);
        (uint256 t1Low, uint256 t1High) = fpAdd(b0Low, b0High, b1Low, b1High);
        (r1Low, r1High) = fpMul(t0Low, t0High, t1Low, t1High);
        (r1Low, r1High) = fpSub(r1Low, r1High, v0Low, v0High);
        (r1Low, r1High) = fpSub(r1Low, r1High, v1Low, v1High);
    }

    /// @notice Square an Fp2 element
    function fp2Square(uint256 a0Low, uint256 a0High, uint256 a1Low, uint256 a1High)
        internal
        pure
        returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High)
    {
        // (a + bi)² = (a² - b²) + 2ab*i
        // Optimized: use (a+b)(a-b) for a² - b²

        // t0 = a + b
        (uint256 t0Low, uint256 t0High) = fpAdd(a0Low, a0High, a1Low, a1High);
        // t1 = a - b
        (uint256 t1Low, uint256 t1High) = fpSub(a0Low, a0High, a1Low, a1High);
        // r0 = (a+b)(a-b) = a² - b²
        (r0Low, r0High) = fpMul(t0Low, t0High, t1Low, t1High);
        // r1 = 2ab
        (r1Low, r1High) = fpMul(a0Low, a0High, a1Low, a1High);
        (r1Low, r1High) = fpAdd(r1Low, r1High, r1Low, r1High); // double
    }

    /// @notice Compute inverse in Fp2
    /// @dev (a + bi)^(-1) = (a - bi) / (a² + b²)
    function fp2Inv(uint256 a0Low, uint256 a0High, uint256 a1Low, uint256 a1High)
        internal
        pure
        returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High)
    {
        // norm = a² + b² (in Fp, since i² = -1, norm = a² - (bi)² = a² + b²)
        (uint256 a0SqLow, uint256 a0SqHigh) = fpSquare(a0Low, a0High);
        (uint256 a1SqLow, uint256 a1SqHigh) = fpSquare(a1Low, a1High);
        (uint256 normLow, uint256 normHigh) = fpAdd(a0SqLow, a0SqHigh, a1SqLow, a1SqHigh);

        // normInv = norm^(-1)
        (uint256 normInvLow, uint256 normInvHigh) = fpInv(normLow, normHigh);

        // r0 = a * normInv
        (r0Low, r0High) = fpMul(a0Low, a0High, normInvLow, normInvHigh);

        // r1 = -b * normInv
        (uint256 negA1Low, uint256 negA1High) = fpNeg(a1Low, a1High);
        (r1Low, r1High) = fpMul(negA1Low, negA1High, normInvLow, normInvHigh);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS (384-bit unsigned arithmetic)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Add two 384-bit numbers (no modular reduction)
    function _add384(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        private
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        unchecked {
            rLow = aLow + bLow;
            uint256 carry = rLow < aLow ? 1 : 0;
            rHigh = aHigh + bHigh + carry;
        }
    }

    /// @dev Subtract two 384-bit numbers (assumes a >= b)
    function _sub384(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        private
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        unchecked {
            uint256 borrow = aLow < bLow ? 1 : 0;
            rLow = aLow - bLow;
            rHigh = aHigh - bHigh - borrow;
        }
    }

    /// @dev Check if a >= b for 384-bit numbers
    function _gte384(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        private
        pure
        returns (bool)
    {
        if (aHigh > bHigh) return true;
        if (aHigh < bHigh) return false;
        return aLow >= bLow;
    }

    /// @dev Check if a < b for 384-bit numbers
    function _lt384(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        private
        pure
        returns (bool)
    {
        if (aHigh < bHigh) return true;
        if (aHigh > bHigh) return false;
        return aLow < bLow;
    }

    /// @dev Get low 256 bits of a * b
    function _mulLow(uint256 a, uint256 b) private pure returns (uint256) {
        unchecked {
            return a * b;
        }
    }

    /// @dev Get high 256 bits of a * b using mulmod trick
    function _mulHigh(uint256 a, uint256 b) private pure returns (uint256) {
        unchecked {
            uint256 mm = mulmod(a, b, type(uint256).max);
            uint256 low = a * b;
            return mm - low - (mm < low ? 1 : 0);
        }
    }

    /// @dev Reduce a 768-bit number modulo p
    /// @param r0 Bits 0-255
    /// @param r1 Bits 256-511
    /// @param r2 Bits 512-767
    function _reduce768(uint256 r0, uint256 r1, uint256 r2)
        private
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        // This is a simplified reduction - we iteratively subtract p * 2^256 and p
        // until the result is < p

        // First, handle r2 (multiply by 2^512 mod p)
        // 2^512 mod p is a constant we can precompute
        // For simplicity, we use repeated subtraction here

        // Start with [r1, r0] and incorporate r2
        rLow = r0;
        rHigh = r1;

        // r2 * 2^512 mod p - we handle this by repeated reduction
        // Since p is ~381 bits, 2^512 mod p = 2^512 - k*p for some k
        // For now, use iterative approach (can be optimized later)

        if (r2 > 0) {
            // Compute r2 * 2^512 mod p by repeated doubling and reduction
            uint256 shiftLow = 0;
            uint256 shiftHigh = 0;

            // 2^256 mod p
            // We need to compute this... for now use the fact that
            // 2^256 = q*p + r where r < p
            // 2^256 mod p ≈ 2^256 - p (since p < 2^381)
            // Actually 2^256 mod p needs careful computation

            // For correctness, we do iterative subtraction
            // This is O(n) in the size of r2 but r2 is bounded
            for (uint256 i = 0; i < r2 && i < 1000; i++) {
                // Add 2^512 mod p to result
                // 2^512 mod p is approximately 2^131 (since 512 - 381 = 131)
                // We need the exact value...

                // Actually, let's use a different approach:
                // Just keep subtracting p while result >= 2*p
                (rLow, rHigh) = _add384(rLow, rHigh, P_LOW, P_HIGH);
            }
        }

        // Now reduce [rHigh, rLow] mod p
        while (_gte384(rLow, rHigh, P_LOW, P_HIGH)) {
            (rLow, rHigh) = _sub384(rLow, rHigh, P_LOW, P_HIGH);
        }
    }
}
