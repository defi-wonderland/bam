// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { BPEDictionary } from "../src/decoders/BPEDictionary.sol";
import { BPEDecoder } from "../src/decoders/BPEDecoder.sol";

/// @title DeployBPEDecoder
/// @notice Deploys one BPEDictionary and two BPEDecoder instances (BLS aggregate
///         and ECDSA per-message) sharing it. Designed for Sepolia but
///         network-agnostic.
///
/// Usage:
///   PRIVATE_KEY=0x...                            \
///   DICT_PATH=../bam-sdk/tests/vectors/decoder-bpe/dict.bin  \  # optional, this is the default
///   forge script script/DeployBPEDecoder.s.sol:DeployBPEDecoder \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
///
/// Outputs (via console2.log):
///   - BPEDictionary address + IDENTITY (keccak256 of dict bytes)
///   - BPEDecoder (BLS aggregate, sigUnit=256) address
///   - BPEDecoder (ECDSA per-message, sigUnit=65) address
///
/// After broadcast, copy the addresses into deployments/<chainId>.json.
contract DeployBPEDecoder is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        string memory dictPath =
            vm.envOr("DICT_PATH", string("../bam-sdk/tests/vectors/decoder-bpe/dict.bin"));
        bytes memory dictBytes = vm.readFileBinary(dictPath);
        bytes32 identity = keccak256(dictBytes);

        console2.log("Deployer:", deployer);
        console2.log("Dict path:", dictPath);
        console2.log("Dict bytes:", dictBytes.length);
        console2.logBytes32(identity);

        vm.startBroadcast(deployerPrivateKey);

        BPEDictionary dict = new BPEDictionary(dictBytes, identity);
        BPEDecoder agg = new BPEDecoder(dict, 256, false);
        BPEDecoder pm = new BPEDecoder(dict, 65, true);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== BPE Deployment ===");
        console2.log("BPEDictionary:", address(dict));
        console2.log("  DICT_DATA:  ", dict.DICT_DATA());
        console2.log("BPEDecoder (BLS aggregate, sigUnit=256):", address(agg));
        console2.log("BPEDecoder (ECDSA per-message, sigUnit=65):", address(pm));
        console2.log("");
        console2.log("Paste these into deployments/<chainId>.json under \"contracts\".");
    }
}
