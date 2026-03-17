// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IRegistrationVerifier } from "../interfaces/IRegistrationVerifier.sol";

/// @title SimpleBoolVerifier
/// @notice V1 registration verifier using a boolean mapping
/// @dev Permissionless — anyone can register a hash. The real security comes from
///      KZG/BLS proofs at exposure time. The boolean is defense-in-depth.
///      When receipt proofs or ZK proofs replace this, the register() step goes away.
contract SimpleBoolVerifier is IRegistrationVerifier {
    /// @dev Mapping from content hash to registration status
    mapping(bytes32 => bool) private _registered;

    /// @notice Emitted when a content hash is registered
    /// @param contentHash The registered content hash
    event Registered(bytes32 indexed contentHash);

    /// @notice Register a content hash as verified
    /// @dev Permissionless. Typically called by aggregators after
    ///      Core.registerBlob/registerCalldata.
    /// @param contentHash Versioned hash (blob) or keccak256 hash (calldata)
    function register(bytes32 contentHash) external {
        _registered[contentHash] = true;
        emit Registered(contentHash);
    }

    /// @inheritdoc IRegistrationVerifier
    function verifyRegistration(address, bytes32 contentHash, bytes calldata)
        external
        view
        returns (bool)
    {
        return _registered[contentHash];
    }

    /// @notice Convenience function to check registration status
    /// @param contentHash The content hash to check
    /// @return True if registered
    function isRegistered(bytes32 contentHash) external view returns (bool) {
        return _registered[contentHash];
    }
}
