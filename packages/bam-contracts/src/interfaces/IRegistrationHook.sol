// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRegistrationHook
/// @notice Optional hook called by SocialBlobsCore after registration.
/// @dev Allows atomic registration in external contracts (e.g., SimpleBoolVerifier).
///      When the core's hook is address(0), no call is made (zero overhead).
interface IRegistrationHook {
    /// @notice Called after a blob or calldata batch is registered
    /// @param contentHash Versioned hash (blob) or keccak256 hash (calldata)
    /// @param submitter Address that called registerBlob/registerCalldata
    function onRegistered(bytes32 contentHash, address submitter) external;
}
