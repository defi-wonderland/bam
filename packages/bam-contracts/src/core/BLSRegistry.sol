// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBLSRegistry } from "../interfaces/IBLSRegistry.sol";
import { IERC_BAM_SignatureRegistry } from "../interfaces/IERC_BAM_SignatureRegistry.sol";
import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";
import { BLSVerifier } from "../libraries/BLSVerifier.sol";

/// @title BLSRegistry
/// @notice Registry for BLS public keys with proof of possession
/// @dev Maps Ethereum addresses to BLS12-381 public keys with proof of possession.
///      Implements IERC_BAM_SignatureRegistry via IBLSRegistry -> ISignatureRegistry chain.
contract BLSRegistry is IBLSRegistry {
    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when verifyAggregated is called (not supported by this registry)
    error AggregationNotSupported();

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Expected BLS public key length (48 bytes, compressed G1 point)
    uint256 public constant BLS_PUBKEY_LENGTH = 48;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Mapping from owner address to key record
    mapping(address => SocialBlobsTypes.BLSKeyRecord) private _keys;

    /// @dev Mapping from registry index to owner address
    mapping(uint256 => address) private _indexToOwner;

    /// @dev Next registry index to assign (starts at 1, 0 means unregistered)
    uint256 private _nextIndex = 1;

    /// @dev Domain separator for proof of possession
    bytes32 private immutable _domainSeparator;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    constructor() {
        _domainSeparator =
            keccak256(abi.encodePacked("SocialBlobs-BLS-PoP-v1", block.chainid, address(this)));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IBLSRegistry
    function register(bytes calldata blsPubKey, bytes calldata popSignature)
        external
        override
        returns (uint256 index)
    {
        // Check not already registered
        if (_keys[msg.sender].pubKey.length > 0) revert AlreadyRegistered(msg.sender);

        // Validate public key length
        if (blsPubKey.length != BLS_PUBKEY_LENGTH) revert InvalidPublicKey();

        // Validate public key is not zero
        if (_isZeroBytes(blsPubKey)) revert InvalidPublicKey();

        // Verify proof of possession
        bytes32 popMessage = _computePopMessage(msg.sender, blsPubKey);
        if (!_verifyPop(blsPubKey, popMessage, popSignature)) {
            revert InvalidProofOfPossession();
        }

        // Assign index
        index = _nextIndex++;

        // Store key record
        _keys[msg.sender] =
            SocialBlobsTypes.BLSKeyRecord({ pubKey: blsPubKey, index: index, revoked: false });

        // Store reverse mapping
        _indexToOwner[index] = msg.sender;

        emit KeyRegistered(msg.sender, blsPubKey, index);
    }

    /// @inheritdoc IBLSRegistry
    function rotate(bytes calldata newBlsPubKey, bytes calldata popSignature) external {
        SocialBlobsTypes.BLSKeyRecord storage record = _keys[msg.sender];

        // Check registered
        if (record.pubKey.length == 0) revert NotRegistered(msg.sender);

        // Check not revoked
        if (record.revoked) revert KeyIsRevoked();

        // Validate new public key length
        if (newBlsPubKey.length != BLS_PUBKEY_LENGTH) revert InvalidPublicKey();

        // Validate new public key is not zero
        if (_isZeroBytes(newBlsPubKey)) revert InvalidPublicKey();

        // Verify proof of possession for new key
        bytes32 popMessage = _computePopMessage(msg.sender, newBlsPubKey);
        if (!_verifyPop(newBlsPubKey, popMessage, popSignature)) {
            revert InvalidProofOfPossession();
        }

        // Store old key for event
        bytes memory oldPubKey = record.pubKey;

        // Update key
        record.pubKey = newBlsPubKey;

        emit KeyRotated(msg.sender, oldPubKey, newBlsPubKey, record.index);
    }

    /// @inheritdoc IBLSRegistry
    function revoke() external {
        SocialBlobsTypes.BLSKeyRecord storage record = _keys[msg.sender];

        // Check registered
        if (record.pubKey.length == 0) revert NotRegistered(msg.sender);

        // Check not already revoked
        if (record.revoked) revert KeyIsRevoked();

        // Mark as revoked
        record.revoked = true;

        emit KeyRevoked(msg.sender, record.pubKey, record.index);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IBLSRegistry
    function getKey(address owner) external view override returns (bytes memory blsPubKey) {
        SocialBlobsTypes.BLSKeyRecord storage record = _keys[owner];
        if (record.revoked) return new bytes(0);
        return record.pubKey;
    }

    /// @inheritdoc IBLSRegistry
    function getKeyByIndex(uint256 index)
        external
        view
        returns (bytes memory blsPubKey, address owner)
    {
        if (index == 0 || index >= _nextIndex) revert InvalidIndex(index);

        owner = _indexToOwner[index];
        SocialBlobsTypes.BLSKeyRecord storage record = _keys[owner];

        if (record.revoked) return (new bytes(0), owner);

        return (record.pubKey, owner);
    }

    /// @inheritdoc IBLSRegistry
    function getIndex(address owner) external view returns (uint256 index) {
        return _keys[owner].index;
    }

    /// @inheritdoc IBLSRegistry
    function isRegistered(address owner) external view override returns (bool registered) {
        SocialBlobsTypes.BLSKeyRecord storage record = _keys[owner];
        return record.pubKey.length > 0 && !record.revoked;
    }

    /// @inheritdoc IBLSRegistry
    function totalRegistered() external view returns (uint256 count) {
        return _nextIndex - 1;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ISignatureRegistry / IERC_BAM_SignatureRegistry IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function schemeId() external pure override returns (uint8 id) {
        return 0x02; // BLS12-381
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function schemeName() external pure override returns (string memory name) {
        return "BLS12-381";
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function pubKeySize() external pure override returns (uint256 size) {
        return BLS_PUBKEY_LENGTH; // 48 bytes
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function signatureSize() external pure override returns (uint256 size) {
        return 96; // Compressed G2 point
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function supportsAggregation() external pure override returns (bool supported) {
        return false;
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function verify(bytes calldata pubKey, bytes32 messageHash, bytes calldata signature)
        external
        view
        override
        returns (bool valid)
    {
        return BLSVerifier.verify(pubKey, messageHash, signature);
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function verifyWithRegisteredKey(address owner, bytes32 messageHash, bytes calldata signature)
        external
        view
        override
        returns (bool valid)
    {
        SocialBlobsTypes.BLSKeyRecord storage record = _keys[owner];
        if (record.pubKey.length == 0 || record.revoked) {
            revert IERC_BAM_SignatureRegistry.NotRegistered(owner);
        }
        return BLSVerifier.verify(record.pubKey, messageHash, signature);
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function verifyAggregated(
        bytes[] calldata pubKeys,
        bytes32[] calldata messageHashes,
        bytes calldata aggregatedSignature
    ) external view override returns (bool valid) {
        revert AggregationNotSupported();
    }

    /// @dev External wrapper for BLS verification (enables try/catch pattern)
    /// @param blsPubKey Public key
    /// @param messageHash Message hash
    /// @param signature Signature
    /// @return valid True if valid
    function verifyBLSExternal(
        bytes calldata blsPubKey,
        bytes32 messageHash,
        bytes calldata signature
    ) external view returns (bool valid) {
        return BLSVerifier.verify(blsPubKey, messageHash, signature);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Check if bytes are all zeros
    /// @param data Bytes to check
    /// @return isZero True if all bytes are zero
    function _isZeroBytes(bytes calldata data) internal pure returns (bool isZero) {
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] != 0) return false;
        }
        return true;
    }

    /// @dev Compute the proof of possession message
    /// @param owner Owner address
    /// @param blsPubKey BLS public key
    /// @return popMessage Hash to be signed for PoP
    function _computePopMessage(address owner, bytes calldata blsPubKey)
        internal
        view
        returns (bytes32 popMessage)
    {
        return keccak256(abi.encodePacked(_domainSeparator, owner, blsPubKey));
    }

    /// @dev Verify proof of possession signature
    /// @param blsPubKey Public key to verify
    /// @param popMessage Message that should be signed
    /// @param popSignature Signature to verify
    /// @return valid True if PoP is valid
    function _verifyPop(bytes calldata blsPubKey, bytes32 popMessage, bytes calldata popSignature)
        internal
        view
        returns (bool valid)
    {
        // Use BLSVerifier library
        // Note: This requires EIP-2537 precompiles or a fallback
        try this.verifyBLSExternal(blsPubKey, popMessage, popSignature) returns (bool result) {
            return result;
        } catch {
            // If precompiles not available, we could:
            // 1. Revert (strict mode)
            // 2. Accept any signature (testing mode - NOT FOR PRODUCTION)
            // For now, revert
            revert InvalidProofOfPossession();
        }
    }
}
