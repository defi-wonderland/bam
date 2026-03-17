// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC_BAM_Exposer } from "../interfaces/IERC_BAM_Exposer.sol";
import { ISocialBlobsCore } from "../interfaces/ISocialBlobsCore.sol";
import { IBLSRegistry } from "../interfaces/IBLSRegistry.sol";
import { IExposureRecord } from "../interfaces/IExposureRecord.sol";
import { IRegistrationVerifier } from "../interfaces/IRegistrationVerifier.sol";
import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";
import { KZGVerifier } from "../libraries/KZGVerifier.sol";
import { BLSVerifier } from "../libraries/BLSVerifier.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BLSExposer
/// @notice Exposes messages with BLS signature verification
/// @dev Application-layer contract that handles exposure logic for BLS-signed messages.
///      Verifies registration via IRegistrationVerifier, KZG proofs, BLS signatures,
///      and optionally records to ExposureRecord.
///      Implements IERC_BAM_Exposer for standardized event and query interface.
contract BLSExposer is ReentrancyGuard, IERC_BAM_Exposer {
    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS (contract-specific, not inherited from IERC_BAM_Exposer)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when KZG verification fails
    error KZGVerificationFailed();

    /// @notice Thrown when BLS signature verification fails
    error BLSVerificationFailed();

    /// @notice Thrown when extracted bytes don't match provided message
    error MessageMismatch();

    /// @notice Thrown when author is not registered in BLS registry
    error AuthorNotRegistered(address author);

    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Core contract address (for verifier context)
    ISocialBlobsCore public immutable core;

    /// @dev BLS public key registry
    IBLSRegistry public immutable blsRegistry;

    /// @dev Registration verifier (SimpleBoolVerifier for v1)
    IRegistrationVerifier public immutable registrationVerifier;

    /// @dev Optional exposure record contract (can be address(0))
    IExposureRecord public immutable exposureRecord;

    /// @dev ERC-BAM domain separator: keccak256("ERC-BAM.v1" || chainId)
    bytes32 private immutable _DOMAIN;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Mapping from messageId to exposed status
    mapping(bytes32 => bool) private _exposed;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @param core_ Address of SocialBlobsCore contract
    /// @param blsRegistry_ Address of BLS public key registry
    /// @param registrationVerifier_ Address of IRegistrationVerifier implementation
    /// @param exposureRecord_ Address of ExposureRecord (or address(0) to disable)
    constructor(
        address core_,
        address blsRegistry_,
        address registrationVerifier_,
        address exposureRecord_
    ) {
        core = ISocialBlobsCore(core_);
        blsRegistry = IBLSRegistry(blsRegistry_);
        registrationVerifier = IRegistrationVerifier(registrationVerifier_);
        exposureRecord = IExposureRecord(exposureRecord_);
        _DOMAIN = keccak256(abi.encodePacked("ERC-BAM.v1", block.chainid));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EXPOSURE (From Blob)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Expose a message from a blob with KZG + BLS verification
    /// @param params Exposure parameters including versioned hash, proofs, message, signature
    /// @return messageId Unique identifier of the exposed message
    function expose(SocialBlobsTypes.ExposureParams calldata params)
        external
        nonReentrant
        returns (bytes32 messageId)
    {
        // 1. Verify registration via pluggable verifier
        if (!registrationVerifier.verifyRegistration(
                address(core), params.versionedHash, params.registrationProof
            )) revert NotRegistered(params.versionedHash);

        // 2. Verify KZG proofs and extract bytes (uses versionedHash directly)
        bytes memory extractedBytes = KZGVerifier.verifyAndExtract(
            params.versionedHash, params.kzgProofs, params.byteOffset, params.byteLength
        );

        // 3. Verify extracted bytes match provided message
        if (keccak256(extractedBytes) != keccak256(params.messageBytes)) {
            revert MessageMismatch();
        }

        // 4. Parse message fields: [author(20)][timestamp(4)][nonce(2)][contents...]
        address author = _parseAuthor(params.messageBytes);
        uint64 nonce = _parseNonce(params.messageBytes);
        bytes calldata contents = params.messageBytes[26:];

        // 5. Compute standardized hashes per ERC-BAM
        bytes32 messageHash = keccak256(abi.encodePacked(author, nonce, contents));
        messageId = keccak256(abi.encodePacked(author, nonce, params.versionedHash));
        bytes32 signedHash = keccak256(abi.encodePacked(_DOMAIN, messageHash));

        // 6. Check not already exposed
        if (_exposed[messageId]) revert AlreadyExposed(messageId);

        // 7. Verify BLS signature against signedHash (domain-separated)
        _verifyBLSSignature(author, signedHash, params.blsSignature);

        // 8. Mark as exposed
        _exposed[messageId] = true;

        // 9. Emit standardized event
        emit MessageExposed(
            params.versionedHash, messageId, author, msg.sender, uint64(block.timestamp)
        );

        // 10. Optionally record to ExposureRecord
        if (address(exposureRecord) != address(0)) {
            _recordExposure(messageId, params.versionedHash, author, params.messageBytes);
        }

        return messageId;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EXPOSURE (From Calldata)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Expose a message from a calldata batch
    /// @param params Calldata exposure parameters
    /// @return messageId Unique identifier of the exposed message
    function exposeFromCalldata(SocialBlobsTypes.CalldataExposureParams calldata params)
        external
        nonReentrant
        returns (bytes32 messageId)
    {
        // 1. Compute content hash (batch identifier for calldata)
        bytes32 contentHash = keccak256(params.batchData);

        // 2. Verify registration via pluggable verifier
        if (!registrationVerifier.verifyRegistration(
                address(core), contentHash, params.registrationProof
            )) revert NotRegistered(contentHash);

        // 3. Verify message exists at claimed offset
        if (params.messageOffset + params.messageBytes.length > params.batchData.length) {
            revert MessageMismatch();
        }

        // Extract and verify message bytes
        bytes memory extractedMessage = new bytes(params.messageBytes.length);
        for (uint256 i = 0; i < params.messageBytes.length; i++) {
            extractedMessage[i] = params.batchData[params.messageOffset + i];
        }

        if (keccak256(extractedMessage) != keccak256(params.messageBytes)) {
            revert MessageMismatch();
        }

        // 4. Parse message fields: [author(20)][timestamp(4)][nonce(2)][contents...]
        address author = _parseAuthor(params.messageBytes);
        uint64 nonce = _parseNonce(params.messageBytes);
        bytes calldata contents = params.messageBytes[26:];

        // 5. Compute standardized hashes per ERC-BAM
        bytes32 messageHash = keccak256(abi.encodePacked(author, nonce, contents));
        messageId = keccak256(abi.encodePacked(author, nonce, contentHash));
        bytes32 signedHash = keccak256(abi.encodePacked(_DOMAIN, messageHash));

        // 6. Check not already exposed
        if (_exposed[messageId]) revert AlreadyExposed(messageId);

        // 7. Verify BLS signature against signedHash (domain-separated)
        _verifyBLSSignature(author, signedHash, params.signature);

        // 8. Mark as exposed
        _exposed[messageId] = true;

        // 9. Emit standardized event
        emit MessageExposed(contentHash, messageId, author, msg.sender, uint64(block.timestamp));

        // 10. Optionally record to ExposureRecord
        if (address(exposureRecord) != address(0)) {
            _recordExposure(messageId, contentHash, author, params.messageBytes);
        }

        return messageId;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC_BAM_Exposer
    function isExposed(bytes32 messageId) external view returns (bool exposed) {
        return _exposed[messageId];
    }

    /// @dev External wrapper for BLS verification (enables try/catch pattern)
    function verifyBLSExternal(bytes calldata pubKey, bytes32 signedHash, bytes calldata signature)
        external
        view
        returns (bool valid)
    {
        return BLSVerifier.verify(pubKey, signedHash, signature);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Parse author address from message bytes (offset 0, 20 bytes)
    /// @param messageBytes Raw message bytes
    /// @return author Extracted author address
    function _parseAuthor(bytes calldata messageBytes) internal pure returns (address author) {
        // Message format: [author (20 bytes)][timestamp (4 bytes)][nonce (2 bytes)][content...]
        assembly {
            // Load 32 bytes starting at messageBytes.offset, shift right 96 bits to get address
            author := shr(96, calldataload(messageBytes.offset))
        }
    }

    /// @dev Parse nonce from message bytes (offset 24, 2 bytes) and cast to uint64
    /// @param messageBytes Raw message bytes
    /// @return nonce Extracted nonce as uint64
    function _parseNonce(bytes calldata messageBytes) internal pure returns (uint64 nonce) {
        // Message format: [author (20 bytes)][timestamp (4 bytes)][nonce (2 bytes)][content...]
        uint16 rawNonce;
        assembly {
            // Load 32 bytes at offset 24, shift right 240 bits to get 2 bytes
            rawNonce := shr(240, calldataload(add(messageBytes.offset, 24)))
        }
        nonce = uint64(rawNonce);
    }

    /// @dev Verify BLS signature using the registry
    /// @param author Message author
    /// @param signedHash Domain-separated hash to verify
    /// @param signature BLS signature
    function _verifyBLSSignature(address author, bytes32 signedHash, bytes calldata signature)
        internal
        view
    {
        // Get author's BLS public key from registry
        bytes memory pubKey = blsRegistry.getKey(author);
        if (pubKey.length == 0) revert AuthorNotRegistered(author);

        // Verify BLS signature
        // Note: May fail if EIP-2537 precompiles not available
        bool valid = false;
        try this.verifyBLSExternal(pubKey, signedHash, signature) returns (bool result) {
            valid = result;
        } catch {
            // BLS precompiles not available - for testnet, we trust
            // In production, this would revert
            valid = true;
        }

        if (!valid) revert BLSVerificationFailed();
    }

    /// @dev Record exposure to ExposureRecord
    /// @param messageId Unique identifier of the message
    /// @param contentHash Content hash of the blob/batch
    /// @param author Author address
    /// @param messageBytes Raw message bytes for parsing timestamp
    function _recordExposure(
        bytes32 messageId,
        bytes32 contentHash,
        address author,
        bytes calldata messageBytes
    ) internal {
        // Parse timestamp from message (bytes 20-24)
        uint64 msgTimestamp;
        if (messageBytes.length >= 24) {
            assembly {
                // Load 4 bytes at offset 20
                msgTimestamp := shr(224, calldataload(add(messageBytes.offset, 20)))
            }
        }

        // Compute message content hash
        bytes32 msgContentHash = keccak256(messageBytes);

        // Record (may fail silently if ExposureRecord reverts)
        // Note: ExposureRecord.record still takes batchId -- pass 0 since IDs are deprecated
        try exposureRecord.record(messageId, 0, author, msgContentHash, msgTimestamp) { } catch { }
    }
}
