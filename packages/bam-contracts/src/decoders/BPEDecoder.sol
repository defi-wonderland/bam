// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC_BAM_Decoder } from "../interfaces/IERC_BAM_Decoder.sol";
import { BPEDictionary } from "./BPEDictionary.sol";

/// @title BPEDecoder
/// @notice IERC_BAM_Decoder that reads a 12-bit BPE dictionary from an external
///         BPEDictionary contract and returns decompressed message contents to
///         consumers. Solidity port of vbuterin/SocialBlobs decoder.vy.
/// @dev Payload wire format (matches the upstream Vyper decoder):
///        [0..2)         N                 -- uint16 big-endian, number of messages
///        [2..2+2N)      offsets[0..N-1]   -- uint16 big-endian, per-message start
///        [2+2N..-S)     message bodies    -- sender(20) | nonce(8) | encoded_contents
///        [-S..]         signatureData     -- S bytes, S = perMessage ? unit*N : unit
///
///      The encoded_contents portion of each message is BPE-12 packed: two 12-bit
///      codes per 3-byte word, big-endian. Code 0 is treated as padding (no output),
///      matching the upstream Vyper decoder.
///
///      The dictionary lives in a separate `BPEDictionary` contract so multiple
///      decoders (different sig modes, different scheme registries) can share one
///      dictionary deployment. The decoder caches the dict's data-contract address
///      as an immutable to avoid a per-call external read.
///
///      EVM target: requires Cancun (EIP-5656 `mcopy`). Solc ^0.8.24 defaults to
///      cancun; pre-Cancun chains will revert at decode time.
contract BPEDecoder is IERC_BAM_Decoder {
    uint256 internal constant DICT_SIZE = 10_240;

    /// @notice The shared dictionary contract this decoder reads from.
    BPEDictionary public immutable DICT;

    /// @dev Cached address of the dictionary's data contract (DICT.DICT_DATA()).
    address internal immutable DICT_DATA;

    /// @notice Size of a single signature unit, in bytes.
    /// @dev    Aggregate mode (PER_MESSAGE=false): size of the entire trailer
    ///         (e.g. 256 for BLS over G2). Per-message mode (PER_MESSAGE=true):
    ///         size of each individual signature (e.g. 65 for ECDSA); trailer
    ///         length is SIG_UNIT_SIZE * N.
    uint256 public immutable SIG_UNIT_SIZE;

    /// @notice Whether `signatureData` is a parallel array of N per-message sigs.
    /// @dev    false = single aggregate (or registry-defined) blob of SIG_UNIT_SIZE bytes.
    ///         true  = N signatures of SIG_UNIT_SIZE bytes each, concatenated.
    bool public immutable PER_MESSAGE;

    error PayloadTooSmall(uint256 length, uint256 minimum);
    error OffsetsOverrun(uint256 messageCount, uint256 sigStart);
    /// @dev Carries raw start/end offsets (not their difference) so a malformed
    ///      payload with `endOff < startOff` doesn't underflow the diagnostic.
    error MessageBodyTooShort(uint256 i, uint256 startOff, uint256 endOff);
    error MessageBodyOverrun(uint256 i, uint256 endOff, uint256 sigStart);
    error EncodedNotAligned(uint256 length);

    /// @param dict         A deployed BPEDictionary contract.
    /// @param sigUnitSize  Aggregate mode: size of the whole trailer. Per-message
    ///                     mode: size of each individual signature.
    /// @param perMessage   true => trailer length is sigUnitSize * N; false => sigUnitSize.
    constructor(BPEDictionary dict, uint256 sigUnitSize, bool perMessage) {
        DICT = dict;
        DICT_DATA = dict.DICT_DATA();
        SIG_UNIT_SIZE = sigUnitSize;
        PER_MESSAGE = perMessage;
    }

    /// @inheritdoc IERC_BAM_Decoder
    function decode(bytes calldata payload)
        external
        view
        returns (Message[] memory messages, bytes memory signatureData)
    {
        uint256 plen = payload.length;
        if (plen == 0) return (new Message[](0), new bytes(0));

        if (plen < 2) revert PayloadTooSmall(plen, 2);
        uint256 n;
        assembly {
            n := shr(240, calldataload(payload.offset))
        }

        uint256 trailerLen = PER_MESSAGE ? SIG_UNIT_SIZE * n : SIG_UNIT_SIZE;
        if (plen < trailerLen + 2) revert PayloadTooSmall(plen, trailerLen + 2);

        uint256 sigStart = plen - trailerLen;
        if (2 + n * 2 > sigStart) revert OffsetsOverrun(n, sigStart);

        bytes memory dictBuf = _loadDict();
        messages = new Message[](n);

        for (uint256 i = 0; i < n; i++) {
            uint256 startOff;
            uint256 endOff;
            assembly {
                startOff := shr(240, calldataload(add(payload.offset, add(2, mul(i, 2)))))
            }
            if (i + 1 < n) {
                assembly {
                    endOff := shr(240, calldataload(add(payload.offset, add(2, mul(add(i, 1), 2)))))
                }
            } else {
                endOff = sigStart;
            }

            if (endOff < startOff + 28) revert MessageBodyTooShort(i, startOff, endOff);
            if (endOff > sigStart) revert MessageBodyOverrun(i, endOff, sigStart);

            address sender;
            uint64 nonce;
            assembly {
                sender := shr(96, calldataload(add(payload.offset, startOff)))
                nonce := shr(192, calldataload(add(payload.offset, add(startOff, 20))))
            }

            uint256 compLen = endOff - startOff - 28;
            bytes memory encoded = new bytes(compLen);
            assembly {
                calldatacopy(
                    add(encoded, 0x20),
                    add(payload.offset, add(startOff, 28)),
                    compLen
                )
            }

            messages[i] = Message({
                sender: sender,
                nonce: nonce,
                contents: _decompress(dictBuf, encoded)
            });
        }

        signatureData = new bytes(trailerLen);
        assembly {
            calldatacopy(add(signatureData, 0x20), add(payload.offset, sigStart), trailerLen)
        }
    }

    /// @notice Decompress a BPE-12 encoded byte string against the on-chain dictionary.
    /// @dev    Exposed for parity with the upstream Vyper decoder's `decompress()` helper
    ///         and for off-chain testing. Code 0 is treated as padding (no output).
    function decompress(bytes calldata encoded) external view returns (bytes memory) {
        bytes memory dictBuf = _loadDict();
        bytes memory enc = new bytes(encoded.length);
        assembly {
            calldatacopy(add(enc, 0x20), encoded.offset, encoded.length)
        }
        return _decompress(dictBuf, enc);
    }

    function _decompress(bytes memory dictBuf, bytes memory encoded)
        internal
        pure
        returns (bytes memory out)
    {
        uint256 elen = encoded.length;
        if (elen % 3 != 0) revert EncodedNotAligned(elen);

        // First pass: compute output length so we can allocate exactly.
        uint256 outLen = 0;
        for (uint256 i = 0; i < elen; i += 3) {
            uint256 word;
            assembly {
                word := shr(232, mload(add(add(encoded, 0x20), i)))
            }
            uint256 c1 = (word >> 12) & 0xfff;
            uint256 c2 = word & 0xfff;
            if (c1 != 0) outLen += _codeLength(c1);
            if (c2 != 0) outLen += _codeLength(c2);
        }

        out = new bytes(outLen);
        uint256 pos = 0;

        for (uint256 i = 0; i < elen; i += 3) {
            uint256 word;
            assembly {
                word := shr(232, mload(add(add(encoded, 0x20), i)))
            }
            uint256 c1 = (word >> 12) & 0xfff;
            uint256 c2 = word & 0xfff;

            if (c1 != 0) {
                (uint256 off, uint256 len) = _codeOffsetLen(c1);
                assembly {
                    mcopy(
                        add(add(out, 0x20), pos),
                        add(add(dictBuf, 0x20), off),
                        len
                    )
                }
                pos += len;
            }
            if (c2 != 0) {
                (uint256 off, uint256 len) = _codeOffsetLen(c2);
                assembly {
                    mcopy(
                        add(add(out, 0x20), pos),
                        add(add(dictBuf, 0x20), off),
                        len
                    )
                }
                pos += len;
            }
        }
    }

    function _codeLength(uint256 code) internal pure returns (uint256) {
        if (code < 1024) return 4;
        if (code < 2048) return 3;
        if (code < 3072) return 2;
        return 1;
    }

    function _codeOffsetLen(uint256 code) internal pure returns (uint256 off, uint256 len) {
        if (code < 1024) {
            off = code * 4;
            len = 4;
        } else if (code < 2048) {
            off = 4096 + (code - 1024) * 3;
            len = 3;
        } else if (code < 3072) {
            off = 7168 + (code - 2048) * 2;
            len = 2;
        } else {
            off = 9216 + (code - 3072);
            len = 1;
        }
    }

    function _loadDict() internal view returns (bytes memory dict) {
        address loc = DICT_DATA;
        dict = new bytes(DICT_SIZE);
        assembly {
            extcodecopy(loc, add(dict, 0x20), 1, DICT_SIZE)
        }
    }
}
