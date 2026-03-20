// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC_BAM_SignatureRegistry } from "./IERC_BAM_SignatureRegistry.sol";

/// @title ISignatureRegistry
/// @notice Legacy alias — extends the standardized IERC_BAM_SignatureRegistry
/// @dev Kept for backward compatibility. New code should use IERC_BAM_SignatureRegistry directly.
///      Part of the signature extensibility system (SigType 11)
interface ISignatureRegistry is IERC_BAM_SignatureRegistry { }
