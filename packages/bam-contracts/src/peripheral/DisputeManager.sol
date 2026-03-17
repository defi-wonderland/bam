// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IDisputeManager } from "../interfaces/IDisputeManager.sol";
import { IExposureRecord } from "../interfaces/IExposureRecord.sol";
import { SocialBlobsTypes } from "../libraries/SocialBlobsTypes.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DisputeManager
/// @notice Manages disputes for exposed tweets during Phase 1 (trusted decompression)
/// @dev Challenge window allows users to dispute fraudulent exposures
contract DisputeManager is IDisputeManager, Ownable, ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Default challenge window: 24 hours
    uint256 public constant DEFAULT_CHALLENGE_WINDOW = 24 hours;

    /// @dev Default challenge stake: 0.01 ETH
    uint256 public constant DEFAULT_CHALLENGE_STAKE = 0.01 ether;

    /// @dev Resolution deadline after challenge: 7 days
    uint256 public constant RESOLUTION_PERIOD = 7 days;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Exposure record contract for checking exposure status
    IExposureRecord public immutable exposureRecord;

    /// @dev Challenge window duration
    uint256 private _challengeWindow;

    /// @dev Required stake amount for challenges
    uint256 private _challengeStake;

    /// @dev Mapping from message hash to dispute record
    mapping(bytes32 => SocialBlobsTypes.Dispute) private _disputes;

    /// @dev Mapping from message hash to stake amount held
    mapping(bytes32 => uint256) private _stakes;

    /// @dev Authorized resolvers (e.g., DAO multisig, arbitration contract)
    mapping(address => bool) public authorizedResolvers;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @param exposureRecord_ Address of ExposureRecord contract
    /// @param owner_ Owner address for admin functions
    constructor(address exposureRecord_, address owner_) Ownable(owner_) {
        exposureRecord = IExposureRecord(exposureRecord_);
        _challengeWindow = DEFAULT_CHALLENGE_WINDOW;
        _challengeStake = DEFAULT_CHALLENGE_STAKE;

        // Owner is initially an authorized resolver
        authorizedResolvers[owner_] = true;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Set challenge window duration
    /// @param window New window duration in seconds
    function setChallengeWindow(uint256 window) external onlyOwner {
        _challengeWindow = window;
    }

    /// @notice Set required challenge stake
    /// @param stake New stake amount in wei
    function setChallengeStake(uint256 stake) external onlyOwner {
        _challengeStake = stake;
    }

    /// @notice Add an authorized resolver
    /// @param resolver Address to authorize
    function addResolver(address resolver) external onlyOwner {
        authorizedResolvers[resolver] = true;
    }

    /// @notice Remove an authorized resolver
    /// @param resolver Address to remove
    function removeResolver(address resolver) external onlyOwner {
        authorizedResolvers[resolver] = false;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CHALLENGES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IDisputeManager
    function challenge(bytes32 messageHash, bytes calldata evidence) external payable nonReentrant {
        // Verify exposure exists
        if (!exposureRecord.isExposed(messageHash)) revert MessageNotExposed(messageHash);

        // Check not already disputed
        if (_disputes[messageHash].status == SocialBlobsTypes.DisputeStatus.Challenged) {
            revert AlreadyDisputed(messageHash);
        }

        // Check challenge window
        SocialBlobsTypes.ExposedTweet memory exposure = exposureRecord.getExposure(messageHash);
        if (block.timestamp > exposure.exposedAt + _challengeWindow) {
            revert ChallengeWindowClosed(messageHash);
        }

        // Verify stake
        if (msg.value < _challengeStake) revert InsufficientStake(_challengeStake, msg.value);

        // Create dispute record
        _disputes[messageHash] = SocialBlobsTypes.Dispute({
            messageHash: messageHash,
            challenger: msg.sender,
            challengedAt: uint64(block.timestamp),
            resolveDeadline: uint64(block.timestamp + RESOLUTION_PERIOD),
            status: SocialBlobsTypes.DisputeStatus.Challenged,
            evidence: evidence
        });

        _stakes[messageHash] = msg.value;

        emit ChallengeFiled(messageHash, msg.sender, msg.value);
    }

    /// @inheritdoc IDisputeManager
    function resolve(bytes32 messageHash, bool valid) external nonReentrant {
        if (!authorizedResolvers[msg.sender]) revert NotAuthorizedResolver();

        SocialBlobsTypes.Dispute storage dispute = _disputes[messageHash];

        if (dispute.status != SocialBlobsTypes.DisputeStatus.Challenged) {
            revert DisputeNotFound(messageHash);
        }

        uint256 stake = _stakes[messageHash];
        address challenger = dispute.challenger;

        if (valid) {
            // Exposure was valid - challenger loses stake (goes to protocol/treasury)
            dispute.status = SocialBlobsTypes.DisputeStatus.Resolved;
            // Stake goes to owner (could be treasury in production)
            (bool sent,) = owner().call{ value: stake }("");
            require(sent, "Transfer failed");
        } else {
            // Exposure was fraudulent - challenger wins, gets stake back
            dispute.status = SocialBlobsTypes.DisputeStatus.Rejected;
            (bool sent,) = challenger.call{ value: stake }("");
            require(sent, "Transfer failed");
        }

        _stakes[messageHash] = 0;

        emit DisputeResolved(messageHash, valid, msg.sender);
    }

    /// @notice Allow challenger to claim stake if resolution deadline passed
    /// @param messageHash Hash of the disputed message
    function claimExpiredDispute(bytes32 messageHash) external nonReentrant {
        SocialBlobsTypes.Dispute storage dispute = _disputes[messageHash];

        if (dispute.status != SocialBlobsTypes.DisputeStatus.Challenged) {
            revert DisputeNotFound(messageHash);
        }

        if (block.timestamp < dispute.resolveDeadline) revert DeadlineNotReached(messageHash);

        // Resolution deadline passed without resolution - challenger wins by default
        uint256 stake = _stakes[messageHash];
        address challenger = dispute.challenger;

        dispute.status = SocialBlobsTypes.DisputeStatus.Rejected;
        _stakes[messageHash] = 0;

        (bool sent,) = challenger.call{ value: stake }("");
        require(sent, "Transfer failed");

        emit DisputeResolved(messageHash, false, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IDisputeManager
    function isDisputed(bytes32 messageHash) external view returns (bool disputed) {
        return _disputes[messageHash].status == SocialBlobsTypes.DisputeStatus.Challenged;
    }

    /// @inheritdoc IDisputeManager
    function getDispute(bytes32 messageHash)
        external
        view
        returns (SocialBlobsTypes.Dispute memory dispute)
    {
        dispute = _disputes[messageHash];
        if (dispute.challengedAt == 0) revert DisputeNotFound(messageHash);
    }

    /// @inheritdoc IDisputeManager
    function challengeWindow() external view returns (uint256 window) {
        return _challengeWindow;
    }

    /// @inheritdoc IDisputeManager
    function challengeStake() external view returns (uint256 stake) {
        return _challengeStake;
    }

    /// @notice Check if challenge window is still open for a message
    /// @param messageHash Hash of the message
    /// @return open True if challenge window is open
    function isChallengeWindowOpen(bytes32 messageHash) external view returns (bool open) {
        if (!exposureRecord.isExposed(messageHash)) return false;
        SocialBlobsTypes.ExposedTweet memory exposure = exposureRecord.getExposure(messageHash);
        return block.timestamp <= exposure.exposedAt + _challengeWindow;
    }
}
