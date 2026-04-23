// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { IECDSARegistry } from "../interfaces/IECDSARegistry.sol";
import { IERC_BAM_SignatureRegistry } from "../interfaces/IERC_BAM_SignatureRegistry.sol";

/// @title ECDSARegistry
/// @notice ERC-8180 scheme-0x01 (ECDSA-secp256k1) signature registry.
/// @dev Address-native: the "public key" stored per owner is a 20-byte delegate
///      address. Verification runs pure `ecrecover` (via OpenZeppelin `ECDSA`)
///      on the post-envelope hash the caller hands in.
///
///      Deliberate divergences from ERC-8180 base-interface semantics on this
///      scheme (see docs/specs/erc-8180.md §Reference Implementation):
///        - `isRegistered(owner)` always returns `true`.
///        - `verifyWithRegisteredKey` does not revert `NotRegistered` when the
///          owner has no bound delegate; it falls back to keyless verification
///          (recovered address must equal `owner`).
contract ECDSARegistry is IECDSARegistry {
    using MessageHashUtils for bytes32;

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when `verifyAggregated` is called — ECDSA does not aggregate.
    error AggregationNotSupported();

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Expected delegate public key length — 20 bytes (an Ethereum address).
    uint256 public constant ECDSA_PUBKEY_LENGTH = 20;

    /// @dev Expected signature length — 65 bytes (r || s || v).
    uint256 public constant ECDSA_SIGNATURE_LENGTH = 65;

    /// @dev PoP domain tag. Pins the PoP message to this scheme + registry +
    ///      owner so a PoP for one cannot be replayed into another.
    string internal constant POP_DOMAIN = "ERC-BAM-ECDSA-PoP.v1";

    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Owner → bound delegate address (zero if keyless).
    mapping(address => address) private _delegate;

    /// @dev Owner → registry index assigned at register / rotate time.
    mapping(address => uint256) private _index;

    /// @dev Index → owning address. Cleared on rotation (addresses C-8).
    mapping(uint256 => address) private _indexToOwner;

    /// @dev Next index to assign. Starts at 1; 0 means "unindexed".
    uint256 private _nextIndex = 1;

    // ═══════════════════════════════════════════════════════════════════════════════
    // SCHEME METADATA
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function schemeId() external pure override returns (uint8 id) {
        return 0x01;
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function schemeName() external pure override returns (string memory name) {
        return "ECDSA-secp256k1";
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function pubKeySize() external pure override returns (uint256 size) {
        return ECDSA_PUBKEY_LENGTH;
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function signatureSize() external pure override returns (uint256 size) {
        return ECDSA_SIGNATURE_LENGTH;
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function supportsAggregation() external pure override returns (bool supported) {
        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REGISTRATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function register(bytes calldata pubKey, bytes calldata popProof)
        external
        override
        returns (uint256 index)
    {
        if (_delegate[msg.sender] != address(0)) revert AlreadyRegistered(msg.sender);
        address candidate = _decodeDelegate(pubKey);

        if (!_verifyPop(candidate, msg.sender, popProof)) {
            revert InvalidProofOfPossession();
        }

        index = _nextIndex++;
        _delegate[msg.sender] = candidate;
        _index[msg.sender] = index;
        _indexToOwner[index] = msg.sender;

        emit KeyRegistered(msg.sender, pubKey, index);
    }

    /// @inheritdoc IECDSARegistry
    function rotate(bytes calldata newPubKey, bytes calldata newPopProof)
        external
        override
        returns (uint256 index)
    {
        address oldDelegate = _delegate[msg.sender];
        if (oldDelegate == address(0)) revert NotRegistered(msg.sender);

        address candidate = _decodeDelegate(newPubKey);
        if (!_verifyPop(candidate, msg.sender, newPopProof)) {
            revert InvalidProofOfPossession();
        }

        // Clear the stale index reverse-mapping so that lookups by the old
        // index no longer resolve to msg.sender (addresses red-team C-8).
        uint256 oldIndex = _index[msg.sender];
        if (oldIndex != 0) delete _indexToOwner[oldIndex];

        index = _nextIndex++;
        _delegate[msg.sender] = candidate;
        _index[msg.sender] = index;
        _indexToOwner[index] = msg.sender;

        emit KeyRotated(msg.sender, oldDelegate, candidate, index);
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    /// @dev Returns the 20-byte delegate address if `owner` has an active
    ///      binding, and empty bytes otherwise — matching ERC-8180's
    ///      test-case expectation. Consumers MUST use `hasDelegate` for the
    ///      "keyed vs keyless" signal rather than inspecting the byte length.
    function getKey(address owner) external view override returns (bytes memory pubKey) {
        address delegate = _delegate[owner];
        if (delegate == address(0)) return bytes("");
        return abi.encodePacked(delegate);
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    /// @dev Diverges from ERC-8180's "has taken a registration action" intent:
    ///      the ECDSA registry can verify for any address via `ecrecover`, so
    ///      "registered" is reinterpreted as "this registry can verify
    ///      signatures for this address" and always returns `true`.
    function isRegistered(address) external pure override returns (bool) {
        return true;
    }

    /// @inheritdoc IECDSARegistry
    function hasDelegate(address owner) public view override returns (bool) {
        return _delegate[owner] != address(0);
    }

    /// @notice Look up the owner bound to a registry index.
    /// @dev Returns `address(0)` for indices that are unassigned OR that
    ///      have been rotated away (stale index guard — C-8).
    function ownerOfIndex(uint256 index) external view returns (address owner) {
        return _indexToOwner[index];
    }

    /// @notice Registry index currently bound to `owner`, or 0 if keyless.
    function indexOf(address owner) external view returns (uint256 index) {
        return _index[owner];
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VERIFICATION (placeholders — implemented in subsequent tasks)
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IERC_BAM_SignatureRegistry
    /// @dev Returns `false` for malformed signatures (wrong length, non-
    ///      canonical v, high-s, zero-address recovery). Only reverts on
    ///      malformed `pubKey` via `InvalidPublicKey` — that's a caller-misuse
    ///      signal (wrong key format for this scheme), distinct from signature
    ///      malformedness, which we model as a verification failure to keep
    ///      parity with the SDK local mirror (`tryRecoverLikeRegistry`) and
    ///      with `verifyWithRegisteredKey`.
    function verify(bytes calldata pubKey, bytes32 messageHash, bytes calldata signature)
        external
        pure
        override
        returns (bool)
    {
        address expected = _decodeDelegate(pubKey);
        return _tryRecoverMatches(messageHash, signature, expected);
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    /// @dev Branches on `hasDelegate`:
    ///       - keyed  → signature must recover to the bound delegate.
    ///       - keyless → signature must recover to `owner` itself (and
    ///                   recovered MUST be non-zero — C-2 guard).
    ///      Never reverts `NotRegistered` (deliberate ERC-8180 divergence).
    function verifyWithRegisteredKey(
        address owner,
        bytes32 messageHash,
        bytes calldata signature
    ) external view override returns (bool) {
        address expected = _delegate[owner];
        if (expected == address(0)) expected = owner;
        if (expected == address(0)) return false; // keyless + owner == 0x0.
        return _tryRecoverMatches(messageHash, signature, expected);
    }

    /// @inheritdoc IERC_BAM_SignatureRegistry
    function verifyAggregated(bytes[] calldata, bytes32[] calldata, bytes calldata)
        external
        pure
        override
        returns (bool)
    {
        revert AggregationNotSupported();
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Decodes a 20-byte delegate address from `pubKey`, reverting
    ///      `InvalidPublicKey` on length mismatch. Note the zero-address case
    ///      is not rejected here: `address(0)` cannot pass PoP because
    ///      OpenZeppelin's `ECDSA` rejects malformed sigs that would recover
    ///      to zero, so an attacker cannot produce a PoP for `address(0)`.
    function _decodeDelegate(bytes calldata pubKey) internal pure returns (address delegate) {
        if (pubKey.length != ECDSA_PUBKEY_LENGTH) revert InvalidPublicKey();
        delegate = address(bytes20(pubKey[:20]));
    }

    /// @dev Length-gated wrapper around `ECDSA.tryRecover`. Returns `false`
    ///      on any recovery error (wrong signature length, high-s,
    ///      non-canonical v) or zero-address recovery, and `true` only when
    ///      the recovered address equals `expected` and is non-zero. Never
    ///      reverts. Centralizing the length gate here keeps `verify` and
    ///      `verifyWithRegisteredKey` consistent (both return `false` on bad
    ///      length) and matches the SDK's `tryRecoverLikeRegistry` mirror.
    function _tryRecoverMatches(bytes32 hash, bytes calldata signature, address expected)
        internal
        pure
        returns (bool)
    {
        if (signature.length != ECDSA_SIGNATURE_LENGTH) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError) return false;
        if (recovered == address(0)) return false;
        return recovered == expected;
    }

    /// @dev Recomputes the PoP envelope on-chain and verifies that `popProof`
    ///      is a `personal_sign`-style ECDSA signature from `delegate` binding
    ///      itself to this registry and this `owner`. Returns `false` when the
    ///      signature is malformed, non-canonical, or recovers to a different
    ///      address; never reverts.
    function _verifyPop(address delegate, address owner, bytes calldata popProof)
        internal
        view
        returns (bool ok)
    {
        if (popProof.length != ECDSA_SIGNATURE_LENGTH) return false;

        bytes32 popInner =
            keccak256(abi.encode(POP_DOMAIN, block.chainid, address(this), owner));
        bytes32 popSigned = popInner.toEthSignedMessageHash();

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(popSigned, popProof);
        if (err != ECDSA.RecoverError.NoError) return false;
        if (recovered == address(0)) return false;
        return recovered == delegate;
    }
}
