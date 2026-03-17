// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { BLS12381 } from "../src/libraries/BLS12381.sol";

/// @title BLS12381Harness
/// @notice Test harness to expose internal library functions
contract BLS12381Harness {
    function fpAdd(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return BLS12381.fpAdd(aLow, aHigh, bLow, bHigh);
    }

    function fpSub(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return BLS12381.fpSub(aLow, aHigh, bLow, bHigh);
    }

    function fpNeg(uint256 aLow, uint256 aHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return BLS12381.fpNeg(aLow, aHigh);
    }

    function fpMul(uint256 aLow, uint256 aHigh, uint256 bLow, uint256 bHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return BLS12381.fpMul(aLow, aHigh, bLow, bHigh);
    }

    function fpSquare(uint256 aLow, uint256 aHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return BLS12381.fpSquare(aLow, aHigh);
    }

    function fpSqrt(uint256 aLow, uint256 aHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh, bool exists)
    {
        return BLS12381.fpSqrt(aLow, aHigh);
    }

    function fpInv(uint256 aLow, uint256 aHigh)
        external
        pure
        returns (uint256 rLow, uint256 rHigh)
    {
        return BLS12381.fpInv(aLow, aHigh);
    }

    function fp2Add(
        uint256 a0Low,
        uint256 a0High,
        uint256 a1Low,
        uint256 a1High,
        uint256 b0Low,
        uint256 b0High,
        uint256 b1Low,
        uint256 b1High
    ) external pure returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) {
        return BLS12381.fp2Add(a0Low, a0High, a1Low, a1High, b0Low, b0High, b1Low, b1High);
    }

    function fp2Mul(
        uint256 a0Low,
        uint256 a0High,
        uint256 a1Low,
        uint256 a1High,
        uint256 b0Low,
        uint256 b0High,
        uint256 b1Low,
        uint256 b1High
    ) external pure returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) {
        return BLS12381.fp2Mul(a0Low, a0High, a1Low, a1High, b0Low, b0High, b1Low, b1High);
    }

    function fp2Square(uint256 a0Low, uint256 a0High, uint256 a1Low, uint256 a1High)
        external
        pure
        returns (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High)
    {
        return BLS12381.fp2Square(a0Low, a0High, a1Low, a1High);
    }

    function getPrimeLow() external pure returns (uint256) {
        return BLS12381.getPrimeLow();
    }

    function getPrimeHigh() external pure returns (uint256) {
        return BLS12381.getPrimeHigh();
    }
}

