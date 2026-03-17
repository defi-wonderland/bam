// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { SimpleBoolVerifier } from "../src/verifiers/SimpleBoolVerifier.sol";

/// @title SimpleBoolVerifierTest
/// @notice Tests for SimpleBoolVerifier contract
contract SimpleBoolVerifierTest is Test {
    SimpleBoolVerifier public verifier;

    bytes32 public constant HASH_1 = keccak256("blob1");
    bytes32 public constant HASH_2 = keccak256("blob2");

    function setUp() public {
        verifier = new SimpleBoolVerifier();
    }

    function test_register_setsFlag() public {
        assertFalse(verifier.isRegistered(HASH_1));

        verifier.register(HASH_1);

        assertTrue(verifier.isRegistered(HASH_1));
    }

    function test_register_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit SimpleBoolVerifier.Registered(HASH_1);

        verifier.register(HASH_1);
    }

    function test_verifyRegistration_registered() public {
        verifier.register(HASH_1);

        assertTrue(verifier.verifyRegistration(address(0), HASH_1, ""));
    }

    function test_verifyRegistration_notRegistered() public view {
        assertFalse(verifier.verifyRegistration(address(0), HASH_1, ""));
    }

    function test_isRegistered_convenience() public {
        assertFalse(verifier.isRegistered(HASH_1));
        assertFalse(verifier.isRegistered(HASH_2));

        verifier.register(HASH_1);

        assertTrue(verifier.isRegistered(HASH_1));
        assertFalse(verifier.isRegistered(HASH_2));
    }

    function test_register_duplicateNoop() public {
        verifier.register(HASH_1);
        assertTrue(verifier.isRegistered(HASH_1));

        // Registering again is fine (no revert, no state change)
        verifier.register(HASH_1);
        assertTrue(verifier.isRegistered(HASH_1));
    }

    function test_verifyRegistration_ignoresCoreAddressAndProof() public {
        verifier.register(HASH_1);

        // Different core addresses and proof data should not matter
        assertTrue(verifier.verifyRegistration(address(1), HASH_1, ""));
        assertTrue(verifier.verifyRegistration(address(2), HASH_1, hex"deadbeef"));
        assertTrue(verifier.verifyRegistration(address(0), HASH_1, hex"ff"));
    }

    function test_register_multipleHashes() public {
        verifier.register(HASH_1);
        verifier.register(HASH_2);

        assertTrue(verifier.isRegistered(HASH_1));
        assertTrue(verifier.isRegistered(HASH_2));
    }
}
