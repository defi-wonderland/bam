// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";

/// @title IDictionaryRegistry
/// @notice Interface for compression dictionary registry
/// @dev Stores known compression dictionaries for blob decompression
interface IDictionaryRegistry {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a dictionary is registered
    /// @param contentHash keccak256 hash of dictionary bytes
    /// @param ipfsCid IPFS CID for retrieval
    /// @param registeredBy Address that registered the dictionary
    event DictionaryRegistered(
        bytes32 indexed contentHash, string ipfsCid, address indexed registeredBy
    );

    /// @notice Emitted when a dictionary is deactivated
    /// @param contentHash keccak256 hash of dictionary bytes
    /// @param deactivatedBy Address that deactivated the dictionary
    event DictionaryDeactivated(bytes32 indexed contentHash, address indexed deactivatedBy);

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when dictionary is already registered
    error DictionaryAlreadyRegistered(bytes32 contentHash);

    /// @notice Thrown when dictionary is not found
    error DictionaryNotFound(bytes32 contentHash);

    /// @notice Thrown when dictionary is already deactivated
    error DictionaryAlreadyDeactivated(bytes32 contentHash);

    /// @notice Thrown when content hash is zero
    error InvalidContentHash();

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Register a new dictionary
    /// @param contentHash keccak256 hash of dictionary bytes
    /// @param ipfsCid IPFS CID for dictionary retrieval
    function register(bytes32 contentHash, string calldata ipfsCid) external;

    /// @notice Deactivate a dictionary (governance)
    /// @param contentHash keccak256 hash of dictionary bytes
    function deactivate(bytes32 contentHash) external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Check if a dictionary is known and active
    /// @param contentHash keccak256 hash of dictionary bytes
    /// @return known True if dictionary is registered and active
    function isKnown(bytes32 contentHash) external view returns (bool known);

    /// @notice Get dictionary details
    /// @param contentHash keccak256 hash of dictionary bytes
    /// @return dictionary The dictionary record
    function getDictionary(bytes32 contentHash)
        external
        view
        returns (SocialBlobsTypes.Dictionary memory dictionary);
}
