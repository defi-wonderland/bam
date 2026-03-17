// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISignatureRegistry } from "../interfaces/ISignatureRegistry.sol";

/// @title SignatureRegistryDispatcher
/// @notice Routes signature operations to scheme-specific registries
/// @dev Permissionless signature extensibility system (SigType 11).
///      Anyone can register a scheme (first-come-first-served).
///      Schemes are immutable once registered (no removal).
/// @custom:spec specs/008-signature-extensibility, specs/009-core-refactor
contract SignatureRegistryDispatcher {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a new scheme registry is added
    /// @param schemeId The scheme identifier
    /// @param registry The registry contract address
    /// @param schemeName Human-readable scheme name
    /// @param registeredBy Address that registered the scheme
    event SchemeRegistered(
        uint8 indexed schemeId, address indexed registry, string schemeName, address registeredBy
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when scheme is already registered
    error SchemeAlreadyRegistered(uint8 schemeId);

    /// @notice Thrown when scheme is not registered
    error SchemeNotRegistered(uint8 schemeId);

    /// @notice Thrown when registry returns mismatched scheme ID
    error SchemeIdMismatch(uint8 expected, uint8 actual);

    /// @notice Thrown when address is not a valid registry
    error InvalidRegistry(address registry);

    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Mapping from scheme ID to registry contract
    mapping(uint8 => ISignatureRegistry) public registries;

    /// @notice Array of registered scheme IDs for enumeration
    uint8[] public registeredSchemes;

    /// @notice Mapping to track if scheme ID is registered
    mapping(uint8 => bool) public isSchemeRegistered;

    // ═══════════════════════════════════════════════════════════════════════════════
    // SCHEME REGISTRATION (Permissionless)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Register a new signature scheme
    /// @dev Permissionless, first-come-first-served. Schemes are immutable once registered.
    ///      Registry must implement ISignatureRegistry and return matching schemeId().
    /// @param schemeId The scheme identifier (must match registry.schemeId())
    /// @param registry The registry contract address
    function registerScheme(uint8 schemeId, ISignatureRegistry registry) external {
        // Check not already registered
        if (isSchemeRegistered[schemeId]) revert SchemeAlreadyRegistered(schemeId);

        // Validate registry contract
        if (address(registry) == address(0)) revert InvalidRegistry(address(registry));

        // Verify scheme ID matches
        uint8 actualId = registry.schemeId();
        if (actualId != schemeId) revert SchemeIdMismatch(schemeId, actualId);

        // Register
        registries[schemeId] = registry;
        registeredSchemes.push(schemeId);
        isSchemeRegistered[schemeId] = true;

        emit SchemeRegistered(schemeId, address(registry), registry.schemeName(), msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Get the registry for a scheme
    /// @param schemeId The scheme identifier
    /// @return registry The registry contract (reverts if not registered)
    function getRegistry(uint8 schemeId) public view returns (ISignatureRegistry registry) {
        if (!isSchemeRegistered[schemeId]) revert SchemeNotRegistered(schemeId);
        return registries[schemeId];
    }

    /// @notice Get all registered scheme IDs
    /// @return schemes Array of registered scheme IDs
    function getRegisteredSchemes() external view returns (uint8[] memory schemes) {
        return registeredSchemes;
    }

    /// @notice Get count of registered schemes
    /// @return count Number of registered schemes
    function schemeCount() external view returns (uint256 count) {
        return registeredSchemes.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION (Routed to scheme-specific registry)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Verify a signature using the appropriate scheme registry
    /// @param schemeId The signature scheme
    /// @param pubKey The public key
    /// @param messageHash The message hash
    /// @param signature The signature bytes
    /// @return valid True if signature is valid
    function verify(
        uint8 schemeId,
        bytes calldata pubKey,
        bytes32 messageHash,
        bytes calldata signature
    ) external view returns (bool valid) {
        ISignatureRegistry registry = getRegistry(schemeId);
        return registry.verify(pubKey, messageHash, signature);
    }

    /// @notice Verify using a registered key
    /// @param schemeId The signature scheme
    /// @param owner The key owner address
    /// @param messageHash The message hash
    /// @param signature The signature bytes
    /// @return valid True if signature is valid
    function verifyWithRegisteredKey(
        uint8 schemeId,
        address owner,
        bytes32 messageHash,
        bytes calldata signature
    ) external view returns (bool valid) {
        ISignatureRegistry registry = getRegistry(schemeId);
        return registry.verifyWithRegisteredKey(owner, messageHash, signature);
    }

    /// @notice Check if a scheme supports aggregation
    /// @param schemeId The signature scheme
    /// @return supported True if aggregation is supported
    function supportsAggregation(uint8 schemeId) external view returns (bool supported) {
        ISignatureRegistry registry = getRegistry(schemeId);
        return registry.supportsAggregation();
    }

    /// @notice Verify an aggregated signature
    /// @param schemeId The signature scheme
    /// @param pubKeys Array of public keys
    /// @param messageHashes Array of message hashes
    /// @param aggregatedSignature The aggregated signature
    /// @return valid True if aggregated signature is valid
    function verifyAggregated(
        uint8 schemeId,
        bytes[] calldata pubKeys,
        bytes32[] calldata messageHashes,
        bytes calldata aggregatedSignature
    ) external view returns (bool valid) {
        ISignatureRegistry registry = getRegistry(schemeId);
        return registry.verifyAggregated(pubKeys, messageHashes, aggregatedSignature);
    }
}
