// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";

import { ECDSARegistry } from "../src/core/ECDSARegistry.sol";
import { ISignatureRegistry } from "../src/interfaces/ISignatureRegistry.sol";
import { SignatureRegistryDispatcher } from "../src/core/SignatureRegistryDispatcher.sol";

/// @title DeployECDSARegistry
/// @notice Deploy-and-register script for the ERC-8180 scheme-0x01 ECDSA
///         registry. Deploys `ECDSARegistry` and registers it with the
///         `SignatureRegistryDispatcher`.
///
///         `SignatureRegistryDispatcher.registerScheme` is permissionless and
///         first-come-first-served, so `vm.startBroadcast` does NOT make the
///         two txs atomic: another account could still claim the `0x01` slot
///         between the deploy and the register tx. To keep the slot from being
///         griefed (red-team C-7), submit through a private mempool / bundler
///         (e.g. Flashbots) or otherwise hide the txs from the public mempool.
///         The script also fails fast if `0x01` is already claimed, and
///         asserts the post-condition after broadcast.
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

        // Fail fast if the 0x01 slot is already claimed — avoids a wasted
        // deployment tx when the scheme has been registered by someone else.
        // This does not prevent a mempool race; for that, submit the deploy
        // and register txs via a private mempool / bundler.
        require(
            !dispatcher.isSchemeRegistered(SCHEME_ID_ECDSA),
            "DeployECDSARegistry: scheme 0x01 already registered"
        );

        vm.startBroadcast(deployerPrivateKey);

        registry = new ECDSARegistry();
        dispatcher.registerScheme(SCHEME_ID_ECDSA, ISignatureRegistry(address(registry)));

        vm.stopBroadcast();

        // Post-condition: confirm we actually own the slot after broadcast.
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
