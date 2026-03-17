// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { IERC_BAM_SignatureRegistry } from "./IERC_BAM_SignatureRegistry.sol";

/// @title IERC_BAM_SignatureDispatcher
/// @notice Optional extension: routes signature operations to scheme-specific registries
/// @dev Permissionless multi-scheme dispatch. Anyone can register a scheme
/// (first-come-first-served). Schemes are immutable once registered. This is an OPTIONAL extension
/// — implementations
///      supporting only one signature scheme do not need a dispatcher.
interface IERC_BAM_SignatureDispatcher {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a new scheme registry is registered.
    /// @param schemeId     The scheme identifier.
    /// @param registry     The registry contract address.
    /// @param schemeName   Human-readable scheme name.
    /// @param registeredBy Address that registered the scheme.
    event SchemeRegistered(
        uint8 indexed schemeId, address indexed registry, string schemeName, address registeredBy
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when scheme is already registered.
    error SchemeAlreadyRegistered(uint8 schemeId);

    /// @notice Thrown when scheme is not registered.
    error SchemeNotRegistered(uint8 schemeId);

    /// @notice Thrown when registry returns a mismatched scheme ID.
    error SchemeIdMismatch(uint8 expected, uint8 actual);

    /// @notice Thrown when address is not a valid registry.
    error InvalidRegistry(address registry);

    // ═══════════════════════════════════════════════════════════════════════════════
    // SCHEME REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Register a new signature scheme.
    /// @dev Permissionless, first-come-first-served. Schemes are immutable once registered.
    ///      Registry MUST implement IERC_BAM_SignatureRegistry and return matching schemeId().
    /// @param schemeId The scheme identifier (MUST match registry.schemeId()).
    /// @param registry The registry contract address.
    function registerScheme(uint8 schemeId, IERC_BAM_SignatureRegistry registry) external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Get the registry for a scheme.
    /// @param schemeId The scheme identifier.
    /// @return registry The registry contract.
    function getRegistry(uint8 schemeId) external view returns (IERC_BAM_SignatureRegistry registry);

    /// @notice Get all registered scheme IDs.
    /// @return schemes Array of registered scheme IDs.
    function getRegisteredSchemes() external view returns (uint8[] memory schemes);

    /// @notice Get count of registered schemes.
    /// @return count Number of registered schemes.
    function schemeCount() external view returns (uint256 count);

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION (Routed)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Verify a signature using the appropriate scheme registry.
    /// @param schemeId    The signature scheme.
    /// @param pubKey      The public key.
    /// @param messageHash The message hash.
    /// @param signature   The signature bytes.
    /// @return valid      True if signature is valid.
    function verify(
        uint8 schemeId,
        bytes calldata pubKey,
        bytes32 messageHash,
        bytes calldata signature
    ) external view returns (bool valid);

    /// @notice Verify using a registered key.
    /// @param schemeId    The signature scheme.
    /// @param owner       The key owner address.
    /// @param messageHash The message hash.
    /// @param signature   The signature bytes.
    /// @return valid      True if signature is valid.
    function verifyWithRegisteredKey(
        uint8 schemeId,
        address owner,
        bytes32 messageHash,
        bytes calldata signature
    ) external view returns (bool valid);

    /// @notice Check if a scheme supports aggregation.
    /// @param schemeId The signature scheme.
    /// @return supported True if aggregation is supported.
    function supportsAggregation(uint8 schemeId) external view returns (bool supported);

    /// @notice Verify an aggregated signature.
    /// @param schemeId            The signature scheme.
    /// @param pubKeys             Array of public keys.
    /// @param messageHashes       Array of message hashes.
    /// @param aggregatedSignature The aggregated signature.
    /// @return valid              True if aggregated signature is valid.
    function verifyAggregated(
        uint8 schemeId,
        bytes[] calldata pubKeys,
        bytes32[] calldata messageHashes,
        bytes calldata aggregatedSignature
    ) external view returns (bool valid);
}
