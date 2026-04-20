// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
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
    bytes32 public constant OTHER_TAG = keccak256("other-protocol.v1");
    bytes32 public constant BLOB_HASH_0 = bytes32(uint256(0x01) << 248 | uint256(0xdeadbeef));
    bytes32 public constant BLOB_HASH_1 = bytes32(uint256(0x01) << 248 | uint256(0xcafebabe));

    // Canonical event-signature topic hashes. These must match the event shapes declared
    // in IERC_BAM_Core.sol; topic-level filter tests depend on them.
    bytes32 internal constant BLOB_BATCH_REGISTERED_TOPIC0 =
        keccak256("BlobBatchRegistered(bytes32,address,bytes32,address,address)");
    bytes32 internal constant CALLDATA_BATCH_REGISTERED_TOPIC0 =
        keccak256("CalldataBatchRegistered(bytes32,address,bytes32,address,address)");
    bytes32 internal constant BLOB_SEGMENT_DECLARED_TOPIC0 =
        keccak256("BlobSegmentDeclared(bytes32,address,uint16,uint16,bytes32)");

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

    /// @dev Count recorded logs matching a given topic0 (event signature) and topic3 (contentTag).
    function _countByTag(Vm.Log[] memory logs, bytes32 topic0, bytes32 tag)
        internal
        pure
        returns (uint256 count)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length >= 4 && logs[i].topics[0] == topic0 && logs[i].topics[3] == tag)
            {
                count++;
            }
        }
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
        emit IERC_BAM_Core.BlobBatchRegistered(
            BLOB_HASH_0, alice, SOCIAL_BLOBS_TAG, decoder, sigRegistry
        );

        vm.prank(alice);
        bytes32 result = core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    function test_registerBlobBatch_partialSegment() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 2000, 4096, SOCIAL_BLOBS_TAG);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(
            BLOB_HASH_0, alice, SOCIAL_BLOBS_TAG, decoder, sigRegistry
        );

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
        emit IERC_BAM_Core.BlobBatchRegistered(
            BLOB_HASH_0, address(this), SOCIAL_BLOBS_TAG, address(0), sigRegistry
        );

        bytes32 result =
            core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, address(0), sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    function test_registerBlobBatch_signatureRegistryZeroPermitted() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(
            BLOB_HASH_0, address(this), SOCIAL_BLOBS_TAG, decoder, address(0)
        );

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
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, alice, SOCIAL_BLOBS_TAG, decoder, sigRegistry
        );

        vm.prank(alice);
        bytes32 result =
            core.registerCalldataBatch(batchData, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_returnsContentHash() public {
        bytes memory batchData = hex"0102030405060708";
        bytes32 expectedHash = keccak256(batchData);

        vm.prank(alice);
        bytes32 result =
            core.registerCalldataBatch(batchData, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_emptyData() public {
        bytes memory emptyData = hex"";
        bytes32 expectedHash = keccak256(emptyData);

        bytes32 result =
            core.registerCalldataBatch(emptyData, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_decoderZeroPermitted() public {
        bytes memory batchData = hex"aabb";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, address(this), SOCIAL_BLOBS_TAG, address(0), sigRegistry
        );

        bytes32 result =
            core.registerCalldataBatch(batchData, SOCIAL_BLOBS_TAG, address(0), sigRegistry);
        assertEq(result, expectedHash);
    }

    function test_registerCalldataBatch_signatureRegistryZeroPermitted() public {
        bytes memory batchData = hex"aabb";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, address(this), SOCIAL_BLOBS_TAG, decoder, address(0)
        );

        bytes32 result =
            core.registerCalldataBatch(batchData, SOCIAL_BLOBS_TAG, decoder, address(0));
        assertEq(result, expectedHash);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // contentTag — SAME-TAG FORWARDING (G-7 / red-team C-8)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice The contentTag topic emitted by BlobSegmentDeclared and BlobBatchRegistered
    ///         from a single registerBlobBatch call MUST be equal. Enforces B-2 on the
    ///         blob path — no re-derivation, hashing, normalization, or defaulting.
    function test_registerBlobBatch_sameTagForwarding() public {
        _setBlobHash(BLOB_HASH_0);

        vm.recordLogs();
        core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 segTag;
        bytes32 batchTag;
        bool sawSeg;
        bool sawBatch;

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == BLOB_SEGMENT_DECLARED_TOPIC0) {
                // BlobSegmentDeclared topics: [sig, versionedHash, submitter, contentTag]
                segTag = logs[i].topics[3];
                sawSeg = true;
            } else if (logs[i].topics[0] == BLOB_BATCH_REGISTERED_TOPIC0) {
                // BlobBatchRegistered topics: [sig, versionedHash, submitter, contentTag]
                batchTag = logs[i].topics[3];
                sawBatch = true;
            }
        }

        assertTrue(sawSeg, "BlobSegmentDeclared not emitted");
        assertTrue(sawBatch, "BlobBatchRegistered not emitted");
        assertEq(segTag, SOCIAL_BLOBS_TAG, "segment tag must equal input");
        assertEq(batchTag, SOCIAL_BLOBS_TAG, "batch tag must equal input");
        assertEq(segTag, batchTag, "segment and batch contentTag must be equal");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // contentTag — TOPIC-LEVEL FILTER (G-6 / red-team C-7)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Filter BlobBatchRegistered logs by the contentTag topic. A consumer
    ///         issuing eth_getLogs with topics[3] = tag must receive exactly the matching
    ///         registrations. A filter on an unused tag must return zero.
    function test_registerBlobBatch_topicFilterByContentTag() public {
        vm.recordLogs();

        _setBlobHash(BLOB_HASH_0);
        core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        _setBlobHash(BLOB_HASH_1);
        core.registerBlobBatch(0, 0, 4096, OTHER_TAG, decoder, sigRegistry);
        _setBlobHash(BLOB_HASH_0);
        core.registerBlobBatch(0, 0, 4096, SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countByTag(logs, BLOB_BATCH_REGISTERED_TOPIC0, SOCIAL_BLOBS_TAG),
            2,
            "two BlobBatchRegistered with SOCIAL_BLOBS_TAG"
        );
        assertEq(
            _countByTag(logs, BLOB_BATCH_REGISTERED_TOPIC0, OTHER_TAG),
            1,
            "one BlobBatchRegistered with OTHER_TAG"
        );
        assertEq(
            _countByTag(logs, BLOB_BATCH_REGISTERED_TOPIC0, keccak256("never-used")),
            0,
            "unused tag must match zero logs"
        );
    }

    /// @notice Filter CalldataBatchRegistered logs by the contentTag topic. Same invariant
    ///         as registerBlobBatch — topic-level filter matches exactly the expected subset.
    function test_registerCalldataBatch_topicFilterByContentTag() public {
        vm.recordLogs();

        core.registerCalldataBatch(hex"aa", SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        core.registerCalldataBatch(hex"bb", OTHER_TAG, decoder, sigRegistry);
        core.registerCalldataBatch(hex"cc", SOCIAL_BLOBS_TAG, decoder, sigRegistry);
        core.registerCalldataBatch(hex"dd", SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countByTag(logs, CALLDATA_BATCH_REGISTERED_TOPIC0, SOCIAL_BLOBS_TAG),
            3,
            "three CalldataBatchRegistered with SOCIAL_BLOBS_TAG"
        );
        assertEq(
            _countByTag(logs, CALLDATA_BATCH_REGISTERED_TOPIC0, OTHER_TAG),
            1,
            "one CalldataBatchRegistered with OTHER_TAG"
        );
        assertEq(
            _countByTag(logs, CALLDATA_BATCH_REGISTERED_TOPIC0, keccak256("never-used")),
            0,
            "unused tag must match zero logs"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // contentTag — NULL-TAG ACCEPTANCE (G-8 / red-team C-3)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice registerCalldataBatch MUST NOT reject bytes32(0). The null tag is accepted
    ///         at the contract layer and emitted verbatim; null-tag discouragement is a
    ///         prose-level application-layer recommendation only.
    function test_registerCalldataBatch_nullTagAccepted() public {
        bytes memory batchData = hex"feedface";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, address(this), bytes32(0), decoder, sigRegistry
        );

        bytes32 result = core.registerCalldataBatch(batchData, bytes32(0), decoder, sigRegistry);
        assertEq(result, expectedHash);
    }

    /// @notice registerBlobBatch MUST NOT reject bytes32(0). Null tag is emitted verbatim
    ///         in both BlobSegmentDeclared and BlobBatchRegistered.
    function test_registerBlobBatch_nullTagAccepted() public {
        _setBlobHash(BLOB_HASH_0);

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, address(this), 0, 4096, bytes32(0));

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(
            BLOB_HASH_0, address(this), bytes32(0), decoder, sigRegistry
        );

        bytes32 result = core.registerBlobBatch(0, 0, 4096, bytes32(0), decoder, sigRegistry);
        assertEq(result, BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // contentTag — CALLDATA ROUND-TRIP (B-2 on the calldata path)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice The contentTag argument passed to registerCalldataBatch MUST be emitted
    ///         verbatim in CalldataBatchRegistered — no re-derivation or normalization.
    function test_registerCalldataBatch_contentTagRoundTrip() public {
        bytes memory batchData = hex"0badc0de";
        bytes32 expectedHash = keccak256(batchData);
        bytes32 inputTag = keccak256("round-trip.v1");

        vm.recordLogs();
        bytes32 result = core.registerCalldataBatch(batchData, inputTag, decoder, sigRegistry);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == CALLDATA_BATCH_REGISTERED_TOPIC0) {
                assertEq(logs[i].topics[1], expectedHash, "contentHash topic");
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(this)))), "submitter");
                assertEq(logs[i].topics[3], inputTag, "contentTag topic equals input");
                found = true;
            }
        }
        assertTrue(found, "CalldataBatchRegistered emitted");
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
        emit IERC_BAM_Core.BlobBatchRegistered(
            BLOB_HASH_0, address(this), contentTag, _decoder, _sigRegistry
        );

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
        bytes32 contentTag,
        address _decoder,
        address _sigRegistry
    ) public {
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.CalldataBatchRegistered(
            expectedHash, address(this), contentTag, _decoder, _sigRegistry
        );

        bytes32 result =
            core.registerCalldataBatch(batchData, contentTag, _decoder, _sigRegistry);
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
        bytes32 h1 =
            core.registerCalldataBatch(batchData, SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        vm.prank(bob);
        bytes32 h2 =
            core.registerCalldataBatch(batchData, SOCIAL_BLOBS_TAG, decoder, sigRegistry);

        assertEq(h1, h2);
    }
}
