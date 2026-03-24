// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISocialBlobsCore } from "../interfaces/ISocialBlobsCore.sol";
import { IRegistrationHook } from "../interfaces/IRegistrationHook.sol";

/// @title SocialBlobsCore
/// @notice Core contract for Social-Blobs protocol - Stateless "Dumb Inbox" pattern
/// @dev Zero storage contract that only emits events for data registration.
///      All state is derived from events. Registration verification is handled
///      by IRegistrationVerifier implementations in the application layer.
///      An optional IRegistrationHook can be set at deploy time to atomically
///      notify external contracts (e.g., SimpleBoolVerifier) on registration.
///      When hook is address(0), no external call is made (zero overhead).
contract SocialBlobsCore is ISocialBlobsCore {
    /// @dev Optional hook called after registration. Immutable — set once at deploy.
    IRegistrationHook public immutable hook;

    /// @param hook_ Address of IRegistrationHook, or address(0) to disable
    constructor(address hook_) {
        hook = IRegistrationHook(hook_);
    }

    /// @inheritdoc ISocialBlobsCore
    function registerBlob(uint256 blobIndex) external returns (bytes32 versionedHash) {
        if (blobIndex >= 6) revert InvalidBlobIndex(blobIndex);
        assembly {
            versionedHash := blobhash(blobIndex)
        }
        if (versionedHash == bytes32(0)) revert InvalidBlobIndex(blobIndex);
        emit BlobRegistered(versionedHash, msg.sender, uint64(block.timestamp));
        if (address(hook) != address(0)) hook.onRegistered(versionedHash, msg.sender);
    }

    /// @inheritdoc ISocialBlobsCore
    function registerCalldata(bytes calldata batchData) external returns (bytes32 contentHash) {
        contentHash = keccak256(batchData);
        emit CalldataRegistered(contentHash, msg.sender, uint64(block.timestamp), batchData.length);
        if (address(hook) != address(0)) hook.onRegistered(contentHash, msg.sender);
    }
}
