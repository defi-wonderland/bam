// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ABIDecoder } from "../src/decoders/ABIDecoder.sol";
import { IERC_BAM_Decoder } from "../src/interfaces/IERC_BAM_Decoder.sol";

/// @title ABIDecoderRoundtripTest
/// @notice Hermetic JS↔Solidity parity for the v1 ABI batch shape.
/// @dev Loads JSON fixtures emitted by `packages/bam-sdk/tests/vectors/codec-abi/_generate.mjs`,
///      asks `ABIDecoder.decode` to chew through `expectedBytes`, and asserts the
///      returned `(messages, signatureData)` matches the same input the JS test
///      consumes. Single source of truth — JS test and this test read the same
///      files. No live RPC. C-5's treatment.
contract ABIDecoderRoundtripTest is Test {
    ABIDecoder public decoder;

    uint256 internal constant SIG_LEN = 65;

    function setUp() public {
        decoder = new ABIDecoder();
    }

    function _runFixture(string memory name) internal view {
        string memory path = string.concat("../bam-sdk/tests/vectors/codec-abi/", name, ".json");
        string memory json = vm.readFile(path);

        bytes memory expectedBytes = vm.parseJsonBytes(json, ".expectedBytes");
        uint256 messageCount = vm.parseJsonUint(json, ".messageCount");

        (IERC_BAM_Decoder.Message[] memory messages, bytes memory signatureData) =
            decoder.decode(expectedBytes);

        assertEq(messages.length, messageCount, "decoded message count");
        assertEq(
            signatureData.length, messageCount * SIG_LEN, "decoded signatureData length"
        );

        for (uint256 i = 0; i < messageCount; i++) {
            string memory mBase = string.concat(".messages[", vm.toString(i), "]");
            address expSender = vm.parseJsonAddress(json, string.concat(mBase, ".sender"));
            // Nonce is serialised as a decimal string so BigInt round-trips through JSON.
            uint64 expNonce =
                uint64(vm.parseUint(vm.parseJsonString(json, string.concat(mBase, ".nonce"))));
            bytes memory expContents =
                vm.parseJsonBytes(json, string.concat(mBase, ".contents"));

            assertEq(messages[i].sender, expSender, "message sender");
            assertEq(messages[i].nonce, expNonce, "message nonce");
            assertEq(messages[i].contents, expContents, "message contents");

            bytes memory expSig = vm.parseJsonBytes(
                json, string.concat(".signatures[", vm.toString(i), "]")
            );
            assertEq(expSig.length, SIG_LEN, "fixture signature length");
            for (uint256 j = 0; j < SIG_LEN; j++) {
                assertEq(
                    signatureData[i * SIG_LEN + j],
                    expSig[j],
                    "signatureData byte does not match per-message slice"
                );
            }
        }
    }

    function test_roundtrip_empty() public view {
        _runFixture("empty");
    }

    function test_roundtrip_oneMessage() public view {
        _runFixture("one-message");
    }

    function test_roundtrip_fourMessages() public view {
        _runFixture("four-messages");
    }

    function test_roundtrip_twoFiftySixMessages() public view {
        _runFixture("two-fifty-six-messages");
    }
}
