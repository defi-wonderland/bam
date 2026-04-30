// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { IERC_BSS } from "../interfaces/IERC_BSS.sol";
import { IERC_BAM_Core } from "../interfaces/IERC_BAM_Core.sol";

/// @title BlobAuthenticatedMessagingCore
/// @notice Reference implementation of IERC_BAM_Core (extends IERC_BSS)
/// @dev Zero storage. Events are the sole record. Uses BLOBHASH opcode (EIP-4844).
///      declareBlobSegment is public so registerBlobBatch can call it internally.
contract BlobAuthenticatedMessagingCore is IERC_BAM_Core {
    uint16 internal constant MAX_FIELD_ELEMENTS = 4096;

    /// @notice Reverts when `registerBlobBatches` is called with an empty `calls` array.
    error EmptyBatchArray();

    /// @inheritdoc IERC_BAM_Core
    function registerBlobBatch(
        uint256 blobIndex,
        uint16 startFE,
        uint16 endFE,
        bytes32 contentTag,
        address decoder,
        address signatureRegistry
    ) external returns (bytes32 versionedHash) {
        versionedHash = declareBlobSegment(blobIndex, startFE, endFE, contentTag);

        emit BlobBatchRegistered(versionedHash, msg.sender, contentTag, decoder, signatureRegistry);
    }

    /// @inheritdoc IERC_BAM_Core
    function registerBlobBatches(BlobBatchCall[] calldata calls)
        external
        returns (bytes32[] memory versionedHashes)
    {
        uint256 len = calls.length;
        if (len == 0) revert EmptyBatchArray();

        versionedHashes = new bytes32[](len);
        for (uint256 i = 0; i < len; i++) {
            BlobBatchCall calldata c = calls[i];
            bytes32 versionedHash = declareBlobSegment(c.blobIndex, c.startFE, c.endFE, c.contentTag);
            versionedHashes[i] = versionedHash;
            emit BlobBatchRegistered(versionedHash, msg.sender, c.contentTag, c.decoder, c.signatureRegistry);
        }
    }

    /// @inheritdoc IERC_BAM_Core
    function registerCalldataBatch(
        bytes calldata batchData,
        bytes32 contentTag,
        address decoder,
        address signatureRegistry
    ) external returns (bytes32 contentHash) {
        contentHash = keccak256(batchData);

        emit CalldataBatchRegistered(contentHash, msg.sender, contentTag, decoder, signatureRegistry);
    }

    /// @inheritdoc IERC_BSS
    function declareBlobSegment(uint256 blobIndex, uint16 startFE, uint16 endFE, bytes32 contentTag)
        public
        returns (bytes32 versionedHash)
    {
        if (startFE >= endFE || endFE > MAX_FIELD_ELEMENTS) {
            revert InvalidSegment(startFE, endFE);
        }

        assembly {
            versionedHash := blobhash(blobIndex)
        }
        if (versionedHash == bytes32(0)) revert NoBlobAtIndex(blobIndex);

        emit BlobSegmentDeclared(versionedHash, msg.sender, startFE, endFE, contentTag);
    }
}
