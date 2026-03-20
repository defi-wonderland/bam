// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";

/// @title IExposureRecord
/// @notice Interface for storing exposed tweet records
/// @dev Permissionless peripheral contract that records exposure metadata.
///      Can be called by any exposer contract (BLSExposer, STARKExposer, etc.)
interface IExposureRecord {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when an exposure is recorded
    /// @param messageHash Hash of the exposed message
    /// @param batchId ID of the batch containing the message
    /// @param author Author's Ethereum address
    /// @param exposedBy Address that recorded the exposure (typically an exposer contract)
    event ExposureRecorded(
        bytes32 indexed messageHash,
        uint256 indexed batchId,
        address indexed author,
        address exposedBy
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when exposure is already recorded
    error ExposureAlreadyRecorded(bytes32 messageHash);

    // ═══════════════════════════════════════════════════════════════════════════════
    // RECORDING
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Record an exposure
    /// @dev Permissionless - can be called by any exposer contract
    /// @param messageHash Hash of the exposed message
    /// @param batchId ID of the batch containing the message
    /// @param author Author's Ethereum address
    /// @param contentHash keccak256 hash of message content
    /// @param timestamp Original message timestamp
    function record(
        bytes32 messageHash,
        uint256 batchId,
        address author,
        bytes32 contentHash,
        uint64 timestamp
    ) external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Check if a message has been exposed
    /// @param messageHash Hash of the message
    /// @return exposed True if message has been exposed
    function isExposed(bytes32 messageHash) external view returns (bool exposed);

    /// @notice Get exposure details
    /// @param messageHash Hash of the message
    /// @return exposure The exposure record
    function getExposure(bytes32 messageHash)
        external
        view
        returns (SocialBlobsTypes.ExposedTweet memory exposure);
}
