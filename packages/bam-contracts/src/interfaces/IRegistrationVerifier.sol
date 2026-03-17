// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRegistrationVerifier
/// @notice Interface for verifying that content was registered through SocialBlobsCore
/// @dev Abstraction layer for registration verification. Implementations:
///      - SimpleBoolVerifier: Boolean mapping (v1)
///      - ReceiptProofVerifier: MPT receipt proofs (future)
///      - ZK verifier: Zero-knowledge proofs (future)
interface IRegistrationVerifier {
    /// @notice Verify that a content hash was registered through a Core contract
    /// @param coreAddress Address of the SocialBlobsCore contract
    /// @param contentHash Versioned hash (blob) or keccak256 hash (calldata)
    /// @param proof Proof data (ignored by SimpleBoolVerifier, used by receipt/ZK verifiers)
    /// @return True if the content hash is verified as registered
    function verifyRegistration(address coreAddress, bytes32 contentHash, bytes calldata proof)
        external
        view
        returns (bool);
}
