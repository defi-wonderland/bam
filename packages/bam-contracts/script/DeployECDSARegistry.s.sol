// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";

import { ECDSARegistry } from "../src/core/ECDSARegistry.sol";
import { ISignatureRegistry } from "../src/interfaces/ISignatureRegistry.sol";
import { SignatureRegistryDispatcher } from "../src/core/SignatureRegistryDispatcher.sol";

/// @title DeployECDSARegistry
/// @notice Atomic deploy-and-register script for the ERC-8180 scheme-0x01
///         ECDSA registry. Deploys `ECDSARegistry` and registers it with the
///         `SignatureRegistryDispatcher` in a single broadcast window so that
///         a griefer cannot front-run the `0x01` slot (red-team C-7).
///
/// Usage:
///   forge script script/DeployECDSARegistry.s.sol:DeployECDSARegistry \
///       --rpc-url $SEPOLIA_RPC_URL \
///       --broadcast \
///       --verify \
///       --sig "run()"
///
/// Env:
///   DISPATCHER_ADDRESS — deployed SignatureRegistryDispatcher.
///   PRIVATE_KEY        — deployer private key.
contract DeployECDSARegistry is Script {
    uint8 public constant SCHEME_ID_ECDSA = 0x01;

    ECDSARegistry public registry;

    function run() external {
        address dispatcherAddr = vm.envAddress("DISPATCHER_ADDRESS");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        _deployAndRegister(dispatcherAddr, deployerPrivateKey);
    }

    /// @notice Test-friendly entrypoint that takes explicit args.
    function runWith(address dispatcherAddr, uint256 deployerPrivateKey) external {
        _deployAndRegister(dispatcherAddr, deployerPrivateKey);
    }

    function _deployAndRegister(address dispatcherAddr, uint256 deployerPrivateKey) internal {
        address deployer = vm.addr(deployerPrivateKey);
        SignatureRegistryDispatcher dispatcher = SignatureRegistryDispatcher(dispatcherAddr);

        console2.log("Deploying ECDSARegistry (ERC-8180 scheme 0x01)...");
        console2.log("Deployer:           ", deployer);
        console2.log("Dispatcher:         ", address(dispatcher));
        console2.log("Deployer balance:   ", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);

        registry = new ECDSARegistry();
        dispatcher.registerScheme(SCHEME_ID_ECDSA, ISignatureRegistry(address(registry)));

        vm.stopBroadcast();

        // Atomicity post-condition (red-team C-7).
        address claimed = address(dispatcher.registries(SCHEME_ID_ECDSA));
        require(claimed == address(registry), "DeployECDSARegistry: dispatcher slot mismatch");

        console2.log("");
        console2.log("=== Deployment Summary ===");
        console2.log("ECDSARegistry:      ", address(registry));
        console2.log("Scheme ID:          ", uint256(SCHEME_ID_ECDSA));
        console2.log("");
        console2.log("Paste the address into:");
        console2.log("  - packages/bam-sdk/src/contracts/deployments.ts (ecdsaRegistry)");
        console2.log("  - apps/message-in-a-blobble/.env.local (signatureRegistry config)");
    }
}
