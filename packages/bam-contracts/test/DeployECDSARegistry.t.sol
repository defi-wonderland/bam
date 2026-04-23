// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, Vm } from "forge-std/Test.sol";

import { DeployECDSARegistry } from "../script/DeployECDSARegistry.s.sol";
import { ECDSARegistry } from "../src/core/ECDSARegistry.sol";
import { ISignatureRegistry } from "../src/interfaces/ISignatureRegistry.sol";
import { SignatureRegistryDispatcher } from "../src/core/SignatureRegistryDispatcher.sol";

/// @title DeployECDSARegistryTest
/// @notice Exercises the deploy-and-register script in-process (no fork
///         required). Asserts the post-deploy invariant that the dispatcher's
///         scheme-0x01 slot points at the newly-deployed registry and that
///         exactly one `SchemeRegistered(0x01, ...)` event fires in the
///         deploy window, plus the fail-fast behavior when the slot is
///         already claimed.
contract DeployECDSARegistryTest is Test {
    SignatureRegistryDispatcher internal dispatcher;
    DeployECDSARegistry internal script;

    uint256 internal deployerKey;
    address internal deployer;

    function setUp() public {
        dispatcher = new SignatureRegistryDispatcher();
        script = new DeployECDSARegistry();
        (deployer, deployerKey) = makeAddrAndKey("deployer");
        vm.deal(deployer, 10 ether);
    }

    function test_deploy_populatesDispatcherSlot() public {
        vm.recordLogs();
        script.runWith(address(dispatcher), deployerKey);

        ECDSARegistry reg = script.registry();
        assertTrue(address(reg) != address(0), "registry not deployed");
        assertEq(
            address(dispatcher.registries(0x01)),
            address(reg),
            "dispatcher slot 0x01 must point at the new registry"
        );

        // Exactly one SchemeRegistered(0x01, ...) event must fire.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("SchemeRegistered(uint8,address,string,address)");
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length >= 3 && logs[i].topics[0] == topic) {
                assertEq(
                    uint256(logs[i].topics[1]), uint256(0x01), "scheme id topic mismatch"
                );
                assertEq(
                    address(uint160(uint256(logs[i].topics[2]))),
                    address(reg),
                    "registry address topic mismatch"
                );
                count++;
            }
        }
        assertEq(count, 1, "expected exactly one SchemeRegistered event");
    }

    function test_deploy_revertsIfSlotPreclaimed() public {
        // Simulate a griefer front-running the slot with a rogue registry.
        ECDSARegistry rogue = new ECDSARegistry();
        dispatcher.registerScheme(0x01, ISignatureRegistry(address(rogue)));

        vm.expectRevert();
        script.runWith(address(dispatcher), deployerKey);
    }
}
