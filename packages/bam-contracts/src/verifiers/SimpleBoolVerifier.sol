// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IRegistrationVerifier } from "../interfaces/IRegistrationVerifier.sol";
import { IRegistrationHook } from "../interfaces/IRegistrationHook.sol";

/// @title SimpleBoolVerifier
/// @notice V1 registration verifier using a boolean mapping
/// @dev Implements IRegistrationHook so SocialBlobsCore can call it atomically
///      during registration. Only the configured core contract can register hashes.
///      The real security comes from KZG/BLS proofs at exposure time. The boolean
///      is defense-in-depth.
contract SimpleBoolVerifier is IRegistrationVerifier, IRegistrationHook {
    /// @dev The deployer, authorized to call setCore once
    address private immutable _deployer;

    /// @dev The core contract allowed to call onRegistered
    address public core;

    /// @dev Mapping from content hash to registration status
    mapping(bytes32 => bool) private _registered;

    /// @notice Emitted when a content hash is registered
    /// @param contentHash The registered content hash
    event Registered(bytes32 indexed contentHash);

    /// @notice Emitted when the core address is set
    /// @param core The core contract address
    event CoreSet(address indexed core);

    /// @notice Thrown when caller is not the core contract
    error OnlyCore();

    /// @notice Thrown when core has already been set
    error CoreAlreadySet();

    /// @notice Thrown when caller is not the deployer
    error OnlyDeployer();

    constructor() {
        _deployer = msg.sender;
    }

    /// @notice Set the core contract address (one-time, deployer only)
    /// @dev Must be called after deploying both contracts. Cannot be changed once set.
    /// @param core_ Address of the SocialBlobsCore contract
    function setCore(address core_) external {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (core != address(0)) revert CoreAlreadySet();
        core = core_;
        emit CoreSet(core_);
    }

    /// @inheritdoc IRegistrationHook
    function onRegistered(bytes32 contentHash, address) external {
        if (msg.sender != core) revert OnlyCore();
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
