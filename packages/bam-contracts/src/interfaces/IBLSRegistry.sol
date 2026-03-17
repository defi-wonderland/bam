// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISignatureRegistry } from "./ISignatureRegistry.sol";

/// @title IBLSRegistry
/// @notice Interface for BLS public key registry
/// @dev Maps Ethereum addresses to BLS12-381 public keys for signature aggregation
///      BLS public keys are 48 bytes (compressed G1 points)
///      Extends ISignatureRegistry for signature extensibility system
interface IBLSRegistry is ISignatureRegistry {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS (BLS-specific, KeyRegistered inherited from ISignatureRegistry)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a BLS public key is rotated
    /// @param owner The Ethereum address that owns this key
    /// @param oldPubKey The previous BLS public key
    /// @param newPubKey The new BLS public key
    /// @param index The registry index (unchanged)
    event KeyRotated(address indexed owner, bytes oldPubKey, bytes newPubKey, uint256 index);

    /// @notice Emitted when a key is revoked
    /// @param owner The Ethereum address that owned this key
    /// @param blsPubKey The revoked BLS public key
    /// @param index The registry index (now invalid)
    event KeyRevoked(address indexed owner, bytes blsPubKey, uint256 index);

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS (BLS-specific, common errors inherited from ISignatureRegistry)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when registry index is invalid
    error InvalidIndex(uint256 index);

    /// @notice Thrown when key has been revoked
    error KeyIsRevoked();

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Register a new BLS public key with proof of possession
    /// @dev Proof of possession prevents rogue key attacks
    /// @param blsPubKey The 48-byte BLS public key (compressed G1 point)
    /// @param popSignature Proof of possession signature (96 bytes, G2 point)
    /// @return index The assigned registry index
    function register(bytes calldata blsPubKey, bytes calldata popSignature)
        external
        returns (uint256 index);

    /// @notice Rotate to a new BLS public key
    /// @dev Preserves the existing registry index
    /// @param newBlsPubKey The new 48-byte BLS public key
    /// @param popSignature Proof of possession for the new key
    function rotate(bytes calldata newBlsPubKey, bytes calldata popSignature) external;

    /// @notice Revoke the registered BLS key
    /// @dev Marks the key and index as invalid. Cannot be undone.
    function revoke() external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Get the BLS public key for an address
    /// @param owner The Ethereum address
    /// @return blsPubKey The registered BLS public key (empty if not registered)
    function getKey(address owner) external view returns (bytes memory blsPubKey);

    /// @notice Get the BLS public key by registry index
    /// @param index The registry index
    /// @return blsPubKey The registered BLS public key
    /// @return owner The owner address
    function getKeyByIndex(uint256 index)
        external
        view
        returns (bytes memory blsPubKey, address owner);

    /// @notice Get the registry index for an address
    /// @param owner The Ethereum address
    /// @return index The registry index (0 if not registered)
    function getIndex(address owner) external view returns (uint256 index);

    /// @notice Check if an address has a registered key
    /// @param owner The Ethereum address
    /// @return registered True if the address has a registered, non-revoked key
    function isRegistered(address owner) external view returns (bool registered);

    /// @notice Get total number of registered keys
    /// @return count Total registered keys (including revoked)
    function totalRegistered() external view returns (uint256 count);
}
