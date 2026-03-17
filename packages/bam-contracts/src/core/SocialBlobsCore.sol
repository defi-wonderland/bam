// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISocialBlobsCore } from "../interfaces/ISocialBlobsCore.sol";

/// @title SocialBlobsCore
/// @notice Core contract for Social-Blobs protocol - Stateless "Dumb Inbox" pattern
/// @dev Zero storage contract that only emits events for data registration.
///      All state is derived from events. Registration verification is handled
///      by IRegistrationVerifier implementations in the application layer.
contract SocialBlobsCore is ISocialBlobsCore {
    /// @inheritdoc ISocialBlobsCore
    function registerBlob(uint256 blobIndex) external returns (bytes32 versionedHash) {
        if (blobIndex >= 6) revert InvalidBlobIndex(blobIndex);
        assembly {
            versionedHash := blobhash(blobIndex)
        }
        if (versionedHash == bytes32(0)) revert InvalidBlobIndex(blobIndex);
        emit BlobRegistered(versionedHash, msg.sender, uint64(block.timestamp));
    }

    /// @inheritdoc ISocialBlobsCore
    function registerCalldata(bytes calldata batchData) external returns (bytes32 contentHash) {
        contentHash = keccak256(batchData);
        emit CalldataRegistered(contentHash, msg.sender, uint64(block.timestamp), batchData.length);
    }
}
