// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";

import { ABIDecoder } from "../src/decoders/ABIDecoder.sol";

/// @title DeployABIDecoder
/// @notice One-shot deploy of `ABIDecoder`, the ERC-8180 reference
///         implementation of `IERC_BAM_Decoder` for the
///         `abi.encode(Message[], bytes signatureData)` payload shape.
///
///         `ABIDecoder` is stateless, view-only, and has no constructor args,
///         owner, or admin. Once deployed it is immutable bytecode — there is
///         no separate `register` step (decoders are submitter-named on
///         `BlobBatchRegistered`, not registered with a dispatcher).
///
/// Usage:
///   forge script script/DeployABIDecoder.s.sol:DeployABIDecoder \
///       --rpc-url $SEPOLIA_RPC_URL \
///       --broadcast \
///       --verify \
///       --sig "run()"
///
/// Env:
///   PRIVATE_KEY — deployer private key.
contract DeployABIDecoder is Script {
    ABIDecoder public decoder;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        _deploy(deployerPrivateKey);
    }

    /// @notice Test-friendly entrypoint that takes an explicit deployer key.
    function runWith(uint256 deployerPrivateKey) external {
        _deploy(deployerPrivateKey);
    }

    function _deploy(uint256 deployerPrivateKey) internal {
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying ABIDecoder (ERC-8180 reference IERC_BAM_Decoder)...");
        console2.log("Deployer:         ", deployer);
        console2.log("Deployer balance: ", deployer.balance);

        vm.startBroadcast(deployerPrivateKey);
        decoder = new ABIDecoder();
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployment Summary ===");
        console2.log("ABIDecoder:       ", address(decoder));
        console2.log("");
        console2.log("Paste the address into:");
        console2.log("  - packages/bam-contracts/deployments/<chainId>.json (ABIDecoder)");
        console2.log("  - then run: npx tsx scripts/sync-deployments.ts");
    }
}
