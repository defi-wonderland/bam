// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";

/// @title IBLSExposer
/// @notice Interface for exposing tweets with BLS signature verification
/// @dev Application-layer contract that handles exposure logic for BLS-signed messages.
///      Uses IRegistrationVerifier for pluggable registration verification.
interface IBLSExposer {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a tweet is exposed on-chain
    /// @param contentHash Content hash (versioned hash for blob, keccak256 for calldata)
    /// @param messageHash keccak256 hash of the message
    /// @param author Author's Ethereum address
    /// @param exposer Address that called expose
    /// @param timestamp Block timestamp when exposed
    event TweetExposed(
        bytes32 indexed contentHash,
        bytes32 indexed messageHash,
        address indexed author,
        address exposer,
        uint64 timestamp
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when content hash is not verified as registered
    error NotRegistered(bytes32 contentHash);

    /// @notice Thrown when KZG verification fails
    error KZGVerificationFailed();

    /// @notice Thrown when BLS signature verification fails
    error BLSVerificationFailed();

    /// @notice Thrown when extracted bytes don't match provided message
    error MessageMismatch();

    /// @notice Thrown when author is not registered in BLS registry
    error AuthorNotRegistered(address author);

    /// @notice Thrown when message has already been exposed
    error AlreadyExposed(bytes32 messageHash);

    // ═══════════════════════════════════════════════════════════════════════════════
    // EXPOSURE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Expose a tweet from a blob with KZG + BLS verification
    /// @param params Exposure parameters including versioned hash, proofs, message, signature
    /// @return messageHash Hash of the exposed message
    function expose(SocialBlobsTypes.ExposureParams calldata params)
        external
        returns (bytes32 messageHash);

    /// @notice Expose a tweet from a calldata batch
    /// @param params Calldata exposure parameters
    /// @return messageHash Hash of the exposed message
    function exposeFromCalldata(SocialBlobsTypes.CalldataExposureParams calldata params)
        external
        returns (bytes32 messageHash);

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Check if a message has been exposed through this exposer
    /// @param messageHash Hash of the message
    /// @return exposed True if message has been exposed
    function isExposed(bytes32 messageHash) external view returns (bool exposed);

    /// @notice Get the Core contract address
    /// @return coreAddress Address of SocialBlobsCore
    function core() external view returns (address coreAddress);

    /// @notice Get the BLS registry address
    /// @return registryAddress Address of BLSRegistry
    function blsRegistry() external view returns (address registryAddress);

    /// @notice Get the registration verifier address
    /// @return verifierAddress Address of IRegistrationVerifier
    function registrationVerifier() external view returns (address verifierAddress);

    /// @notice Get the exposure record address
    /// @return recordAddress Address of ExposureRecord (or address(0) if disabled)
    function exposureRecord() external view returns (address recordAddress);
}
