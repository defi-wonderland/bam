// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { SimpleBoolVerifier } from "../src/verifiers/SimpleBoolVerifier.sol";

/// @title SimpleBoolVerifierTest
/// @notice Tests for SimpleBoolVerifier contract
contract SimpleBoolVerifierTest is Test {
    SimpleBoolVerifier public verifier;

    address public coreAddr = address(0xC0DE);
    address public attacker = address(0xBAD);

    bytes32 public constant HASH_1 = keccak256("blob1");
    bytes32 public constant HASH_2 = keccak256("blob2");

    function setUp() public {
        verifier = new SimpleBoolVerifier();
        verifier.setCore(coreAddr);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // setCore
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setCore_setsAddress() public view {
        assertEq(verifier.core(), coreAddr);
    }

    function test_setCore_emitsEvent() public {
        SimpleBoolVerifier fresh = new SimpleBoolVerifier();
        vm.expectEmit(true, false, false, false);
        emit SimpleBoolVerifier.CoreSet(coreAddr);
        fresh.setCore(coreAddr);
    }

    function test_setCore_revertsIfAlreadySet() public {
        vm.expectRevert(SimpleBoolVerifier.CoreAlreadySet.selector);
        verifier.setCore(address(0x999));
    }

    function test_setCore_revertsIfNotDeployer() public {
        SimpleBoolVerifier fresh = new SimpleBoolVerifier();
        vm.prank(attacker);
        vm.expectRevert(SimpleBoolVerifier.OnlyDeployer.selector);
        fresh.setCore(coreAddr);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // onRegistered (access control)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onRegistered_fromCore_setsFlag() public {
        assertFalse(verifier.isRegistered(HASH_1));

        vm.prank(coreAddr);
        verifier.onRegistered(HASH_1, address(0x1));

        assertTrue(verifier.isRegistered(HASH_1));
    }

    function test_onRegistered_fromCore_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit SimpleBoolVerifier.Registered(HASH_1);

        vm.prank(coreAddr);
        verifier.onRegistered(HASH_1, address(0x1));
    }

    function test_onRegistered_revertsIfNotCore() public {
        vm.prank(attacker);
        vm.expectRevert(SimpleBoolVerifier.OnlyCore.selector);
        verifier.onRegistered(HASH_1, attacker);
    }

    function test_onRegistered_multipleHashes() public {
        vm.startPrank(coreAddr);
        verifier.onRegistered(HASH_1, address(0x1));
        verifier.onRegistered(HASH_2, address(0x2));
        vm.stopPrank();

        assertTrue(verifier.isRegistered(HASH_1));
        assertTrue(verifier.isRegistered(HASH_2));
    }

    function test_onRegistered_duplicateNoop() public {
        vm.startPrank(coreAddr);
        verifier.onRegistered(HASH_1, address(0x1));
        assertTrue(verifier.isRegistered(HASH_1));

        // Registering again is fine (no revert, no state change)
        verifier.onRegistered(HASH_1, address(0x1));
        assertTrue(verifier.isRegistered(HASH_1));
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // verifyRegistration
    // ═══════════════════════════════════════════════════════════════════════════

    function test_verifyRegistration_registered() public {
        vm.prank(coreAddr);
        verifier.onRegistered(HASH_1, address(0x1));

        assertTrue(verifier.verifyRegistration(address(0), HASH_1, ""));
    }

    function test_verifyRegistration_notRegistered() public view {
        assertFalse(verifier.verifyRegistration(address(0), HASH_1, ""));
    }

    function test_verifyRegistration_ignoresCoreAddressAndProof() public {
        vm.prank(coreAddr);
        verifier.onRegistered(HASH_1, address(0x1));

        // Different core addresses and proof data should not matter
        assertTrue(verifier.verifyRegistration(address(1), HASH_1, ""));
        assertTrue(verifier.verifyRegistration(address(2), HASH_1, hex"deadbeef"));
        assertTrue(verifier.verifyRegistration(address(0), HASH_1, hex"ff"));
    }
}
