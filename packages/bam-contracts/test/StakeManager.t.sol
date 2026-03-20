// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { StakeManager } from "../src/peripheral/StakeManager.sol";
import { IStakeManager } from "../src/interfaces/IStakeManager.sol";

/// @title StakeManagerTest
/// @notice Tests for StakeManager contract
/// @dev Updated for permissionless architecture - no hooks, use hasValidStake()
contract StakeManagerTest is Test {
    StakeManager public stakeManager;

    address public owner = address(this);
    address public disputeManagerAddr = address(0x200);
    address public alice = address(0x1);
    address public bob = address(0x2);

    bytes32 public constant MSG_HASH_1 = keccak256("message1");
    bytes32 public constant MSG_HASH_2 = keccak256("message2");

    function setUp() public {
        // StakeManager now only takes owner parameter (no core contract reference)
        stakeManager = new StakeManager(owner);
        stakeManager.setDisputeManager(disputeManagerAddr);

        // Fund test accounts
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DEPOSIT TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_deposit_success() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IStakeManager.StakeDeposited(MSG_HASH_1, alice, 0.01 ether);

        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        (address staker, uint256 amount, uint64 depositedAt) = stakeManager.getStake(MSG_HASH_1);
        assertEq(staker, alice);
        assertEq(amount, 0.01 ether);
        assertTrue(depositedAt > 0);
        assertTrue(stakeManager.isStakeActive(MSG_HASH_1));
    }

    function test_deposit_insufficientStake() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IStakeManager.InsufficientStake.selector, 0.01 ether, 0.005 ether
            )
        );
        stakeManager.deposit{ value: 0.005 ether }(MSG_HASH_1);
    }

    function test_deposit_alreadyExists() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeManager.StakeAlreadyExists.selector, MSG_HASH_1)
        );
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);
    }

    function test_deposit_multipleMessages() public {
        vm.startPrank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);
        stakeManager.deposit{ value: 0.02 ether }(MSG_HASH_2);
        vm.stopPrank();

        assertTrue(stakeManager.isStakeActive(MSG_HASH_1));
        assertTrue(stakeManager.isStakeActive(MSG_HASH_2));

        (, uint256 amount1,) = stakeManager.getStake(MSG_HASH_1);
        (, uint256 amount2,) = stakeManager.getStake(MSG_HASH_2);
        assertEq(amount1, 0.01 ether);
        assertEq(amount2, 0.02 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // WITHDRAWAL TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_withdraw_success() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        uint256 balanceBefore = alice.balance;

        // Move past withdrawal delay
        vm.warp(block.timestamp + 25 hours);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit IStakeManager.StakeWithdrawn(MSG_HASH_1, alice, 0.01 ether);

        stakeManager.withdraw(MSG_HASH_1);

        assertEq(alice.balance, balanceBefore + 0.01 ether);
        assertFalse(stakeManager.isStakeActive(MSG_HASH_1));
    }

    function test_withdraw_noStake() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStakeManager.NoStakeExists.selector, MSG_HASH_1));
        stakeManager.withdraw(MSG_HASH_1);
    }

    function test_withdraw_notOwner() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        vm.warp(block.timestamp + 25 hours);

        vm.prank(bob);
        vm.expectRevert(IStakeManager.NotAuthorized.selector);
        stakeManager.withdraw(MSG_HASH_1);
    }

    function test_withdraw_tooEarly() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeManager.WithdrawalNotAllowed.selector, MSG_HASH_1)
        );
        stakeManager.withdraw(MSG_HASH_1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SLASH TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_slash_success() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        uint256 bobBalanceBefore = bob.balance;

        vm.prank(disputeManagerAddr);
        vm.expectEmit(true, true, true, true);
        emit IStakeManager.StakeSlashed(MSG_HASH_1, alice, bob, 0.01 ether);

        stakeManager.slash(MSG_HASH_1, bob);

        assertEq(bob.balance, bobBalanceBefore + 0.01 ether);
        assertFalse(stakeManager.isStakeActive(MSG_HASH_1));
    }

    function test_slash_notDisputeManager() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        vm.prank(bob);
        vm.expectRevert(IStakeManager.NotAuthorized.selector);
        stakeManager.slash(MSG_HASH_1, bob);
    }

    function test_slash_noStake() public {
        vm.prank(disputeManagerAddr);
        vm.expectRevert(abi.encodeWithSelector(IStakeManager.NoStakeExists.selector, MSG_HASH_1));
        stakeManager.slash(MSG_HASH_1, bob);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // STAKE VALIDITY TESTS (For Exposer Wrappers)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_hasValidStake_true() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        assertTrue(stakeManager.hasValidStake(MSG_HASH_1, alice));
    }

    function test_hasValidStake_noStake() public {
        assertFalse(stakeManager.hasValidStake(MSG_HASH_1, alice));
    }

    function test_hasValidStake_wrongExposer() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        // Bob is not the staker
        assertFalse(stakeManager.hasValidStake(MSG_HASH_1, bob));
    }

    function test_hasValidStake_insufficientAmount() public {
        // First reduce stake requirement temporarily
        stakeManager.setExposureStake(0.001 ether);

        vm.prank(alice);
        stakeManager.deposit{ value: 0.001 ether }(MSG_HASH_1);

        // Then increase stake requirement
        stakeManager.setExposureStake(0.01 ether);

        // Stake is now insufficient
        assertFalse(stakeManager.hasValidStake(MSG_HASH_1, alice));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERY TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_exposureStake() public view {
        assertEq(stakeManager.exposureStake(), 0.01 ether);
    }

    function test_canWithdraw() public {
        vm.prank(alice);
        stakeManager.deposit{ value: 0.01 ether }(MSG_HASH_1);

        assertFalse(stakeManager.canWithdraw(MSG_HASH_1));

        vm.warp(block.timestamp + 25 hours);

        assertTrue(stakeManager.canWithdraw(MSG_HASH_1));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_setExposureStake() public {
        stakeManager.setExposureStake(0.1 ether);
        assertEq(stakeManager.exposureStake(), 0.1 ether);
    }

    function test_setDisputeManager() public {
        address newDM = address(0x300);
        stakeManager.setDisputeManager(newDM);
        assertEq(stakeManager.disputeManager(), newDM);
    }
}
