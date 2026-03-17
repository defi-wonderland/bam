// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IDictionaryRegistry } from "../interfaces/IDictionaryRegistry.sol";
import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DictionaryRegistry
/// @notice Registry for compression dictionaries used in blob decompression
/// @dev Stores dictionary metadata; actual dictionary data is stored off-chain (IPFS)
contract DictionaryRegistry is IDictionaryRegistry, Ownable {
    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Mapping from content hash to dictionary record
    mapping(bytes32 => SocialBlobsTypes.Dictionary) private _dictionaries;

    /// @dev Array of all registered dictionary hashes
    bytes32[] private _registeredHashes;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    constructor(address owner_) Ownable(owner_) { }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IDictionaryRegistry
    function register(bytes32 contentHash, string calldata ipfsCid) external {
        if (contentHash == bytes32(0)) revert InvalidContentHash();

        SocialBlobsTypes.Dictionary storage dict = _dictionaries[contentHash];

        // Check if already registered (registeredAt > 0)
        if (dict.registeredAt > 0) revert DictionaryAlreadyRegistered(contentHash);

        // Store dictionary record
        dict.contentHash = contentHash;
        dict.ipfsCid = ipfsCid;
        dict.registeredAt = uint64(block.timestamp);
        dict.active = true;

        _registeredHashes.push(contentHash);

        emit DictionaryRegistered(contentHash, ipfsCid, msg.sender);
    }

    /// @inheritdoc IDictionaryRegistry
    function deactivate(bytes32 contentHash) external onlyOwner {
        SocialBlobsTypes.Dictionary storage dict = _dictionaries[contentHash];

        if (dict.registeredAt == 0) revert DictionaryNotFound(contentHash);
        if (!dict.active) revert DictionaryAlreadyDeactivated(contentHash);

        dict.active = false;

        emit DictionaryDeactivated(contentHash, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IDictionaryRegistry
    function isKnown(bytes32 contentHash) external view returns (bool known) {
        SocialBlobsTypes.Dictionary storage dict = _dictionaries[contentHash];
        return dict.registeredAt > 0 && dict.active;
    }

    /// @inheritdoc IDictionaryRegistry
    function getDictionary(bytes32 contentHash)
        external
        view
        returns (SocialBlobsTypes.Dictionary memory dictionary)
    {
        dictionary = _dictionaries[contentHash];
        if (dictionary.registeredAt == 0) revert DictionaryNotFound(contentHash);
    }

    /// @notice Get all registered dictionary hashes
    /// @return hashes Array of content hashes
    function getAllDictionaries() external view returns (bytes32[] memory hashes) {
        return _registeredHashes;
    }

    /// @notice Get count of registered dictionaries
    /// @return count Total number of registered dictionaries
    function dictionaryCount() external view returns (uint256 count) {
        return _registeredHashes.length;
    }

    /// @notice Get count of active dictionaries
    /// @return count Number of active dictionaries
    function activeDictionaryCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < _registeredHashes.length; i++) {
            if (_dictionaries[_registeredHashes[i]].active) count++;
        }
    }
}
