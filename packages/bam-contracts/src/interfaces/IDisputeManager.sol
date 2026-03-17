// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";

/// @title IDisputeManager
/// @notice Interface for dispute management (Phase 1 only)
/// @dev Handles challenges to exposed tweets during trusted decompression phase
interface IDisputeManager {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when a challenge is filed
    /// @param messageHash Hash of the disputed message
    /// @param challenger Address that filed the challenge
    /// @param stake Amount staked with challenge
    event ChallengeFiled(bytes32 indexed messageHash, address indexed challenger, uint256 stake);

    /// @notice Emitted when a dispute is resolved
    /// @param messageHash Hash of the disputed message
    /// @param valid True if exposure was valid, false if fraudulent
    /// @param resolver Address that resolved the dispute
    event DisputeResolved(bytes32 indexed messageHash, bool valid, address indexed resolver);

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when message is not exposed
    error MessageNotExposed(bytes32 messageHash);

    /// @notice Thrown when message is already disputed
    error AlreadyDisputed(bytes32 messageHash);

    /// @notice Thrown when challenge window has passed
    error ChallengeWindowClosed(bytes32 messageHash);

    /// @notice Thrown when stake amount is insufficient
    error InsufficientStake(uint256 required, uint256 provided);

    /// @notice Thrown when dispute is not found
    error DisputeNotFound(bytes32 messageHash);

    /// @notice Thrown when dispute deadline has not passed
    error DeadlineNotReached(bytes32 messageHash);

    /// @notice Thrown when caller is not authorized resolver
    error NotAuthorizedResolver();

    // ═══════════════════════════════════════════════════════════════════════════════
    // CHALLENGES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Challenge an exposed tweet
    /// @param messageHash Hash of the exposed message
    /// @param evidence Off-chain evidence reference (IPFS CID, etc.)
    function challenge(bytes32 messageHash, bytes calldata evidence) external payable;

    /// @notice Resolve a dispute (governance/arbitration)
    /// @param messageHash Hash of the disputed message
    /// @param valid True if exposure was valid, false if fraudulent
    function resolve(bytes32 messageHash, bool valid) external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Check if a message is under dispute
    /// @param messageHash Hash of the message
    /// @return disputed True if message is under active dispute
    function isDisputed(bytes32 messageHash) external view returns (bool disputed);

    /// @notice Get dispute details
    /// @param messageHash Hash of the message
    /// @return dispute The dispute record
    function getDispute(bytes32 messageHash)
        external
        view
        returns (SocialBlobsTypes.Dispute memory dispute);

    /// @notice Get challenge window duration
    /// @return window Duration in seconds
    function challengeWindow() external view returns (uint256 window);

    /// @notice Get required challenge stake
    /// @return stake Amount in wei
    function challengeStake() external view returns (uint256 stake);
}
