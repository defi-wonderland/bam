// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SocialBlobsTypes
/// @notice Shared type definitions for Social-Blobs protocol contracts
/// @dev All structs and enums used across multiple contracts are defined here
library SocialBlobsTypes {
    // ═══════════════════════════════════════════════════════════════════════════════
    // KZG TYPES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice KZG point evaluation proof for extracting bytes from a blob
    /// @param z Field element index (0-4095 for blob field elements)
    /// @param y Field element value at index z
    /// @param commitment 48-byte KZG commitment (compressed G1 point)
    /// @param proof 48-byte KZG proof (compressed G1 point)
    struct KZGProof {
        uint256 z;
        uint256 y;
        bytes commitment;
        bytes proof;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // EXPOSURE TYPES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Parameters for exposing a tweet on-chain (blob source)
    /// @param versionedHash EIP-4844 versioned hash of the blob
    /// @param kzgProofs Array of KZG proofs for field elements covering the message
    /// @param byteOffset Starting byte offset of message in blob
    /// @param byteLength Length of message in bytes
    /// @param messageBytes Raw message bytes (for verification)
    /// @param blsSignature BLS signature on the message
    /// @param registrationProof Proof of registration (empty for SimpleBoolVerifier)
    struct ExposureParams {
        bytes32 versionedHash;
        KZGProof[] kzgProofs;
        uint256 byteOffset;
        uint256 byteLength;
        bytes messageBytes;
        bytes blsSignature;
        bytes registrationProof;
    }

    /// @notice Parameters for exposing a tweet from calldata batch
    /// @dev No KZG proofs needed - data is directly verifiable via hash
    /// @param batchData Full batch data for hash verification
    /// @param messageOffset Byte offset of message within batch
    /// @param messageBytes Raw message bytes
    /// @param signature Signature on the message (BLS or ECDSA)
    /// @param registrationProof Proof of registration (empty for SimpleBoolVerifier)
    struct CalldataExposureParams {
        bytes batchData;
        uint256 messageOffset;
        bytes messageBytes;
        bytes signature;
        bytes registrationProof;
    }

    /// @notice Record of an exposed tweet
    /// @param contentHash Content hash (versioned hash for blob, keccak256 for calldata)
    /// @param author Author's Ethereum address
    /// @param messageContentHash keccak256 hash of message content
    /// @param timestamp Original message timestamp
    /// @param exposedAt Block timestamp when exposed
    /// @param exposedBy Address that exposed the tweet
    struct ExposedTweet {
        bytes32 contentHash;
        address author;
        bytes32 messageContentHash;
        uint64 timestamp;
        uint64 exposedAt;
        address exposedBy;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DISPUTE TYPES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Status of a dispute
    enum DisputeStatus {
        None, // No dispute filed
        Challenged, // Challenge filed, awaiting resolution
        Resolved, // Dispute resolved, exposure was valid
        Rejected // Dispute resolved, exposure was fraudulent
    }

    /// @notice Record of a dispute
    /// @param messageHash Hash of the disputed message
    /// @param challenger Address that filed the challenge
    /// @param challengedAt Timestamp when challenge was filed
    /// @param resolveDeadline Timestamp by which dispute must be resolved
    /// @param status Current status of the dispute
    /// @param evidence Reference to off-chain evidence (IPFS CID, etc.)
    struct Dispute {
        bytes32 messageHash;
        address challenger;
        uint64 challengedAt;
        uint64 resolveDeadline;
        DisputeStatus status;
        bytes evidence;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ZK TYPES (Phase 2)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice ZK proving backend
    enum ZKBackend {
        None, // No ZK proof required
        RiscZero, // RISC Zero zkVM
        SP1, // Succinct SP1
        Custom // Custom verifier
    }

    /// @notice ZK decompression proof
    /// @param backend ZK backend used for proof generation
    /// @param proof The ZK proof bytes
    /// @param vkHash Hash of the verifier key
    struct DecompProof {
        ZKBackend backend;
        bytes proof;
        bytes32 vkHash;
    }

    /// @notice Claim about decompression result
    /// @param compressedHash keccak256 hash of compressed bytes
    /// @param messageHash keccak256 hash of decompressed message
    /// @param messageOffset Position of message in decompressed stream
    /// @param messageLength Length of message in bytes
    /// @param dictionaryHash Hash of dictionary used for decompression
    struct DecompClaim {
        bytes32 compressedHash;
        bytes32 messageHash;
        uint256 messageOffset;
        uint256 messageLength;
        bytes32 dictionaryHash;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DICTIONARY TYPES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Record of a registered compression dictionary
    /// @param contentHash keccak256 hash of dictionary bytes
    /// @param ipfsCid IPFS CID for dictionary retrieval
    /// @param registeredAt Timestamp when dictionary was registered
    /// @param active Whether dictionary is active for use
    struct Dictionary {
        bytes32 contentHash;
        string ipfsCid;
        uint64 registeredAt;
        bool active;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // BLS TYPES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Record of a registered BLS public key
    /// @param pubKey 48-byte BLS public key (compressed G1 point)
    /// @param index Registry index assigned to this key
    /// @param revoked Whether the key has been revoked
    struct BLSKeyRecord {
        bytes pubKey;
        uint256 index;
        bool revoked;
    }
}
