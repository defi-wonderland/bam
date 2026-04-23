// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import { IERC_BAM_SignatureRegistry } from "./IERC_BAM_SignatureRegistry.sol";

/// @title IECDSARegistry
/// @notice Scheme-0x01 (ECDSA-secp256k1) extension of IERC_BAM_SignatureRegistry.
/// @dev Adds a scheme-specific `rotate` and `hasDelegate` surface. The base
///      interface's `verifyWithRegisteredKey` semantics are deliberately
///      divergent from the BLS registry on the ECDSA path — see
///      docs/specs/erc-8180.md §Reference Implementation.
interface IECDSARegistry is IERC_BAM_SignatureRegistry {
    /// @notice Emitted when an owner's bound delegate is rotated to a new address.
    /// @param owner The Ethereum address whose delegate binding was rotated.
    /// @param oldDelegate The previously bound delegate address.
    /// @param newDelegate The newly bound delegate address.
    /// @param newIndex The registry index assigned to the new delegate binding.
    event KeyRotated(
        address indexed owner, address oldDelegate, address newDelegate, uint256 newIndex
    );

    /// @notice Replace the caller's currently-bound delegate with a new 20-byte
    ///         delegate address and proof of possession.
    /// @dev Reverts `NotRegistered` if the caller has no existing delegate
    ///      binding; reverts `InvalidPublicKey` / `InvalidProofOfPossession`
    ///      on the same conditions as `register`.
    /// @param newPubKey      The new 20-byte delegate address encoded as bytes.
    /// @param newPopProof    Proof of possession for the new delegate key.
    /// @return index         The registry index assigned to the new binding.
    function rotate(bytes calldata newPubKey, bytes calldata newPopProof)
        external
        returns (uint256 index);

    /// @notice Canonical "is this owner in keyed mode" signal.
    /// @dev True iff the owner has an active bound delegate. Consumers MUST use
    ///      this rather than inspecting `getKey` length — in keyless mode
    ///      `getKey` returns empty bytes and `isRegistered` returns `true`.
    /// @param owner The Ethereum address being queried.
    /// @return bound True iff `owner` has a bound delegate.
    function hasDelegate(address owner) external view returns (bool bound);
}
