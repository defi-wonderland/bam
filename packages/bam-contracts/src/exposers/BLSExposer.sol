// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC_BAM_Exposer } from "../interfaces/IERC_BAM_Exposer.sol";
import { IBLSRegistry } from "../interfaces/IBLSRegistry.sol";
import { IExposureRecord } from "../interfaces/IExposureRecord.sol";
import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";
import { KZGVerifier } from "../libraries/KZGVerifier.sol";
import { BLSVerifier } from "../libraries/BLSVerifier.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BLSExposer
/// @notice Exposes messages with BLS signature verification
/// @dev Application-layer contract that handles exposure logic for BLS-signed messages.
///      Verifies KZG proofs (the bytes are in the blob behind the versioned hash) and
///      BLS signatures (the sender authored them), and optionally records to
///      ExposureRecord. Batch registration is proven off-chain from the BAM core's
///      `BlobBatchRegistered` / `CalldataBatchRegistered` event log; per ERC-8180 the
///      core is events-only, so no on-chain registration check is performed here.
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

    /// @notice Thrown when sender is not registered in BLS registry
    error SenderNotRegistered(address sender);

    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev BAM core contract this exposer is paired with. Informational only —
    ///      kept so consumers can discover the associated core; never called on-chain
    ///      (registration is proven off-chain from the core's event log).
    address public immutable core;

    /// @dev BLS public key registry
    IBLSRegistry public immutable blsRegistry;

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

    /// @param core_ Address of the BAM core contract this exposer is paired with
    /// @param blsRegistry_ Address of BLS public key registry
    /// @param exposureRecord_ Address of ExposureRecord (or address(0) to disable)
    constructor(address core_, address blsRegistry_, address exposureRecord_) {
        core = core_;
        blsRegistry = IBLSRegistry(blsRegistry_);
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
        // 1. Verify KZG proofs and extract bytes (uses versionedHash directly)
        bytes memory extractedBytes = KZGVerifier.verifyAndExtract(
            params.versionedHash, params.kzgProofs, params.byteOffset, params.byteLength
        );

        // 2. Verify extracted bytes match provided message
        if (keccak256(extractedBytes) != keccak256(params.messageBytes)) {
            revert MessageMismatch();
        }

        // 3. Parse message fields: [sender(20)][timestamp(4)][nonce(2)][contents...]
        address sender = _parseSender(params.messageBytes);
        uint64 nonce = _parseNonce(params.messageBytes);
        bytes calldata contents = params.messageBytes[26:];

        // 4. Compute standardized hashes per ERC-8180, with contentTag bound in.
        //    A mismatched contentTag yields a different messageHash and the BLS
        //    signature check below will reject it.
        bytes32 messageHash =
            keccak256(abi.encodePacked(sender, params.contentTag, nonce, contents));
        messageId =
            keccak256(abi.encodePacked(sender, params.contentTag, nonce, params.versionedHash));
        bytes32 signedHash = keccak256(abi.encodePacked(_DOMAIN, messageHash));

        // 5. Check not already exposed
        if (_exposed[messageId]) revert AlreadyExposed(messageId);

        // 6. Verify BLS signature against signedHash (domain-separated)
        _verifyBLSSignature(sender, signedHash, params.blsSignature);

        // 7. Mark as exposed
        _exposed[messageId] = true;

        // 8. Emit standardized event
        emit MessageExposed(
            params.versionedHash, messageId, sender, msg.sender, uint64(block.timestamp)
        );

        // 9. Optionally record to ExposureRecord
        if (address(exposureRecord) != address(0)) {
            _recordExposure(messageId, params.versionedHash, sender, params.messageBytes);
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

        // 2. Verify message exists at claimed offset
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

        // 3. Parse message fields: [sender(20)][timestamp(4)][nonce(2)][contents...]
        address sender = _parseSender(params.messageBytes);
        uint64 nonce = _parseNonce(params.messageBytes);
        bytes calldata contents = params.messageBytes[26:];

        // 4. Compute standardized hashes per ERC-8180, with contentTag bound in.
        //    A mismatched contentTag yields a different messageHash and the BLS
        //    signature check below will reject it.
        bytes32 messageHash =
            keccak256(abi.encodePacked(sender, params.contentTag, nonce, contents));
        messageId = keccak256(abi.encodePacked(sender, params.contentTag, nonce, contentHash));
        bytes32 signedHash = keccak256(abi.encodePacked(_DOMAIN, messageHash));

        // 5. Check not already exposed
        if (_exposed[messageId]) revert AlreadyExposed(messageId);

        // 6. Verify BLS signature against signedHash (domain-separated)
        _verifyBLSSignature(sender, signedHash, params.signature);

        // 7. Mark as exposed
        _exposed[messageId] = true;

        // 8. Emit standardized event
        emit MessageExposed(contentHash, messageId, sender, msg.sender, uint64(block.timestamp));

        // 9. Optionally record to ExposureRecord
        if (address(exposureRecord) != address(0)) {
            _recordExposure(messageId, contentHash, sender, params.messageBytes);
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

    /// @dev Parse sender address from message bytes (offset 0, 20 bytes)
    /// @param messageBytes Raw message bytes
    /// @return sender Extracted sender address
    function _parseSender(bytes calldata messageBytes) internal pure returns (address sender) {
        // Message format: [sender (20 bytes)][timestamp (4 bytes)][nonce (2 bytes)][content...]
        assembly {
            // Load 32 bytes starting at messageBytes.offset, shift right 96 bits to get address
            sender := shr(96, calldataload(messageBytes.offset))
        }
    }

    /// @dev Parse nonce from message bytes (offset 24, 2 bytes) and cast to uint64
    /// @param messageBytes Raw message bytes
    /// @return nonce Extracted nonce as uint64
    function _parseNonce(bytes calldata messageBytes) internal pure returns (uint64 nonce) {
        // Message format: [sender (20 bytes)][timestamp (4 bytes)][nonce (2 bytes)][content...]
        uint16 rawNonce;
        assembly {
            // Load 32 bytes at offset 24, shift right 240 bits to get 2 bytes
            rawNonce := shr(240, calldataload(add(messageBytes.offset, 24)))
        }
        nonce = uint64(rawNonce);
    }

    /// @dev Verify BLS signature using the registry
    /// @param sender Message sender
    /// @param signedHash Domain-separated hash to verify
    /// @param signature BLS signature
    function _verifyBLSSignature(address sender, bytes32 signedHash, bytes calldata signature)
        internal
        view
    {
        // Get sender's BLS public key from registry
        bytes memory pubKey = blsRegistry.getKey(sender);
        if (pubKey.length == 0) revert SenderNotRegistered(sender);

        // Verify the BLS signature. With the registration gate removed, this is the
        // sole authorship check, so it must fail closed: the only revert we tolerate
        // is `PrecompilesNotAvailable` (pre-Pectra / local chains where BLS cannot be
        // checked at all). Every other revert — malformed signature length, invalid
        // curve point, etc. — is attacker-controllable and MUST NOT be treated as a
        // valid signature, or exposure would be unauthenticated.
        bool valid;
        try this.verifyBLSExternal(pubKey, signedHash, signature) returns (bool result) {
            valid = result;
        } catch (bytes memory err) {
            bytes4 sel;
            if (err.length >= 4) {
                assembly {
                    sel := mload(add(err, 0x20))
                }
            }
            if (sel != BLSVerifier.PrecompilesNotAvailable.selector) {
                revert BLSVerificationFailed();
            }
            valid = true;
        }

        if (!valid) revert BLSVerificationFailed();
    }

    /// @dev Record exposure to ExposureRecord
    /// @param messageId Unique identifier of the message
    /// @param contentHash Content hash of the blob/batch
    /// @param sender Sender address
    /// @param messageBytes Raw message bytes for parsing timestamp
    function _recordExposure(
        bytes32 messageId,
        bytes32 contentHash,
        address sender,
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
        try exposureRecord.record(messageId, 0, sender, msgContentHash, msgTimestamp) { } catch { }
    }
}
