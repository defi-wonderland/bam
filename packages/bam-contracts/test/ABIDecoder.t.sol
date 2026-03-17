// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ABIDecoder } from "../src/decoders/ABIDecoder.sol";
import { IERC_BAM_Decoder } from "../src/interfaces/IERC_BAM_Decoder.sol";

/// @title ABIDecoderTest
/// @notice Tests for the ABIDecoder reference implementation
contract ABIDecoderTest is Test {
    ABIDecoder public decoder;

    function setUp() public {
        decoder = new ABIDecoder();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EMPTY PAYLOAD
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_emptyPayload() public view {
        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(hex"");

        assertEq(messages.length, 0);
        assertEq(sigData.length, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SINGLE MESSAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_singleMessage() public view {
        address sender = address(0xa11ce);
        uint64 nonce = 42;
        bytes memory contents = "hello world";
        bytes memory sigData = hex"aabbccdd";

        IERC_BAM_Decoder.Message[] memory msgs = new IERC_BAM_Decoder.Message[](1);
        msgs[0] = IERC_BAM_Decoder.Message({ sender: sender, nonce: nonce, contents: contents });

        bytes memory payload = abi.encode(msgs, sigData);

        (IERC_BAM_Decoder.Message[] memory decoded, bytes memory decodedSig) =
            decoder.decode(payload);

        assertEq(decoded.length, 1);
        assertEq(decoded[0].sender, sender);
        assertEq(decoded[0].nonce, nonce);
        assertEq(decoded[0].contents, contents);
        assertEq(decodedSig, sigData);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MULTI MESSAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_multipleMessages() public view {
        IERC_BAM_Decoder.Message[] memory msgs = new IERC_BAM_Decoder.Message[](3);
        msgs[0] =
            IERC_BAM_Decoder.Message({ sender: address(0x1), nonce: 0, contents: "first message" });
        msgs[1] = IERC_BAM_Decoder.Message({
            sender: address(0x2), nonce: 1, contents: "second message"
        });
        msgs[2] = IERC_BAM_Decoder.Message({ sender: address(0x3), nonce: 100, contents: "third" });

        bytes memory sigData = hex"deadbeefcafebabe";
        bytes memory payload = abi.encode(msgs, sigData);

        (IERC_BAM_Decoder.Message[] memory decoded, bytes memory decodedSig) =
            decoder.decode(payload);

        assertEq(decoded.length, 3);

        assertEq(decoded[0].sender, address(0x1));
        assertEq(decoded[0].nonce, 0);
        assertEq(decoded[0].contents, hex"6669727374206d657373616765"); // "first message"

        assertEq(decoded[1].sender, address(0x2));
        assertEq(decoded[1].nonce, 1);

        assertEq(decoded[2].sender, address(0x3));
        assertEq(decoded[2].nonce, 100);
        assertEq(decoded[2].contents, "third");

        assertEq(decodedSig, sigData);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DETERMINISM
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_deterministic() public view {
        IERC_BAM_Decoder.Message[] memory msgs = new IERC_BAM_Decoder.Message[](1);
        msgs[0] = IERC_BAM_Decoder.Message({ sender: address(0xbeef), nonce: 7, contents: "test" });
        bytes memory sigData = hex"ff";
        bytes memory payload = abi.encode(msgs, sigData);

        (IERC_BAM_Decoder.Message[] memory d1, bytes memory s1) = decoder.decode(payload);
        (IERC_BAM_Decoder.Message[] memory d2, bytes memory s2) = decoder.decode(payload);

        assertEq(d1.length, d2.length);
        assertEq(d1[0].sender, d2[0].sender);
        assertEq(d1[0].nonce, d2[0].nonce);
        assertEq(d1[0].contents, d2[0].contents);
        assertEq(s1, s2);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EMPTY SIGNATURE DATA
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_emptySignatureData() public view {
        IERC_BAM_Decoder.Message[] memory msgs = new IERC_BAM_Decoder.Message[](1);
        msgs[0] = IERC_BAM_Decoder.Message({ sender: address(0x1), nonce: 0, contents: "unsigned" });
        bytes memory sigData = hex"";
        bytes memory payload = abi.encode(msgs, sigData);

        (IERC_BAM_Decoder.Message[] memory decoded, bytes memory decodedSig) =
            decoder.decode(payload);

        assertEq(decoded.length, 1);
        assertEq(decoded[0].contents, "unsigned");
        assertEq(decodedSig.length, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EMPTY CONTENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_emptyContents() public view {
        IERC_BAM_Decoder.Message[] memory msgs = new IERC_BAM_Decoder.Message[](1);
        msgs[0] = IERC_BAM_Decoder.Message({ sender: address(0x1), nonce: 0, contents: hex"" });
        bytes memory sigData = hex"aabb";
        bytes memory payload = abi.encode(msgs, sigData);

        (IERC_BAM_Decoder.Message[] memory decoded,) = decoder.decode(payload);

        assertEq(decoded.length, 1);
        assertEq(decoded[0].contents.length, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════════

    function testFuzz_decode_singleMessage(
        address sender,
        uint64 nonce,
        bytes calldata contents,
        bytes calldata sigBytes
    ) public view {
        IERC_BAM_Decoder.Message[] memory msgs = new IERC_BAM_Decoder.Message[](1);
        msgs[0] = IERC_BAM_Decoder.Message({ sender: sender, nonce: nonce, contents: contents });

        bytes memory payload = abi.encode(msgs, sigBytes);

        (IERC_BAM_Decoder.Message[] memory decoded, bytes memory decodedSig) =
            decoder.decode(payload);

        assertEq(decoded.length, 1);
        assertEq(decoded[0].sender, sender);
        assertEq(decoded[0].nonce, nonce);
        assertEq(decoded[0].contents, contents);
        assertEq(decodedSig, sigBytes);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERFACE COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_implementsIERC_BAM_Decoder() public view {
        IERC_BAM_Decoder iface = IERC_BAM_Decoder(address(decoder));
        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = iface.decode(hex"");
        assertEq(messages.length, 0);
        assertEq(sigData.length, 0);
    }
}
