// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISocialBlobsCore
/// @notice Core interface for Social-Blobs protocol - Stateless "Dumb Inbox" pattern
/// @dev Minimal interface for registering data submissions (blobs and calldata).
///      Zero storage — events are the source of truth. Exposure logic, signature
///      verification, and registration verification are in the application layer.
interface ISocialBlobsCore {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a blob is registered
    /// @param versionedHash EIP-4844 versioned hash of the blob
    /// @param submitter Address that submitted the blob
    /// @param timestamp Block timestamp
    event BlobRegistered(
        bytes32 indexed versionedHash, address indexed submitter, uint64 timestamp
    );

    /// @notice Emitted when a calldata batch is registered (self-publication)
    /// @param contentHash keccak256 hash of the batch data
    /// @param submitter Address that submitted the batch
    /// @param timestamp Block timestamp
    /// @param dataLength Length of batch data in bytes
    event CalldataRegistered(
        bytes32 indexed contentHash, address indexed submitter, uint64 timestamp, uint256 dataLength
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when blob index is invalid
    error InvalidBlobIndex(uint256 index);

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Register a blob submission
    /// @dev Called by aggregators when submitting blob transactions.
    ///      Uses BLOBHASH opcode to get versioned hash. Permissionless.
    /// @param blobIndex Index of the blob in the transaction (0-5)
    /// @return versionedHash The EIP-4844 versioned hash
    function registerBlob(uint256 blobIndex) external returns (bytes32 versionedHash);

    /// @notice Register a batch submitted via calldata (self-publication)
    /// @dev Allows users to bypass aggregators by publishing batches directly.
    ///      Uses same batch format as blob batches. Permissionless.
    /// @param batchData The batch data (same format as blob content)
    /// @return contentHash keccak256 hash of the batch data
    function registerCalldata(bytes calldata batchData) external returns (bytes32 contentHash);
}
