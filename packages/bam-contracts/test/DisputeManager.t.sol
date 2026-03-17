// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { DisputeManager } from "../src/peripheral/DisputeManager.sol";
import { IDisputeManager } from "../src/interfaces/IDisputeManager.sol";
import { IExposureRecord } from "../src/interfaces/IExposureRecord.sol";
import { SocialBlobsTypes } from "../src/libraries/SocialBlobsTypes.sol";

/// @title MockExposureRecord
/// @notice Mock for testing DisputeManager
contract MockExposureRecord {
    mapping(bytes32 => bool) private _exposed;
    mapping(bytes32 => SocialBlobsTypes.ExposedTweet) private _exposures;

    function setExposed(bytes32 messageHash, address author) external {
        _exposed[messageHash] = true;
        _exposures[messageHash] = SocialBlobsTypes.ExposedTweet({
            contentHash: bytes32(0),
            author: author,
            messageContentHash: keccak256("content"),
            timestamp: uint64(block.timestamp),
            exposedAt: uint64(block.timestamp),
            exposedBy: msg.sender
        });
    }

    function isExposed(bytes32 messageHash) external view returns (bool) {
        return _exposed[messageHash];
    }

    function getExposure(bytes32 messageHash)
        external
        view
        returns (SocialBlobsTypes.ExposedTweet memory)
    {
        return _exposures[messageHash];
    }
}

/// @title DisputeManagerTest
/// @notice Tests for DisputeManager contract
contract DisputeManagerTest is Test {
    DisputeManager public disputeManager;
    MockExposureRecord public exposureRecord;

    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public resolver = address(0x3);

    bytes32 public constant MSG_HASH_1 = keccak256("message1");
    bytes32 public constant MSG_HASH_2 = keccak256("message2");

    // Allow test contract to receive ETH
    receive() external payable { }

    function setUp() public {
        exposureRecord = new MockExposureRecord();
        disputeManager = new DisputeManager(address(exposureRecord), owner);

        // Fund test accounts
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);

        // Add resolver
        disputeManager.addResolver(resolver);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CHALLENGE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_challenge_success() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit IDisputeManager.ChallengeFiled(MSG_HASH_1, bob, 0.01 ether);

        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        assertTrue(disputeManager.isDisputed(MSG_HASH_1));
    }

    function test_challenge_notExposed() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeManager.MessageNotExposed.selector, MSG_HASH_1)
        );
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");
    }

    function test_challenge_alreadyDisputed() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeManager.AlreadyDisputed.selector, MSG_HASH_1)
        );
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence2");
    }

    function test_challenge_windowClosed() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        // Move past challenge window (24 hours)
        vm.warp(block.timestamp + 25 hours);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeManager.ChallengeWindowClosed.selector, MSG_HASH_1)
        );
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");
    }

    function test_challenge_insufficientStake() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IDisputeManager.InsufficientStake.selector, 0.01 ether, 0.005 ether
            )
        );
        disputeManager.challenge{ value: 0.005 ether }(MSG_HASH_1, "evidence");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // RESOLUTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_resolve_validExposure() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        uint256 ownerBalanceBefore = owner.balance;

        vm.prank(resolver);
        disputeManager.resolve(MSG_HASH_1, true);

        // Challenger loses stake, goes to owner
        assertEq(owner.balance, ownerBalanceBefore + 0.01 ether);
        assertFalse(disputeManager.isDisputed(MSG_HASH_1));
    }

    function test_resolve_fraudulentExposure() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        uint256 bobBalanceBefore = bob.balance;

        vm.prank(resolver);
        disputeManager.resolve(MSG_HASH_1, false);

        // Challenger wins, gets stake back
        assertEq(bob.balance, bobBalanceBefore + 0.01 ether);
    }

    function test_resolve_notAuthorized() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        vm.prank(alice); // Not a resolver
        vm.expectRevert(IDisputeManager.NotAuthorizedResolver.selector);
        disputeManager.resolve(MSG_HASH_1, true);
    }

    function test_resolve_notDisputed() public {
        vm.prank(resolver);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeManager.DisputeNotFound.selector, MSG_HASH_1)
        );
        disputeManager.resolve(MSG_HASH_1, true);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EXPIRED DISPUTE TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_claimExpiredDispute_success() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        uint256 bobBalanceBefore = bob.balance;

        // Move past resolution deadline (7 days)
        vm.warp(block.timestamp + 8 days);

        disputeManager.claimExpiredDispute(MSG_HASH_1);

        // Challenger wins by default
        assertEq(bob.balance, bobBalanceBefore + 0.01 ether);
    }

    function test_claimExpiredDispute_deadlineNotReached() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        vm.prank(bob);
        disputeManager.challenge{ value: 0.01 ether }(MSG_HASH_1, "evidence");

        vm.expectRevert(
            abi.encodeWithSelector(IDisputeManager.DeadlineNotReached.selector, MSG_HASH_1)
        );
        disputeManager.claimExpiredDispute(MSG_HASH_1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_challengeWindow() public view {
        assertEq(disputeManager.challengeWindow(), 24 hours);
    }

    function test_challengeStake() public view {
        assertEq(disputeManager.challengeStake(), 0.01 ether);
    }

    function test_isChallengeWindowOpen() public {
        exposureRecord.setExposed(MSG_HASH_1, alice);

        assertTrue(disputeManager.isChallengeWindowOpen(MSG_HASH_1));

        vm.warp(block.timestamp + 25 hours);

        assertFalse(disputeManager.isChallengeWindowOpen(MSG_HASH_1));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_setChallengeWindow() public {
        disputeManager.setChallengeWindow(1 hours);
        assertEq(disputeManager.challengeWindow(), 1 hours);
    }

    function test_setChallengeStake() public {
        disputeManager.setChallengeStake(0.1 ether);
        assertEq(disputeManager.challengeStake(), 0.1 ether);
    }

    function test_addResolver() public {
        address newResolver = address(0x4);
        disputeManager.addResolver(newResolver);
        assertTrue(disputeManager.authorizedResolvers(newResolver));
    }

    function test_removeResolver() public {
        disputeManager.removeResolver(resolver);
        assertFalse(disputeManager.authorizedResolvers(resolver));
    }
}
