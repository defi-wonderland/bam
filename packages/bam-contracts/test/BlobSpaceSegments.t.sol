// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BlobSpaceSegments } from "../src/core/BlobSpaceSegments.sol";
import { IERC_BSS } from "../src/interfaces/IERC_BSS.sol";

/// @title BlobSpaceSegmentsTest
/// @notice Tests for BlobSpaceSegments reference implementation
contract BlobSpaceSegmentsTest is Test {
    BlobSpaceSegments public bss;

    address public alice = address(0xa11ce);
    address public bob = address(0xb0b);

    bytes32 public constant SOCIAL_BLOBS_TAG = keccak256("social-blobs.v4");
    bytes32 public constant OPTIMISM_TAG = keccak256("optimism.bedrock");
    bytes32 public constant CELESTIA_TAG = keccak256("celestia.namespace");

    // Fake versioned hashes for testing
    bytes32 public constant BLOB_HASH_0 = bytes32(uint256(0x01) << 248 | uint256(0xdeadbeef));
    bytes32 public constant BLOB_HASH_1 = bytes32(uint256(0x01) << 248 | uint256(0xcafebabe));

    function setUp() public {
        bss = new BlobSpaceSegments();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    function _setBlobHash(bytes32 hash) internal {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = hash;
        vm.blobhashes(hashes);
    }

    function _setTwoBlobHashes(bytes32 hash0, bytes32 hash1) internal {
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = hash0;
        hashes[1] = hash1;
        vm.blobhashes(hashes);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HAPPY PATH — FULL BLOB
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_fullBlob() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, address(this), 0, 4096, SOCIAL_BLOBS_TAG);

        bytes32 result = bss.declareBlobSegment(0, 0, 4096, SOCIAL_BLOBS_TAG);
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HAPPY PATH — PARTIAL BLOB
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_partialBlob() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, address(this), 2000, 4096, SOCIAL_BLOBS_TAG);

        bytes32 result = bss.declareBlobSegment(0, 2000, 4096, SOCIAL_BLOBS_TAG);
        assertEq(result, BLOB_HASH_0);
    }

    function test_declareBlobSegment_singleFE() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, address(this), 4095, 4096, SOCIAL_BLOBS_TAG);

        bytes32 result = bss.declareBlobSegment(0, 4095, 4096, SOCIAL_BLOBS_TAG);
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HAPPY PATH — MULTI-SEGMENT (same blob, different callers)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_twoSegmentsSameBlob() public {
        _setBlobHash(BLOB_HASH_0);

        // L2 declares first half
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 0, 2000, OPTIMISM_TAG);
        bytes32 hash1 = bss.declareBlobSegment(0, 0, 2000, OPTIMISM_TAG);

        // Social protocol declares second half
        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, bob, 2000, 4096, SOCIAL_BLOBS_TAG);
        bytes32 hash2 = bss.declareBlobSegment(0, 2000, 4096, SOCIAL_BLOBS_TAG);

        // Both reference the same blob
        assertEq(hash1, hash2);
        assertEq(hash1, BLOB_HASH_0);
    }

    function test_declareBlobSegment_threeProtocolsTiling() public {
        _setBlobHash(BLOB_HASH_0);

        vm.prank(alice);
        bss.declareBlobSegment(0, 0, 1500, OPTIMISM_TAG);

        vm.prank(bob);
        bss.declareBlobSegment(0, 1500, 3000, SOCIAL_BLOBS_TAG);

        bss.declareBlobSegment(0, 3000, 4096, CELESTIA_TAG);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HAPPY PATH — MULTIPLE BLOBS IN ONE TX
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_differentBlobIndices() public {
        _setTwoBlobHashes(BLOB_HASH_0, BLOB_HASH_1);

        bytes32 hash0 = bss.declareBlobSegment(0, 0, 4096, OPTIMISM_TAG);
        bytes32 hash1 = bss.declareBlobSegment(1, 0, 4096, SOCIAL_BLOBS_TAG);

        assertEq(hash0, BLOB_HASH_0);
        assertEq(hash1, BLOB_HASH_1);
        assertTrue(hash0 != hash1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HAPPY PATH — ZERO CONTENT TAG (permitted but discouraged)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_zeroContentTag() public {
        _setBlobHash(BLOB_HASH_0);

        // bytes32(0) is allowed, just not recommended
        bytes32 result = bss.declareBlobSegment(0, 0, 4096, bytes32(0));
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HAPPY PATH — DECLARER IS MSG.SENDER
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_declarerIsMsgSender() public {
        _setBlobHash(BLOB_HASH_0);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 0, 4096, SOCIAL_BLOBS_TAG);
        bss.declareBlobSegment(0, 0, 4096, SOCIAL_BLOBS_TAG);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VALIDATION TESTS (revert before BLOBHASH check)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_invalidRange_startGteEnd() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(4096), uint16(0))
        );
        bss.declareBlobSegment(0, 4096, 0, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_invalidRange_startEqualsEnd() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(100), uint16(100))
        );
        bss.declareBlobSegment(0, 100, 100, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_invalidRange_endExceedsMax() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(0), uint16(5000))
        );
        bss.declareBlobSegment(0, 0, 5000, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_invalidRange_bothExceedMax() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(5000), uint16(6000))
        );
        bss.declareBlobSegment(0, 5000, 6000, SOCIAL_BLOBS_TAG);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NO-BLOB REVERT TESTS (valid range, but BLOBHASH returns 0)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_noBlobAtIndex_fullBlob() public {
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 0));
        bss.declareBlobSegment(0, 0, 4096, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_noBlobAtIndex_partialBlob() public {
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 0));
        bss.declareBlobSegment(0, 2000, 4096, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_noBlobAtIndex_highIndex() public {
        _setBlobHash(BLOB_HASH_0); // only index 0 has a blob
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 99));
        bss.declareBlobSegment(99, 0, 4096, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_noBlobAtIndex_singleFE() public {
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 0));
        bss.declareBlobSegment(0, 4095, 4096, SOCIAL_BLOBS_TAG);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function testFuzz_declareBlobSegment_revert_startGteEnd(uint16 endFE) public {
        endFE = uint16(bound(uint256(endFE), 0, 4096));
        uint16 startFE = endFE; // startFE == endFE is invalid
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, startFE, endFE));
        bss.declareBlobSegment(0, startFE, endFE, SOCIAL_BLOBS_TAG);
    }

    function testFuzz_declareBlobSegment_revert_endExceedsMax(uint16 endFE) public {
        endFE = uint16(bound(uint256(endFE), 4097, type(uint16).max));
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(0), endFE));
        bss.declareBlobSegment(0, 0, endFE, SOCIAL_BLOBS_TAG);
    }

    function testFuzz_declareBlobSegment_validRange_succeeds(uint16 startFE, uint16 endFE) public {
        endFE = uint16(bound(uint256(endFE), 1, 4096));
        startFE = uint16(bound(uint256(startFE), 0, uint256(endFE) - 1));
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(
            BLOB_HASH_0, address(this), startFE, endFE, SOCIAL_BLOBS_TAG
        );

        bytes32 result = bss.declareBlobSegment(0, startFE, endFE, SOCIAL_BLOBS_TAG);
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // GAS BENCHMARK
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_gas_declareBlobSegment_fullBlob() public {
        _setBlobHash(BLOB_HASH_0);

        uint256 gasBefore = gasleft();
        bss.declareBlobSegment(0, 0, 4096, SOCIAL_BLOBS_TAG);
        uint256 gasUsed = gasBefore - gasleft();

        // Marginal gas should be in the ~3,000-4,000 range (excluding tx overhead)
        assertLt(gasUsed, 10_000, "gas too high");
    }

    function test_gas_declareBlobSegment_partialBlob() public {
        _setBlobHash(BLOB_HASH_0);

        uint256 gasBefore = gasleft();
        bss.declareBlobSegment(0, 2000, 4096, SOCIAL_BLOBS_TAG);
        uint256 gasUsed = gasBefore - gasleft();

        assertLt(gasUsed, 10_000, "gas too high");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERFACE COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_implementsIERC_BSS() public view {
        IERC_BSS iface = IERC_BSS(address(bss));
        assert(address(iface) == address(bss));
    }
}
