// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC_BAM_Decoder } from "../interfaces/IERC_BAM_Decoder.sol";

/// @title ABIDecoder
/// @notice Reference IERC_BAM_Decoder implementation using ABI encoding
/// @dev v1 decoder: payload is abi.encode(Message[] messages, bytes signatureData).
///      Simple and gas-transparent. Production decoders may use more compact encodings.
contract ABIDecoder is IERC_BAM_Decoder {
    /// @inheritdoc IERC_BAM_Decoder
    function decode(bytes calldata payload)
        external
        pure
        returns (Message[] memory messages, bytes memory signatureData)
    {
        if (payload.length == 0) return (new Message[](0), new bytes(0));

        (messages, signatureData) = abi.decode(payload, (Message[], bytes));
    }
}
