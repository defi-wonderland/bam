// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IExposureRecord } from "../interfaces/IExposureRecord.sol";
import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";

/// @title ExposureRecord
/// @notice Records metadata about exposed tweets
/// @dev Permissionless peripheral contract that stores exposure data.
///      Can be called by any exposer contract (BLSExposer, STARKExposer, etc.)
contract ExposureRecord is IExposureRecord {
    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Mapping from message hash to exposure record
    mapping(bytes32 => SocialBlobsTypes.ExposedTweet) private _exposures;

    /// @dev Array of all exposed message hashes
    bytes32[] private _exposedHashes;

    /// @dev Mapping from author to their exposed message hashes
    mapping(address => bytes32[]) private _authorExposures;

    // ═══════════════════════════════════════════════════════════════════════════════
    // RECORDING
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IExposureRecord
    function record(
        bytes32 messageHash,
        uint256,
        address author,
        bytes32 contentHash,
        uint64 timestamp
    ) external {
        // Check not already recorded
        if (_exposures[messageHash].exposedAt > 0) revert ExposureAlreadyRecorded(messageHash);

        // Store exposure record
        // Note: msg.sender is the exposer contract (e.g., BLSExposer)
        _exposures[messageHash] = SocialBlobsTypes.ExposedTweet({
            contentHash: bytes32(0),
            author: author,
            messageContentHash: contentHash,
            timestamp: timestamp,
            exposedAt: uint64(block.timestamp),
            exposedBy: msg.sender
        });

        _exposedHashes.push(messageHash);
        _authorExposures[author].push(messageHash);

        emit ExposureRecorded(messageHash, 0, author, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IExposureRecord
    function isExposed(bytes32 messageHash) external view returns (bool exposed) {
        return _exposures[messageHash].exposedAt > 0;
    }

    /// @inheritdoc IExposureRecord
    function getExposure(bytes32 messageHash)
        external
        view
        returns (SocialBlobsTypes.ExposedTweet memory exposure)
    {
        exposure = _exposures[messageHash];
        require(exposure.exposedAt > 0, "Not exposed");
    }

    /// @notice Get all exposed message hashes
    /// @return hashes Array of message hashes
    function getAllExposures() external view returns (bytes32[] memory hashes) {
        return _exposedHashes;
    }

    /// @notice Get exposure count
    /// @return count Total number of exposed messages
    function exposureCount() external view returns (uint256 count) {
        return _exposedHashes.length;
    }

    /// @notice Get exposures by author
    /// @param author Author address
    /// @return hashes Array of message hashes exposed by author
    function getExposuresByAuthor(address author) external view returns (bytes32[] memory hashes) {
        return _authorExposures[author];
    }

    /// @notice Get exposure count by author
    /// @param author Author address
    /// @return count Number of messages exposed by author
    function exposureCountByAuthor(address author) external view returns (uint256 count) {
        return _authorExposures[author].length;
    }
}
