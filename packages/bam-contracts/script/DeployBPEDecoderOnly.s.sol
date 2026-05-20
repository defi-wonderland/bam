// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { BPEDictionary } from "../src/decoders/BPEDictionary.sol";
import { BPEDecoder } from "../src/decoders/BPEDecoder.sol";

/// @title DeployBPEDecoderOnly
/// @notice Deploys two fresh BPEDecoder instances (BLS aggregate, ECDSA per-message)
///         pointing at an already-deployed BPEDictionary. Use this when only the
///         decoder logic changes -- the on-chain dict bytes (~10 KB) are large
///         enough that re-deploying them is wasted gas.
///
/// Usage:
///   PRIVATE_KEY=0x...                                              \
///   BPE_DICT_ADDRESS=0xddd...                                      \
///   forge script script/DeployBPEDecoderOnly.s.sol:DeployBPEDecoderOnly \
///     --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
contract DeployBPEDecoderOnly is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address dictAddress = vm.envAddress("BPE_DICT_ADDRESS");

        BPEDictionary dict = BPEDictionary(dictAddress);
        bytes32 identity = dict.IDENTITY();
        uint256 dictSize = dict.DICT_SIZE();

        console2.log("Deployer:", deployer);
        console2.log("BPEDictionary:", dictAddress);
        console2.log("  DICT_DATA:  ", dict.DICT_DATA());
        console2.log("  DICT_SIZE:  ", dictSize);
        console2.logBytes32(identity);

        vm.startBroadcast(deployerPrivateKey);

        BPEDecoder agg = new BPEDecoder(dict, 256, false);
        BPEDecoder pm = new BPEDecoder(dict, 65, true);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== BPE Decoder Re-deploy ===");
        console2.log("BPEDecoder (BLS aggregate, sigUnit=256):", address(agg));
        console2.log("BPEDecoder (ECDSA per-message, sigUnit=65):", address(pm));
        console2.log("");
        console2.log("Update these in deployments/<chainId>.json under \"contracts\".");
    }
}
