// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BPEDictionary
/// @notice Holds a 12-bit BPE dictionary (10240 bytes) on-chain as a code-only
///         data contract, so multiple BPEDecoders can share one dictionary.
/// @dev Dictionary layout (contiguous, tier boundaries fixed):
///        codes [   0..1024)   4-byte tokens at offset code*4
///        codes [1024..2048)   3-byte tokens at offset 4096 + (code-1024)*3
///        codes [2048..3072)   2-byte tokens at offset 7168 + (code-2048)*2
///        codes [3072..4096)   1-byte tokens at offset 9216 + (code-3072)
///
///      The dictionary bytes are deployed once as a code-only contract whose
///      runtime is `0x00 || dictBytes`. The leading STOP keeps the contract from
///      being callable; consumers use EXTCODECOPY at offset 1 to read the dict.
contract BPEDictionary {
    uint256 public constant DICT_SIZE = 10_240;

    /// @notice Address of the data contract holding the 10240 dictionary bytes.
    /// @dev    Runtime bytecode is `0x00 || dictBytes` (10241 bytes total).
    ///         Read via `EXTCODECOPY(dataAddr, dst, 1, 10240)`.
    address public immutable DICT_DATA;

    /// @notice Caller-supplied identity tag (e.g. keccak256(corpus) or a label).
    /// @dev    Not interpreted on-chain; lets indexers and registries pin a
    ///         specific dictionary by content rather than only by address.
    bytes32 public immutable IDENTITY;

    error InvalidDictSize(uint256 got, uint256 expected);
    error DataDeployFailed();

    /// @param dictBytes The 10240-byte dictionary table (see contract docstring).
    /// @param identity  Caller-supplied tag for this dictionary; opaque on-chain.
    constructor(bytes memory dictBytes, bytes32 identity) {
        if (dictBytes.length != DICT_SIZE) revert InvalidDictSize(dictBytes.length, DICT_SIZE);
        DICT_DATA = _deployData(dictBytes);
        IDENTITY = identity;
    }

    /// @notice Copy the dictionary into memory and return it.
    /// @dev    Convenience for off-chain readers and tests. On-chain decoders
    ///         typically EXTCODECOPY directly against `DICT_DATA` to avoid the
    ///         extra call and the bytes-memory length prefix.
    function readDict() external view returns (bytes memory dict) {
        address loc = DICT_DATA;
        dict = new bytes(DICT_SIZE);
        assembly {
            extcodecopy(loc, add(dict, 0x20), 1, 10240)
        }
    }

    /// @dev Deploys `data` as a code-only contract. Runtime = `0x00 || data`.
    function _deployData(bytes memory data) internal returns (address loc) {
        // Init code layout (14-byte preamble, then 1-byte STOP, then <data>):
        //   off  bytes        op
        //   00   61 ss ss     PUSH2 <runtime_size>
        //   03   60 0e        PUSH1 0x0e
        //   05   60 00        PUSH1 0x00
        //   07   39           CODECOPY
        //   08   61 ss ss     PUSH2 <runtime_size>
        //   0b   60 00        PUSH1 0x00
        //   0d   f3           RETURN
        //   0e   00           STOP (first runtime byte; keeps data non-callable)
        //   0f   <data>
        uint256 size = data.length + 1;
        bytes memory initCode = abi.encodePacked(
            hex"61",
            uint16(size),
            hex"600e600039",
            hex"61",
            uint16(size),
            hex"6000f3",
            hex"00",
            data
        );
        assembly {
            loc := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (loc == address(0)) revert DataDeployFailed();
    }
}
