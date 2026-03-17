// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";

/// @title IZKVerifier
/// @notice Interface for ZK proof verification (Phase 2)
/// @dev Verifies decompression proofs from various ZK backends
interface IZKVerifier {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a verifier key is registered
    /// @param backend ZK backend type
    /// @param vkHash Hash of the verifier key
    /// @param verifier Address of the verifier contract
    event VerifierKeyRegistered(
        SocialBlobsTypes.ZKBackend indexed backend, bytes32 indexed vkHash, address verifier
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when backend is not supported
    error UnsupportedBackend(SocialBlobsTypes.ZKBackend backend);

    /// @notice Thrown when verifier key is not registered
    error VerifierKeyNotRegistered(bytes32 vkHash);

    /// @notice Thrown when proof verification fails
    error ProofVerificationFailed();

    /// @notice Thrown when claim is invalid
    error InvalidClaim();

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Verify a decompression proof
    /// @param claim The decompression claim to verify
    /// @param proof The ZK proof
    /// @return valid True if proof verifies the claim
    function verify(
        SocialBlobsTypes.DecompClaim calldata claim,
        SocialBlobsTypes.DecompProof calldata proof
    ) external view returns (bool valid);

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Check if a backend is supported
    /// @param backend The ZK backend to check
    /// @return supported True if backend is supported
    function supportsBackend(SocialBlobsTypes.ZKBackend backend)
        external
        view
        returns (bool supported);

    // ═══════════════════════════════════════════════════════════════════════════════
    // GOVERNANCE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Register a new verifier key (governance)
    /// @param backend ZK backend type
    /// @param vkHash Hash of the verifier key
    /// @param verifier Address of the verifier contract
    function registerVerifierKey(
        SocialBlobsTypes.ZKBackend backend,
        bytes32 vkHash,
        address verifier
    ) external;
}
