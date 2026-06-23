// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { BlobAuthenticatedMessagingCore } from "../src/core/BlobAuthenticatedMessagingCore.sol";
import { BLSRegistry } from "../src/core/BLSRegistry.sol";
import { SignatureRegistryDispatcher } from "../src/core/SignatureRegistryDispatcher.sol";
import { BLSExposer } from "../src/exposers/BLSExposer.sol";
import { DictionaryRegistry } from "../src/peripheral/DictionaryRegistry.sol";
import { ExposureRecord } from "../src/peripheral/ExposureRecord.sol";
import { DisputeManager } from "../src/peripheral/DisputeManager.sol";
import { StakeManager } from "../src/peripheral/StakeManager.sol";

/// @title DeployBam
/// @notice Deployment script for BAM protocol contracts
/// @dev Stateless BAM core + BLSExposer. Registration is proven off-chain from the
///      core's event log, so no on-chain registration verifier is deployed.
contract DeployBam is Script {
    // Deployment addresses
    BlobAuthenticatedMessagingCore public core;
    BLSRegistry public blsRegistry;
    BLSExposer public blsExposer;

    /// @notice Main deployment function
    function run() external {
        // Get deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying BAM contracts...");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy BAM core (zero-storage, events-only)
        core = new BlobAuthenticatedMessagingCore();
        console2.log("BlobAuthenticatedMessagingCore deployed at:", address(core));

        // 2. Deploy BLS Registry (permissionless)
        blsRegistry = new BLSRegistry();
        console2.log("BLSRegistry deployed at:", address(blsRegistry));

        // 3. Deploy BLSExposer (core, blsRegistry, exposureRecord)
        blsExposer = new BLSExposer(address(core), address(blsRegistry), address(0));
        console2.log("BLSExposer deployed at:", address(blsExposer));

        vm.stopBroadcast();

        // Log summary
        console2.log("");
        console2.log("=== Deployment Summary ===");
        console2.log("BlobAuthenticatedMessagingCore:", address(core));
        console2.log("BLSRegistry:", address(blsRegistry));
        console2.log("BLSExposer:", address(blsExposer));
        console2.log("");
        console2.log("All contracts are permissionless - no owner!");
    }

    /// @notice Deploy to a specific network with verification
    function deployWithVerification() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying with verification...");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        core = new BlobAuthenticatedMessagingCore();
        blsRegistry = new BLSRegistry();
        blsExposer = new BLSExposer(address(core), address(blsRegistry), address(0));

        vm.stopBroadcast();

        // Output addresses in a format suitable for verification
        console2.log("");
        console2.log("=== Contract Addresses ===");
        console2.log("BAM_CORE=%s", address(core));
        console2.log("BLS_REGISTRY=%s", address(blsRegistry));
        console2.log("BLS_EXPOSER=%s", address(blsExposer));
    }
}

/// @title DeployTestnet
/// @notice Deployment script specifically for testnets (Sepolia, Holesky)
contract DeployTestnet is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying to testnet...");
        console2.log("Chain ID:", block.chainid);
        console2.log("Deployer:", deployer);
        console2.log("Deployer balance:", deployer.balance);

        // Require minimum balance
        require(deployer.balance >= 0.1 ether, "Insufficient balance for deployment");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy all contracts (all permissionless)
        BlobAuthenticatedMessagingCore core = new BlobAuthenticatedMessagingCore();
        BLSRegistry blsRegistry = new BLSRegistry();
        BLSExposer blsExposer = new BLSExposer(address(core), address(blsRegistry), address(0));

        vm.stopBroadcast();

        // Log deployment info
        console2.log("");
        console2.log("=== Testnet Deployment Complete ===");
        console2.log("Network:", _getNetworkName());
        console2.log("BlobAuthenticatedMessagingCore:", address(core));
        console2.log("BLSRegistry:", address(blsRegistry));
        console2.log("BLSExposer:", address(blsExposer));
        console2.log("");
        console2.log("All contracts are permissionless!");
        console2.log("");
        console2.log("To verify contracts:");
        console2.log(
            "forge verify-contract", address(core), "BlobAuthenticatedMessagingCore --watch"
        );
    }

    function _getNetworkName() internal view returns (string memory) {
        if (block.chainid == 11_155_111) return "Sepolia";
        if (block.chainid == 17_000) return "Holesky";
        if (block.chainid == 1) return "Mainnet";
        return "Unknown";
    }
}

/// @title DeployFull
/// @notice Full deployment including all peripheral contracts
contract DeployFull is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("=== Full Protocol Deployment ===");
        console2.log("Chain ID:", block.chainid);
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Core contracts (all permissionless)
        BlobAuthenticatedMessagingCore core = new BlobAuthenticatedMessagingCore();
        BLSRegistry blsRegistry = new BLSRegistry();
        SignatureRegistryDispatcher sigDispatcher = new SignatureRegistryDispatcher();

        // Peripheral contracts
        DictionaryRegistry dictRegistry = new DictionaryRegistry(deployer);
        ExposureRecord exposureRecord = new ExposureRecord();

        // BLSExposer with ExposureRecord integration
        BLSExposer blsExposer =
            new BLSExposer(address(core), address(blsRegistry), address(exposureRecord));

        // Dispute and stake management (these still have owners for admin functions)
        DisputeManager disputeManager = new DisputeManager(address(exposureRecord), deployer);
        StakeManager stakeManager = new StakeManager(deployer);

        // Configure stake manager with dispute manager
        stakeManager.setDisputeManager(address(disputeManager));

        // Register BLS scheme in dispatcher (permissionless - anyone can do this)
        sigDispatcher.registerScheme(0x02, blsRegistry);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Core Contracts (Permissionless) ===");
        console2.log("BlobAuthenticatedMessagingCore:", address(core));
        console2.log("BLSRegistry:", address(blsRegistry));
        console2.log("SignatureRegistryDispatcher:", address(sigDispatcher));
        console2.log("");
        console2.log("=== Exposers ===");
        console2.log("BLSExposer:", address(blsExposer));
        console2.log("");
        console2.log("=== Peripheral Contracts ===");
        console2.log("DictionaryRegistry:", address(dictRegistry));
        console2.log("ExposureRecord:", address(exposureRecord));
        console2.log("DisputeManager:", address(disputeManager));
        console2.log("StakeManager:", address(stakeManager));
    }
}
