// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { SocialBlobsCore } from "../src/core/SocialBlobsCore.sol";
import { ISocialBlobsCore } from "../src/interfaces/ISocialBlobsCore.sol";

/// @title SocialBlobsCoreTest
/// @notice Tests for stateless SocialBlobsCore contract
/// @dev Core is fully stateless — zero storage, events only
contract SocialBlobsCoreTest is Test {
    SocialBlobsCore public core;

    address public alice = address(0x1);
    address public bob = address(0x2);

    function setUp() public {
        core = new SocialBlobsCore();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // BLOB REGISTRATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerBlob_invalidIndex() public {
        vm.expectRevert(abi.encodeWithSelector(ISocialBlobsCore.InvalidBlobIndex.selector, 6));
        core.registerBlob(6);

        vm.expectRevert(abi.encodeWithSelector(ISocialBlobsCore.InvalidBlobIndex.selector, 100));
        core.registerBlob(100);
    }

    function test_registerBlob_noBlob() public {
        // When no blob is present, BLOBHASH returns 0
        vm.expectRevert(abi.encodeWithSelector(ISocialBlobsCore.InvalidBlobIndex.selector, 0));
        core.registerBlob(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CALLDATA REGISTRATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_registerCalldata_returnsHash() public {
        bytes memory batchData = hex"0102030405060708";

        vm.prank(alice);
        bytes32 contentHash = core.registerCalldata(batchData);

        assertEq(contentHash, keccak256(batchData));
    }

    function test_registerCalldata_emitsEvent() public {
        bytes memory batchData = hex"deadbeef";
        bytes32 expectedHash = keccak256(batchData);

        vm.expectEmit(true, true, true, true);
        emit ISocialBlobsCore.CalldataRegistered(
            expectedHash, alice, uint64(block.timestamp), batchData.length
        );

        vm.prank(alice);
        core.registerCalldata(batchData);
    }

    function test_registerCalldata_duplicateAllowed() public {
        bytes memory batchData = hex"0102030405060708";

        vm.prank(alice);
        bytes32 hash1 = core.registerCalldata(batchData);

        // Second registration of same data is allowed (stateless — no dedup)
        vm.prank(bob);
        bytes32 hash2 = core.registerCalldata(batchData);

        // Both return the same hash
        assertEq(hash1, hash2);
    }

    function test_registerCalldata_multipleDistinct() public {
        bytes memory batchData1 = hex"0102030405060708";
        bytes memory batchData2 = hex"aabbccdd";

        vm.prank(alice);
        bytes32 hash1 = core.registerCalldata(batchData1);

        vm.prank(bob);
        bytes32 hash2 = core.registerCalldata(batchData2);

        // Different data produces different hashes
        assertTrue(hash1 != hash2);
        assertEq(hash1, keccak256(batchData1));
        assertEq(hash2, keccak256(batchData2));
    }

    function test_registerCalldata_largeBatch() public {
        // Create a 10KB batch
        bytes memory largeBatch = new bytes(10_240);
        for (uint256 i = 0; i < largeBatch.length; i++) {
            largeBatch[i] = bytes1(uint8(i % 256));
        }

        vm.prank(alice);
        bytes32 contentHash = core.registerCalldata(largeBatch);

        assertEq(contentHash, keccak256(largeBatch));
    }

    function test_registerCalldata_emptyData() public {
        bytes memory emptyData = hex"";

        vm.prank(alice);
        bytes32 contentHash = core.registerCalldata(emptyData);

        assertEq(contentHash, keccak256(emptyData));
    }
}
