// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BlobAuthenticatedMessagingCore } from "../src/core/BlobAuthenticatedMessagingCore.sol";
import { IERC_BSS } from "../src/interfaces/IERC_BSS.sol";
import { IERC_BAM_Core } from "../src/interfaces/IERC_BAM_Core.sol";

/// @title BlobAuthenticatedMessagingCoreTest
/// @notice Tests for the ERC-BAM core reference implementation
contract BlobAuthenticatedMessagingCoreTest is Test {
    BlobAuthenticatedMessagingCore public core;

    address public alice = address(0xa11ce);
    address public bob = address(0xb0b);
    address public decoder = address(0xdec0de4);
    address public sigRegistry = address(0x51946e9);

    bytes32 public constant SOCIAL_BLOBS_TAG = keccak256("social-blobs.v4");
    bytes32 public constant BLOB_HASH_0 = bytes32(uint256(0x01) << 248 | uint256(0xdeadbeef));
    bytes32 public constant BLOB_HASH_1 = bytes32(uint256(0x01) << 248 | uint256(0xcafebabe));

    function setUp() public {
        core = new BlobAuthenticatedMessagingCore();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    function _setBlobHash(bytes32 hash) internal {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = hash;
        vm.blobhashes(hashes);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // registerBlobBatch — HAPPY PATH
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerBlobBatch_emitsBothEvents() public {
        _setBlobHash(BLOB_HASH_0);

        // Expect BlobSegmentDeclared first (from declareBlobSegment)
        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 0, 4096, SOCIAL_BLOBS_TAG);

        // Then BlobBatchRegistered
        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(BLOB_HASH_0, alice, decoder, sigRegistry);

        vm.prank(alice);
        bytes32 result = core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    function test_registerBlobBatch_partialSegment() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 2000, 4096, SOCIAL_BLOBS_TAG);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(BLOB_HASH_0, alice, decoder, sigRegistry);

        vm.prank(alice);
        bytes32 result =
            core.registerBlobBatch(0, 2000, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    function test_registerBlobBatch_returnsVersionedHash() public {
        _setBlobHash(BLOB_HASH_0);

        vm.prank(alice);
        bytes32 result = core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // registerBlobBatch — REVERTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerBlobBatch_revert_invalidSegment_startGteEnd() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(4096), uint16(0))
        );
        core.registerBlobBatch(0, 4096, 0, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    function test_registerBlobBatch_revert_invalidSegment_startEqualsEnd() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(100), uint16(100))
        );
        core.registerBlobBatch(0, 100, 100, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    function test_registerBlobBatch_revert_invalidSegment_endExceedsMax() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(0), uint16(5000))
        );
        core.registerBlobBatch(0, 0, 5000, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    function test_registerBlobBatch_revert_noBlobAtIndex() public {
        // No blob hashes set
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 0));
        core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    function test_registerBlobBatch_revert_noBlobAtHighIndex() public {
        _setBlobHash(BLOB_HASH_0); // only index 0

        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 99));
        core.registerBlobBatch(99, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // registerBlobBatch — decoder=address(0) and sigRegistry=address(0)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerBlobBatch_decoderZeroPermitted() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(BLOB_HASH_0, address(this), address(0), sigRegistry);

        bytes32 result =
            core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, address(0), sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    function test_registerBlobBatch_signatureRegistryZeroPermitted() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(BLOB_HASH_0, address(this), decoder, address(0));

        bytes32 result = core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, address(0));
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // registerCalldataBatch — HAPPY PATH
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerCalldataBatch_emitsEvent() public {
        bytes memory batchData = hex"deadbeef";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(expectedHash, alice, decoder, sigRegistry);

        vm.prank(alice);
        bytes32 result = core.registerCalldataBatch(batchData, decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_returnsContentHash() public {
        bytes memory batchData = hex"0102030405060708";
        bytes32 expectedHash = keccak256(batchData);

        vm.prank(alice);
        bytes32 result = core.registerCalldataBatch(batchData, decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_emptyData() public {
        bytes memory emptyData = hex"";
        bytes32 expectedHash = keccak256(emptyData);

        bytes32 result = core.registerCalldataBatch(emptyData, decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_decoderZeroPermitted() public {
        bytes memory batchData = hex"aabb";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, address(this), address(0), sigRegistry
        );

        bytes32 result = core.registerCalldataBatch(batchData, address(0), sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_signatureRegistryZeroPermitted() public {
        bytes memory batchData = hex"aabb";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(expectedHash, address(this), decoder, address(0));

        bytes32 result = core.registerCalldataBatch(batchData, decoder, address(0));
        assertEq(result, expectedHash);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // declareBlobSegment — direct calls (BSS compliance)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_declareBlobSegment_directCall() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 0, 4096, SOCIAL_BLOBS_TAG);

        vm.prank(alice);
        bytes32 result = core.declareBlobSegment(0, 0, 4096, SOCIAL_BLOBS_TAG);
        assertEq(result, BLOB_HASH_0);
    }

    function test_declareBlobSegment_revert_invalidSegment() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(100), uint16(50))
        );
        core.declareBlobSegment(0, 100, 50, SOCIAL_BLOBS_TAG);
    }

    function test_declareBlobSegment_revert_noBlobAtIndex() public {
        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 0));
        core.declareBlobSegment(0, 0, 4096, SOCIAL_BLOBS_TAG);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERFACE COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_implementsIERC_BAM_Core() public view {
        IERC_BAM_Core iface = IERC_BAM_Core(address(core));
        assert(address(iface) == address(core));
    }

    function test_implementsIERC_BSS() public view {
        IERC_BSS iface = IERC_BSS(address(core));
        assert(address(iface) == address(core));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function testFuzz_registerBlobBatch_validRange(
        uint16 startFE,
        uint16 endFE,
        bytes32 contentTag,
        address _decoder,
        address _sigRegistry
    ) public {
        endFE = uint16(bound(uint256(endFE), 1, 4096));
        startFE = uint16(bound(uint256(startFE), 0, uint256(endFE) - 1));
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, address(this), startFE, endFE, contentTag);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(BLOB_HASH_0, address(this), _decoder, _sigRegistry);

        bytes32 result =
            core.registerBlobBatch(0, startFE, endFE, contentTag, _decoder, _sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    function testFuzz_registerBlobBatch_revert_startGteEnd(uint16 endFE) public {
        endFE = uint16(bound(uint256(endFE), 0, 4096));
        uint16 startFE = endFE; // startFE == endFE is invalid
        _setBlobHash(BLOB_HASH_0);

        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, startFE, endFE));
        core.registerBlobBatch(0, startFE, endFE, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    function testFuzz_registerBlobBatch_revert_endExceedsMax(uint16 endFE) public {
        endFE = uint16(bound(uint256(endFE), 4097, type(uint16).max));
        _setBlobHash(BLOB_HASH_0);

        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(0), endFE));
        core.registerBlobBatch(0, 0, endFE, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
    }

    function testFuzz_registerCalldataBatch(
        bytes calldata batchData,
        address _decoder,
        address _sigRegistry
    ) public {
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, address(this), _decoder, _sigRegistry
        );

        bytes32 result = core.registerCalldataBatch(batchData, _decoder, _sigRegistry);
        assertEq(result, expectedHash);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PERMISSIONLESS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerBlobBatch_anyoneCanCall() public {
        _setBlobHash(BLOB_HASH_0);

        vm.prank(alice);
        bytes32 h1 = core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        _setBlobHash(BLOB_HASH_0);

        vm.prank(bob);
        bytes32 h2 = core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        assertEq(h1, h2);
    }

    function test_registerCalldataBatch_anyoneCanCall() public {
        bytes memory batchData = hex"ff";

        vm.prank(alice);
        bytes32 h1 = core.registerCalldataBatch(batchData, decoder, sigRegistry);

        vm.prank(bob);
        bytes32 h2 = core.registerCalldataBatch(batchData, decoder, sigRegistry);

        assertEq(h1, h2);
    }
}
