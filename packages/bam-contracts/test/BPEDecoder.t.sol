// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BPEDecoder } from "../src/decoders/BPEDecoder.sol";
import { BPEDictionary } from "../src/decoders/BPEDictionary.sol";
import { IERC_BAM_Decoder } from "../src/interfaces/IERC_BAM_Decoder.sol";

/// @title BPEDecoderTest
/// @notice Tests for the BPEDecoder against fixtures produced by
///         packages/bam-sdk/tests/vectors/decoder-bpe/_generate.mjs. Validates
///         wire-format and dictionary parity with the SDK encoder, in both
///         aggregate (BLS-style) and per-message (ECDSA-style) signature modes,
///         and the shared-dictionary deployment pattern.
contract BPEDecoderTest is Test {
    string internal constant FIXTURE_DIR = "../bam-sdk/tests/vectors/decoder-bpe/";

    BPEDictionary internal dict;

    function setUp() public {
        dict = new BPEDictionary(_loadDictBytes(), bytes32("test-dict"));
    }

    function _loadDictBytes() internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat(FIXTURE_DIR, "dict.bin"));
    }

    function _loadPayload(string memory name) internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat(FIXTURE_DIR, "payload-", name, ".bin"));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // AGGREGATE-MODE: SINGLE MESSAGE, BLS-SIZED TRAILER (256B)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_aggregate_single() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        bytes memory payload = _loadPayload("single");

        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(payload);

        assertEq(messages.length, 1);
        assertEq(messages[0].sender, address(bytes20(hex"111c27323d48535e69747f8a95a0abb6c1ccd7e2")));
        assertEq(messages[0].nonce, 1);
        assertEq(messages[0].contents, bytes("the quick brown fox"));
        assertEq(sigData.length, 256);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // AGGREGATE-MODE: THREE MESSAGES INCL. EMPTY CONTENTS AND MAX-NONCE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_aggregate_triple() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        bytes memory payload = _loadPayload("triple");

        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(payload);

        assertEq(messages.length, 3);

        assertEq(messages[0].sender, address(bytes20(hex"212c37424d58636e79848f9aa5b0bbc6d1dce7f2")));
        assertEq(messages[0].nonce, 1);
        assertEq(messages[0].contents, bytes("the quick brown fox jumps over the lazy dog"));

        assertEq(messages[1].sender, address(bytes20(hex"222d38434e59646f7a85909ba6b1bcc7d2dde8f3")));
        assertEq(messages[1].nonce, 2);
        assertEq(messages[1].contents.length, 0);

        assertEq(messages[2].sender, address(bytes20(hex"232e39444f5a65707b86919ca7b2bdc8d3dee9f4")));
        assertEq(messages[2].nonce, type(uint64).max);
        assertEq(messages[2].contents, bytes("sphinx of black quartz"));

        assertEq(sigData.length, 256);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PER-MESSAGE MODE: SINGLE ECDSA SIG (trailer = 65 * 1 = 65 B)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_perMessage_single() public {
        BPEDecoder decoder = new BPEDecoder(dict, 65, true);
        bytes memory payload = _loadPayload("ecdsa-single");

        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(payload);

        assertEq(messages.length, 1);
        assertEq(messages[0].sender, address(bytes20(hex"313c47525d68737e89949faab5c0cbd6e1ecf702")));
        assertEq(messages[0].nonce, 42);
        assertEq(messages[0].contents, bytes("hello world"));
        assertEq(sigData.length, 65);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PER-MESSAGE MODE: THREE ECDSA SIGS (trailer = 65 * 3 = 195 B)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_perMessage_triple() public {
        BPEDecoder decoder = new BPEDecoder(dict, 65, true);
        bytes memory payload = _loadPayload("ecdsa-triple");

        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(payload);

        assertEq(messages.length, 3);

        assertEq(messages[0].sender, address(bytes20(hex"515c67727d88939ea9b4bfcad5e0ebf6010c1722")));
        assertEq(messages[0].nonce, 10);
        assertEq(messages[0].contents, bytes("first"));

        assertEq(messages[1].sender, address(bytes20(hex"525d68737e89949faab5c0cbd6e1ecf7020d1823")));
        assertEq(messages[1].nonce, 11);
        assertEq(messages[1].contents, bytes("second message"));

        assertEq(messages[2].sender, address(bytes20(hex"535e69747f8a95a0abb6c1ccd7e2edf8030e1924")));
        assertEq(messages[2].nonce, 12);
        assertEq(messages[2].contents, bytes("third one here"));

        assertEq(sigData.length, 195);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SHARED DICTIONARY: two decoders (aggregate + per-message) against one dict.
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_sharedDict_twoDecoders() public {
        BPEDecoder aggDecoder = new BPEDecoder(dict, 256, false);
        BPEDecoder pmDecoder = new BPEDecoder(dict, 65, true);

        // Both decoders point at the same dictionary contract.
        assertEq(address(aggDecoder.DICT()), address(dict));
        assertEq(address(pmDecoder.DICT()), address(dict));

        // Aggregate path roundtrips.
        (IERC_BAM_Decoder.Message[] memory aMsgs,) = aggDecoder.decode(_loadPayload("single"));
        assertEq(aMsgs[0].contents, bytes("the quick brown fox"));

        // Per-message path roundtrips.
        (IERC_BAM_Decoder.Message[] memory pMsgs, bytes memory pSig) =
            pmDecoder.decode(_loadPayload("ecdsa-triple"));
        assertEq(pMsgs.length, 3);
        assertEq(pSig.length, 195);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FULL-BYTE SWEEP -- exercises 1-byte fallback tier for codes not in 4/3/2-tiers
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_byteSweep() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        bytes memory payload = _loadPayload("byte-sweep");

        (IERC_BAM_Decoder.Message[] memory messages,) = decoder.decode(payload);

        assertEq(messages.length, 1);
        assertEq(messages[0].nonce, 7);

        bytes memory expected = new bytes(256);
        for (uint256 i = 0; i < 256; i++) expected[i] = bytes1(uint8(i));
        assertEq(messages[0].contents, expected);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EMPTY PAYLOAD (both modes)
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_emptyPayload_aggregate() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(hex"");
        assertEq(messages.length, 0);
        assertEq(sigData.length, 0);
    }

    function test_decode_emptyPayload_perMessage() public {
        BPEDecoder decoder = new BPEDecoder(dict, 65, true);
        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(hex"");
        assertEq(messages.length, 0);
        assertEq(sigData.length, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ZERO-MESSAGE BATCH IN PER-MESSAGE MODE: trailer length = sigUnit * 0 = 0
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_decode_perMessage_zeroMessages() public {
        BPEDecoder decoder = new BPEDecoder(dict, 65, true);
        bytes memory payload = hex"0000";
        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = decoder.decode(payload);
        assertEq(messages.length, 0);
        assertEq(sigData.length, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // BPEDictionary: rejects wrong-size dict, exposes identity + readDict()
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_dictionary_rejectsBadSize() public {
        bytes memory bad = new bytes(100);
        vm.expectRevert(
            abi.encodeWithSelector(BPEDictionary.InvalidDictSize.selector, 100, 10_240)
        );
        new BPEDictionary(bad, bytes32(0));
    }

    function test_dictionary_identityAndReadDict() public {
        bytes32 tag = bytes32("v1");
        BPEDictionary d = new BPEDictionary(_loadDictBytes(), tag);
        assertEq(d.IDENTITY(), tag);
        assertEq(d.readDict(), _loadDictBytes());
    }

    function test_dictionary_dataContractIsNonCallable() public {
        address loc = dict.DICT_DATA();
        assertEq(loc.code.length, 10_241);
        assertEq(loc.code[0], bytes1(0x00));
        (bool ok,) = loc.call(hex"");
        assertTrue(ok);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NEGATIVE PATHS: malformed payloads should revert with typed errors
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_revert_payloadTooSmall_singleByte() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        // 1 byte: can't even read the uint16 N.
        vm.expectRevert(abi.encodeWithSelector(BPEDecoder.PayloadTooSmall.selector, 1, 2));
        decoder.decode(hex"00");
    }

    function test_revert_payloadTooSmall_aggregateMissingTrailer() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        // N=1 declared but payload has no room for the 256-byte aggregate trailer.
        bytes memory payload = hex"0001";
        vm.expectRevert(abi.encodeWithSelector(BPEDecoder.PayloadTooSmall.selector, 2, 258));
        decoder.decode(payload);
    }

    function test_revert_offsetsOverrun_perMessage() public {
        BPEDecoder decoder = new BPEDecoder(dict, 65, true);
        // N=2 (perMessage trailer = 130B), but payload is exactly N+trailer with no
        // room for the offset table -- offsets[2] would land inside the trailer.
        bytes memory payload = new bytes(2 + 130);
        payload[0] = 0x00;
        payload[1] = 0x02; // N = 2
        // Trailer bytes left as zeros; that's fine, the revert fires first.
        vm.expectRevert(abi.encodeWithSelector(BPEDecoder.OffsetsOverrun.selector, 2, 2));
        decoder.decode(payload);
    }

    function test_revert_messageBodyTooShort_endBeforeStart() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        // N=2 with offsets[0]=10, offsets[1]=4 (i.e. endOff < startOff for msg 0).
        // This is the path that previously underflowed when computing endOff-startOff.
        bytes memory payload = new bytes(2 + 4 + 256);
        payload[0] = 0x00;
        payload[1] = 0x02; // N
        payload[2] = 0x00;
        payload[3] = 0x0a; // offsets[0] = 10
        payload[4] = 0x00;
        payload[5] = 0x04; // offsets[1] = 4
        vm.expectRevert(
            abi.encodeWithSelector(BPEDecoder.MessageBodyTooShort.selector, uint256(0), uint256(10), uint256(4))
        );
        decoder.decode(payload);
    }

    function test_revert_messageBodyOverrun() public {
        // Use a small trailer (30 B) so we can craft a payload where msg 0's
        // endOff is past sigStart without first failing the "body too short" check.
        BPEDecoder decoder = new BPEDecoder(dict, 30, false);
        bytes memory payload = new bytes(80);
        payload[0] = 0x00;
        payload[1] = 0x02; // N = 2
        payload[2] = 0x00;
        payload[3] = 0x06; // offsets[0] = 6
        payload[4] = 0x00;
        payload[5] = 0x3c; // offsets[1] = 60 (msg 0's endOff). sigStart = 80 - 30 = 50.
        // body 0 length is 60-6 = 54 >= 28, so MessageBodyTooShort doesn't fire.
        vm.expectRevert(
            abi.encodeWithSelector(BPEDecoder.MessageBodyOverrun.selector, uint256(0), uint256(60), uint256(50))
        );
        decoder.decode(payload);
    }

    function test_revert_encodedNotAligned() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        // 1 message, 28-byte header + 1 byte of "encoded" content => not aligned to 3.
        // Layout: [N(2)][off(2)][sender(20)|nonce(8)|enc(1)][trailer(256)]
        bytes memory payload = new bytes(2 + 2 + 28 + 1 + 256);
        payload[0] = 0x00;
        payload[1] = 0x01; // N = 1
        payload[2] = 0x00;
        payload[3] = 0x04; // offsets[0] = 4
        // sender + nonce default to zero; encoded is 1 byte of zero.
        vm.expectRevert(abi.encodeWithSelector(BPEDecoder.EncodedNotAligned.selector, 1));
        decoder.decode(payload);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERFACE COMPLIANCE
    // ═══════════════════════════════════════════════════════════════════════════════

    function test_implementsIERC_BAM_Decoder() public {
        BPEDecoder decoder = new BPEDecoder(dict, 256, false);
        IERC_BAM_Decoder iface = IERC_BAM_Decoder(address(decoder));
        (IERC_BAM_Decoder.Message[] memory messages, bytes memory sigData) = iface.decode(hex"");
        assertEq(messages.length, 0);
        assertEq(sigData.length, 0);
    }
}
