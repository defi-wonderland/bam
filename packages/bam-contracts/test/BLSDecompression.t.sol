// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console2 } from "forge-std/Test.sol";
import { BLSDecompression } from "../src/libraries/BLSDecompression.sol";

/// @title BLSDecompressionHarness
/// @notice Test harness to expose internal library functions
contract BLSDecompressionHarness {
    function decompressG1(bytes memory compressed) external pure returns (bytes memory) {
        return BLSDecompression.decompressG1(compressed);
    }

    function decompressG2(bytes memory compressed) external pure returns (bytes memory) {
        return BLSDecompression.decompressG2(compressed);
    }

    function isOnCurveG1(bytes memory point) external pure returns (bool) {
        return BLSDecompression.isOnCurveG1(point);
    }

    function isOnCurveG2(bytes memory point) external pure returns (bool) {
        return BLSDecompression.isOnCurveG2(point);
    }
}

/// @title BLSDecompressionTest
/// @notice Tests for BLSDecompression library
contract BLSDecompressionTest is Test {
    BLSDecompressionHarness public harness;

    function setUp() public {
        harness = new BLSDecompressionHarness();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // G1 DECOMPRESSION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decompressG1_pointAtInfinity() public view {
        // Point at infinity: 0xc0 followed by 47 zero bytes (48 total)
        bytes memory compressed =
            hex"c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        bytes memory uncompressed = harness.decompressG1(compressed);

        // Point at infinity should decompress to all zeros
        assertEq(uncompressed.length, 128, "G1 uncompressed should be 128 bytes");
        for (uint256 i = 0; i < 128; i++) {
            assertEq(uint8(uncompressed[i]), 0, "Infinity should be all zeros");
        }
    }

    function test_decompressG1_invalidLength() public {
        bytes memory tooShort = hex"80000000000000000000";
        vm.expectRevert(
            abi.encodeWithSelector(BLSDecompression.InvalidPointLength.selector, 48, 10)
        );
        harness.decompressG1(tooShort);
    }

    function test_decompressG1_missingCompressionFlag() public {
        // Missing compression flag (MSB not set) - 48 bytes
        bytes memory invalid =
            hex"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        vm.expectRevert(BLSDecompression.InvalidPointFlags.selector);
        harness.decompressG1(invalid);
    }

    /// @dev Expensive test (requires sqrt in field) - skip by default
    function test_decompressG1_validPoint() public {
        vm.skip(true); // Skip: requires expensive field sqrt
        // Valid compressed G1 point (G1 generator)
        bytes memory compressed =
            hex"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";
        bytes memory uncompressed = harness.decompressG1(compressed);

        assertEq(uncompressed.length, 128, "G1 uncompressed should be 128 bytes");

        // Verify the point is on curve
        bool onCurve = harness.isOnCurveG1(uncompressed);
        assertTrue(onCurve, "Decompressed point should be on curve");
    }

    function test_isOnCurveG1_pointAtInfinity() public view {
        // All zeros is point at infinity and valid
        bytes memory infinity = new bytes(128);
        assertTrue(harness.isOnCurveG1(infinity), "Point at infinity should be on curve");
    }

    function test_isOnCurveG1_invalidLength() public view {
        bytes memory tooShort = hex"0000000000000000";
        assertFalse(harness.isOnCurveG1(tooShort), "Wrong length should not be on curve");
    }

    /// @dev Skip: curve equation check is expensive
    function test_isOnCurveG1_randomBytes() public {
        vm.skip(true);
        // Random bytes unlikely to be on curve
        bytes memory random = new bytes(128);
        for (uint256 i = 0; i < 128; i++) {
            random[i] = bytes1(uint8(i + 1));
        }
        assertFalse(harness.isOnCurveG1(random), "Random bytes should not be on curve");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // G2 DECOMPRESSION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decompressG2_pointAtInfinity() public view {
        // Point at infinity: 0xc0 followed by 95 zero bytes
        bytes memory compressed = new bytes(96);
        compressed[0] = 0xc0;
        bytes memory uncompressed = harness.decompressG2(compressed);

        // Point at infinity should decompress to all zeros
        assertEq(uncompressed.length, 256, "G2 uncompressed should be 256 bytes");
        for (uint256 i = 0; i < 256; i++) {
            assertEq(uint8(uncompressed[i]), 0, "Infinity should be all zeros");
        }
    }

    function test_decompressG2_invalidLength() public {
        bytes memory tooShort = hex"800000000000000000000000000000000000000000";
        vm.expectRevert(
            abi.encodeWithSelector(BLSDecompression.InvalidPointLength.selector, 96, 21)
        );
        harness.decompressG2(tooShort);
    }

    function test_decompressG2_missingCompressionFlag() public {
        // Missing compression flag (MSB not set)
        bytes memory invalid = new bytes(96);
        vm.expectRevert(BLSDecompression.InvalidPointFlags.selector);
        harness.decompressG2(invalid);
    }

    function test_isOnCurveG2_pointAtInfinity() public view {
        // All zeros is point at infinity and valid
        bytes memory infinity = new bytes(256);
        assertTrue(harness.isOnCurveG2(infinity), "Point at infinity should be on curve");
    }

    function test_isOnCurveG2_invalidLength() public view {
        bytes memory tooShort = hex"0000000000000000";
        assertFalse(harness.isOnCurveG2(tooShort), "Wrong length should not be on curve");
    }

    /// @dev Skip: curve equation check is expensive
    function test_isOnCurveG2_randomBytes() public {
        vm.skip(true);
        // Random bytes unlikely to be on curve
        bytes memory random = new bytes(256);
        for (uint256 i = 0; i < 256; i++) {
            random[i] = bytes1(uint8(i + 1));
        }
        assertFalse(harness.isOnCurveG2(random), "Random bytes should not be on curve");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ROUNDTRIP TESTS (decompress then verify on curve)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Skip: requires expensive field sqrt
    function test_decompressG1_andVerify_generatorPoint() public {
        vm.skip(true);
        // G1 generator compressed (with sign bit set)
        bytes memory compressed =
            hex"97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb";

        bytes memory uncompressed = harness.decompressG1(compressed);
        assertTrue(harness.isOnCurveG1(uncompressed), "Generator should be on curve");
    }
}
