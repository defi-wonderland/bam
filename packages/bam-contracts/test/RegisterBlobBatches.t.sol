// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { BlobAuthenticatedMessagingCore } from "../src/core/BlobAuthenticatedMessagingCore.sol";
import { IERC_BSS } from "../src/interfaces/IERC_BSS.sol";
import { IERC_BAM_Core } from "../src/interfaces/IERC_BAM_Core.sol";

/// @title RegisterBlobBatchesTest
/// @notice Tests for the new bulk `registerBlobBatches` entrypoint.
contract RegisterBlobBatchesTest is Test {
    BlobAuthenticatedMessagingCore public core;

    address public alice = address(0xa11ce);
    address public bob = address(0xb0b);
    address public decoder1 = address(0xdec0de1);
    address public decoder2 = address(0xdec0de2);
    address public sigRegistry1 = address(0x51946e1);
    address public sigRegistry2 = address(0x51946e2);

    bytes32 public constant TAG_A = keccak256("tag.a");
    bytes32 public constant TAG_B = keccak256("tag.b");
    bytes32 public constant TAG_C = keccak256("tag.c");
    bytes32 public constant BLOB_HASH_0 = bytes32(uint256(0x01) << 248 | uint256(0xdeadbeef));

    bytes32 internal constant BLOB_BATCH_REGISTERED_TOPIC0 =
        keccak256("BlobBatchRegistered(bytes32,address,bytes32,address,address)");
    bytes32 internal constant BLOB_SEGMENT_DECLARED_TOPIC0 =
        keccak256("BlobSegmentDeclared(bytes32,address,uint16,uint16,bytes32)");

    function setUp() public {
        core = new BlobAuthenticatedMessagingCore();
    }

    function _setBlobHash(bytes32 hash) internal {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = hash;
        vm.blobhashes(hashes);
    }

    function _countLogsByTopic0(Vm.Log[] memory logs, bytes32 topic0)
        internal
        pure
        returns (uint256 count)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0) count++;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // (a) one-entry call → one event, same shape as registerBlobBatch
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_singleEntry_emitsOneBlobBatchRegistered() public {
        _setBlobHash(BLOB_HASH_0);

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](1);
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 100,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });

        vm.expectEmit(true, true, true, true);
        emit IERC_BSS.BlobSegmentDeclared(BLOB_HASH_0, alice, 0, 100, TAG_A);

        vm.expectEmit(true, true, true, true);
        emit IERC_BAM_Core.BlobBatchRegistered(BLOB_HASH_0, alice, TAG_A, decoder1, sigRegistry1);

        vm.prank(alice);
        bytes32[] memory hashes = core.registerBlobBatches(calls);
        assertEq(hashes.length, 1);
        assertEq(hashes[0], BLOB_HASH_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // (b) N-entry call → N events; all share one versionedHash (when same blobIndex)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_multiEntry_emitsNEventsWithSharedVersionedHash() public {
        _setBlobHash(BLOB_HASH_0);

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](3);
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 100,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });
        calls[1] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 100,
            endFE: 250,
            contentTag: TAG_B,
            decoder: decoder2,
            signatureRegistry: sigRegistry2
        });
        calls[2] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 250,
            endFE: 4096,
            contentTag: TAG_C,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });

        vm.recordLogs();
        vm.prank(alice);
        bytes32[] memory hashes = core.registerBlobBatches(calls);

        assertEq(hashes.length, 3);
        assertEq(hashes[0], BLOB_HASH_0);
        assertEq(hashes[1], BLOB_HASH_0);
        assertEq(hashes[2], BLOB_HASH_0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogsByTopic0(logs, BLOB_BATCH_REGISTERED_TOPIC0), 3);
        assertEq(_countLogsByTopic0(logs, BLOB_SEGMENT_DECLARED_TOPIC0), 3);

        // Walk BlobBatchRegistered events in emit order; assert per-entry fields.
        uint256 seen = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != BLOB_BATCH_REGISTERED_TOPIC0) continue;
            assertEq(logs[i].topics[1], BLOB_HASH_0, "shared versionedHash");
            assertEq(
                logs[i].topics[2], bytes32(uint256(uint160(alice))), "submitter is alice"
            );
            (address dec, address sigReg) = abi.decode(logs[i].data, (address, address));
            if (seen == 0) {
                assertEq(logs[i].topics[3], TAG_A, "first contentTag is A");
                assertEq(dec, decoder1);
                assertEq(sigReg, sigRegistry1);
            } else if (seen == 1) {
                assertEq(logs[i].topics[3], TAG_B, "second contentTag is B");
                assertEq(dec, decoder2);
                assertEq(sigReg, sigRegistry2);
            } else if (seen == 2) {
                assertEq(logs[i].topics[3], TAG_C, "third contentTag is C");
                assertEq(dec, decoder1);
                assertEq(sigReg, sigRegistry1);
            }
            seen++;
        }
        assertEq(seen, 3);
    }

    // Verify each BlobSegmentDeclared carried its own (startFE, endFE) — non-overlapping packs.
    function test_multiEntry_perEntryStartEndFE() public {
        _setBlobHash(BLOB_HASH_0);

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](2);
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 50,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });
        calls[1] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 50,
            endFE: 200,
            contentTag: TAG_B,
            decoder: decoder2,
            signatureRegistry: sigRegistry2
        });

        vm.recordLogs();
        vm.prank(alice);
        core.registerBlobBatches(calls);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != BLOB_SEGMENT_DECLARED_TOPIC0) continue;
            (uint16 sFE, uint16 eFE) = abi.decode(logs[i].data, (uint16, uint16));
            if (seen == 0) {
                assertEq(uint256(sFE), 0);
                assertEq(uint256(eFE), 50);
                assertEq(logs[i].topics[3], TAG_A);
            } else if (seen == 1) {
                assertEq(uint256(sFE), 50);
                assertEq(uint256(eFE), 200);
                assertEq(logs[i].topics[3], TAG_B);
            }
            seen++;
        }
        assertEq(seen, 2);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // (c) submitter == msg.sender on every emitted event
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_submitterIsMsgSenderForEveryEvent() public {
        _setBlobHash(BLOB_HASH_0);

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](3);
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 10,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });
        calls[1] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 10,
            endFE: 20,
            contentTag: TAG_B,
            decoder: decoder2,
            signatureRegistry: sigRegistry2
        });
        calls[2] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 20,
            endFE: 30,
            contentTag: TAG_C,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });

        vm.recordLogs();
        vm.prank(bob);
        core.registerBlobBatches(calls);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 batchEvents;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != BLOB_BATCH_REGISTERED_TOPIC0) continue;
            assertEq(
                logs[i].topics[2],
                bytes32(uint256(uint160(bob))),
                "submitter equals msg.sender (bob)"
            );
            batchEvents++;
        }
        assertEq(batchEvents, 3);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // (d) empty array → revert EmptyBatchArray
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_emptyArrayReverts() public {
        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](0);

        vm.expectRevert(abi.encodeWithSelector(BlobAuthenticatedMessagingCore.EmptyBatchArray.selector));
        core.registerBlobBatches(calls);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // (e) one bad entry reverts the whole tx; no events from prior entries land
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_oneBadEntryRevertsAtomically_invertedRange() public {
        _setBlobHash(BLOB_HASH_0);

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](3);
        // [0] valid
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 10,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });
        // [1] valid
        calls[1] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 10,
            endFE: 20,
            contentTag: TAG_B,
            decoder: decoder2,
            signatureRegistry: sigRegistry2
        });
        // [2] inverted: startFE >= endFE
        calls[2] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 50,
            endFE: 50,
            contentTag: TAG_C,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });

        // Verify the call reverts with InvalidSegment from entry [2].
        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(50), uint16(50))
        );
        core.registerBlobBatches(calls);

        // Atomicity is an EVM-level guarantee: a reverted call discards every LOG
        // emitted in its frame. After the revert, the only successful call is to a
        // single-entry batch — verify that produces exactly one BlobBatchRegistered
        // event, confirming no leftover events from the reverted call were committed.
        IERC_BAM_Core.BlobBatchCall[] memory single = new IERC_BAM_Core.BlobBatchCall[](1);
        single[0] = calls[0];
        _setBlobHash(BLOB_HASH_0);
        vm.recordLogs();
        core.registerBlobBatches(single);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogsByTopic0(logs, BLOB_BATCH_REGISTERED_TOPIC0), 1);
        assertEq(_countLogsByTopic0(logs, BLOB_SEGMENT_DECLARED_TOPIC0), 1);
    }

    function test_oneBadEntryRevertsAtomically_endExceedsMax() public {
        _setBlobHash(BLOB_HASH_0);

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](2);
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 100,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });
        calls[1] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 100,
            endFE: 5000,
            contentTag: TAG_B,
            decoder: decoder2,
            signatureRegistry: sigRegistry2
        });

        vm.expectRevert(
            abi.encodeWithSelector(IERC_BSS.InvalidSegment.selector, uint16(100), uint16(5000))
        );
        core.registerBlobBatches(calls);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // (f) blobhash(blobIndex) == 0 for one entry → revert NoBlobAtIndex
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_oneEntryNoBlobAtIndex_reverts() public {
        _setBlobHash(BLOB_HASH_0); // only index 0 has a blob

        IERC_BAM_Core.BlobBatchCall[] memory calls = new IERC_BAM_Core.BlobBatchCall[](2);
        calls[0] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 0,
            startFE: 0,
            endFE: 10,
            contentTag: TAG_A,
            decoder: decoder1,
            signatureRegistry: sigRegistry1
        });
        calls[1] = IERC_BAM_Core.BlobBatchCall({
            blobIndex: 99,
            startFE: 0,
            endFE: 10,
            contentTag: TAG_B,
            decoder: decoder2,
            signatureRegistry: sigRegistry2
        });

        vm.expectRevert(abi.encodeWithSelector(IERC_BSS.NoBlobAtIndex.selector, 99));
        core.registerBlobBatches(calls);
    }
}