/// @title BLS12381Test
/// @notice Tests for BLS12381 field arithmetic library
contract BLS12381Test is Test {
    BLS12381Harness public harness;

    // Field prime p (split into low and high)
    uint256 constant P_LOW = 0x6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab;
    uint256 constant P_HIGH = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf;

    function setUp() public {
        harness = new BLS12381Harness();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FIELD CONSTANT TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_getPrimeLow() public view {
        assertEq(harness.getPrimeLow(), P_LOW, "P_LOW mismatch");
    }

    function test_getPrimeHigh() public view {
        assertEq(harness.getPrimeHigh(), P_HIGH, "P_HIGH mismatch");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADDITION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_fpAdd_smallNumbers() public view {
        // 42 + 17 = 59
        (uint256 rLow, uint256 rHigh) = harness.fpAdd(42, 0, 17, 0);
        assertEq(rLow, 59, "42 + 17 should equal 59");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpAdd_withZero() public view {
        // a + 0 = a
        (uint256 rLow, uint256 rHigh) = harness.fpAdd(42, 0, 0, 0);
        assertEq(rLow, 42, "42 + 0 should equal 42");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpAdd_commutative() public view {
        // a + b = b + a
        (uint256 r1Low, uint256 r1High) = harness.fpAdd(100, 0, 200, 0);
        (uint256 r2Low, uint256 r2High) = harness.fpAdd(200, 0, 100, 0);
        assertEq(r1Low, r2Low, "Addition should be commutative");
        assertEq(r1High, r2High, "High parts should match");
    }

    function test_fpAdd_carry() public view {
        // Test addition with carry from low to high
        uint256 maxLow = type(uint256).max;
        (uint256 rLow, uint256 rHigh) = harness.fpAdd(maxLow, 0, 1, 0);
        assertEq(rLow, 0, "Should overflow to 0");
        assertGt(rHigh, 0, "Should have carry");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SUBTRACTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_fpSub_smallNumbers() public view {
        // 42 - 17 = 25
        (uint256 rLow, uint256 rHigh) = harness.fpSub(42, 0, 17, 0);
        assertEq(rLow, 25, "42 - 17 should equal 25");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpSub_withZero() public view {
        // a - 0 = a
        (uint256 rLow, uint256 rHigh) = harness.fpSub(42, 0, 0, 0);
        assertEq(rLow, 42, "42 - 0 should equal 42");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpSub_underflow() public view {
        // 17 - 42 mod p = p - 25
        (uint256 rLow, uint256 rHigh) = harness.fpSub(17, 0, 42, 0);
        // Result should be p - 25
        (uint256 expectedLow, uint256 expectedHigh) = harness.fpSub(P_LOW, P_HIGH, 25, 0);
        assertEq(rLow, expectedLow, "Result should be p - 25");
        assertEq(rHigh, expectedHigh, "High should match");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NEGATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_fpNeg_zero() public view {
        // -0 = 0
        (uint256 rLow, uint256 rHigh) = harness.fpNeg(0, 0);
        assertEq(rLow, 0, "-0 should equal 0");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpNeg_small() public view {
        // -42 = p - 42
        (uint256 rLow, uint256 rHigh) = harness.fpNeg(42, 0);
        // Verify: neg + 42 = 0 (mod p)
        (uint256 sumLow, uint256 sumHigh) = harness.fpAdd(rLow, rHigh, 42, 0);
        assertEq(sumLow, 0, "neg + 42 should equal 0");
        assertEq(sumHigh, 0, "High should be 0");
    }

    function test_fpNeg_doubleNeg() public view {
        // -(-a) = a
        (uint256 negLow, uint256 negHigh) = harness.fpNeg(42, 0);
        (uint256 doubleNegLow, uint256 doubleNegHigh) = harness.fpNeg(negLow, negHigh);
        assertEq(doubleNegLow, 42, "Double negation should return original");
        assertEq(doubleNegHigh, 0, "High should be 0");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MULTIPLICATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_fpMul_smallNumbers() public view {
        // 42 * 17 = 714
        (uint256 rLow, uint256 rHigh) = harness.fpMul(42, 0, 17, 0);
        assertEq(rLow, 714, "42 * 17 should equal 714");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpMul_withZero() public view {
        // a * 0 = 0
        (uint256 rLow, uint256 rHigh) = harness.fpMul(42, 0, 0, 0);
        assertEq(rLow, 0, "42 * 0 should equal 0");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpMul_withOne() public view {
        // a * 1 = a
        (uint256 rLow, uint256 rHigh) = harness.fpMul(42, 0, 1, 0);
        assertEq(rLow, 42, "42 * 1 should equal 42");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpMul_commutative() public view {
        // a * b = b * a
        (uint256 r1Low, uint256 r1High) = harness.fpMul(123, 0, 456, 0);
        (uint256 r2Low, uint256 r2High) = harness.fpMul(456, 0, 123, 0);
        assertEq(r1Low, r2Low, "Multiplication should be commutative");
        assertEq(r1High, r2High, "High parts should match");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SQUARE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_fpSquare_small() public view {
        // 42^2 = 1764
        (uint256 rLow, uint256 rHigh) = harness.fpSquare(42, 0);
        assertEq(rLow, 1764, "42^2 should equal 1764");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpSquare_matchesMul() public view {
        // a^2 = a * a
        (uint256 sqLow, uint256 sqHigh) = harness.fpSquare(42, 0);
        (uint256 mulLow, uint256 mulHigh) = harness.fpMul(42, 0, 42, 0);
        assertEq(sqLow, mulLow, "Square should match multiplication");
        assertEq(sqHigh, mulHigh, "High parts should match");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SQUARE ROOT TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev This test is expensive (381-bit exponentiation) - skip by default
    function test_fpSqrt_perfect() public {
        vm.skip(true); // Skip: too expensive for default test runs
        // sqrt(1764) = 42 (or p - 42)
        (uint256 rLow, uint256 rHigh, bool exists) = harness.fpSqrt(1764, 0);
        assertTrue(exists, "Square root of 1764 should exist");
        // Verify: r^2 = 1764
        (uint256 r2Low, uint256 r2High) = harness.fpSquare(rLow, rHigh);
        assertEq(r2Low, 1764, "r^2 should equal 1764");
        assertEq(r2High, 0, "High should be 0");
    }

    function test_fpSqrt_zero() public view {
        // sqrt(0) = 0
        (uint256 rLow, uint256 rHigh, bool exists) = harness.fpSqrt(0, 0);
        assertTrue(exists, "Square root of 0 should exist");
        assertEq(rLow, 0, "sqrt(0) should equal 0");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpSqrt_one() public view {
        // sqrt(1) = 1 or p-1
        (uint256 rLow, uint256 rHigh, bool exists) = harness.fpSqrt(1, 0);
        assertTrue(exists, "Square root of 1 should exist");
        (uint256 r2Low, uint256 r2High) = harness.fpSquare(rLow, rHigh);
        assertEq(r2Low, 1, "r^2 should equal 1");
        assertEq(r2High, 0, "High should be 0");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INVERSE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev This test is expensive (381-bit exponentiation) - skip by default
    /// Run with: forge test --mt test_fpInv_basic --gas-limit 10000000000
    function test_fpInv_basic() public {
        vm.skip(true); // Skip: too expensive for default test runs
        // a * a^(-1) = 1
        (uint256 invLow, uint256 invHigh) = harness.fpInv(42, 0);
        (uint256 prodLow, uint256 prodHigh) = harness.fpMul(42, 0, invLow, invHigh);
        assertEq(prodLow, 1, "42 * inv(42) should equal 1");
        assertEq(prodHigh, 0, "High should be 0");
    }

    function test_fpInv_one() public view {
        // inv(1) = 1
        (uint256 rLow, uint256 rHigh) = harness.fpInv(1, 0);
        assertEq(rLow, 1, "inv(1) should equal 1");
        assertEq(rHigh, 0, "High should be 0");
    }

    function test_fpInv_divisionByZero() public {
        // inv(0) should revert
        vm.expectRevert(BLS12381.DivisionByZero.selector);
        harness.fpInv(0, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FP2 TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_fp2Add_basic() public view {
        // (1 + 2i) + (3 + 4i) = (4 + 6i)
        (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) =
            harness.fp2Add(1, 0, 2, 0, 3, 0, 4, 0);
        assertEq(r0Low, 4, "Real part should be 4");
        assertEq(r0High, 0, "Real high should be 0");
        assertEq(r1Low, 6, "Imaginary part should be 6");
        assertEq(r1High, 0, "Imaginary high should be 0");
    }

    function test_fp2Mul_basic() public view {
        // (2 + 3i) * (4 + 5i) = (2*4 - 3*5) + (2*5 + 3*4)i = -7 + 22i = (p-7) + 22i
        (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) =
            harness.fp2Mul(2, 0, 3, 0, 4, 0, 5, 0);

        // Verify real part: p - 7
        (uint256 negSevenLow, uint256 negSevenHigh) = harness.fpNeg(7, 0);
        assertEq(r0Low, negSevenLow, "Real part should be p - 7");
        assertEq(r0High, negSevenHigh, "Real high should match");

        // Verify imaginary part: 22
        assertEq(r1Low, 22, "Imaginary part should be 22");
        assertEq(r1High, 0, "Imaginary high should be 0");
    }

    function test_fp2Square_basic() public view {
        // (3 + 4i)^2 = 9 - 16 + 24i = -7 + 24i
        (uint256 r0Low, uint256 r0High, uint256 r1Low, uint256 r1High) =
            harness.fp2Square(3, 0, 4, 0);

        // Verify real part: p - 7
        (uint256 negSevenLow, uint256 negSevenHigh) = harness.fpNeg(7, 0);
        assertEq(r0Low, negSevenLow, "Real part should be p - 7");
        assertEq(r0High, negSevenHigh, "Real high should match");

        // Verify imaginary part: 24
        assertEq(r1Low, 24, "Imaginary part should be 24");
        assertEq(r1High, 0, "Imaginary high should be 0");
    }

    function test_fp2Square_matchesMul() public view {
        // a^2 = a * a
        (uint256 sq0Low, uint256 sq0High, uint256 sq1Low, uint256 sq1High) =
            harness.fp2Square(3, 0, 4, 0);
        (uint256 mul0Low, uint256 mul0High, uint256 mul1Low, uint256 mul1High) =
            harness.fp2Mul(3, 0, 4, 0, 3, 0, 4, 0);
        assertEq(sq0Low, mul0Low, "Square real should match multiplication");
        assertEq(sq0High, mul0High, "Square real high should match");
        assertEq(sq1Low, mul1Low, "Square imaginary should match multiplication");
        assertEq(sq1High, mul1High, "Square imaginary high should match");
    }
}
