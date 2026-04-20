// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { BlobAuthenticatedMessagingCore } from "../src/core/BlobAuthenticatedMessagingCore.sol";

/// @title DeployBamCore
/// @notice Deploys the amended ERC-8180 `BlobAuthenticatedMessagingCore` at a new
///         address. Per red-team C-1 this is a fresh deployment, not an in-place
///         upgrade — pre-amendment event logs at any prior address remain intact.
///
/// Usage:
///   forge script script/DeployBamCore.s.sol:DeployBamCore \
///       --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
contract DeployBamCore is Script {
    BlobAuthenticatedMessagingCore public bamCore;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying BlobAuthenticatedMessagingCore (ERC-8180 amended)...");
        console2.log("Deployer:", deployer);
        console2.log("Deployer balance:", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);
        bamCore = new BlobAuthenticatedMessagingCore();
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Summary ===");
        console2.log("BlobAuthenticatedMessagingCore:", address(bamCore));
        console2.log("");
        console2.log("Paste the address into:");
        console2.log("  - packages/bam-sdk/src/contracts/deployments.ts");
        console2.log("  - apps/message-in-a-blobble/.env.local (NEXT_PUBLIC_BAM_CORE_ADDRESS)");
    }
}
