// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IStakeManager } from "../interfaces/IStakeManager.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StakeManager
/// @notice Manages stakes for exposure claims
/// @dev Standalone peripheral contract for staking. Can be queried by exposer wrappers.
///      No longer implements IExposureHook - use StakedExposer wrapper instead.
contract StakeManager is IStakeManager, Ownable, ReentrancyGuard {
    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Default exposure stake: 0.01 ETH
    uint256 public constant DEFAULT_EXPOSURE_STAKE = 0.01 ether;

    /// @dev Withdrawal delay after deposit (must match dispute window)
    uint256 public constant WITHDRAWAL_DELAY = 24 hours;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @dev Address of the DisputeManager (authorized to slash)
    address public disputeManager;

    /// @dev Required stake amount for exposures
    uint256 private _exposureStake;

    /// @dev Stake record
    struct StakeRecord {
        address staker;
        uint256 amount;
        uint64 depositedAt;
        bool active;
    }

    /// @dev Mapping from message hash to stake record
    mapping(bytes32 => StakeRecord) private _stakes;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @param owner_ Owner address for admin functions
    constructor(address owner_) Ownable(owner_) {
        _exposureStake = DEFAULT_EXPOSURE_STAKE;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Set required exposure stake
    /// @param stake New stake amount in wei
    function setExposureStake(uint256 stake) external onlyOwner {
        _exposureStake = stake;
    }

    /// @notice Set dispute manager address (authorized to slash)
    /// @param disputeManager_ Address of DisputeManager
    function setDisputeManager(address disputeManager_) external onlyOwner {
        disputeManager = disputeManager_;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════════

    modifier onlyDisputeManager() {
        if (msg.sender != disputeManager) revert NotAuthorized();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // STAKING
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IStakeManager
    function deposit(bytes32 messageHash) external payable nonReentrant {
        if (msg.value < _exposureStake) revert InsufficientStake(_exposureStake, msg.value);

        StakeRecord storage stake = _stakes[messageHash];

        if (stake.active) revert StakeAlreadyExists(messageHash);

        stake.staker = msg.sender;
        stake.amount = msg.value;
        stake.depositedAt = uint64(block.timestamp);
        stake.active = true;

        emit StakeDeposited(messageHash, msg.sender, msg.value);
    }

    /// @inheritdoc IStakeManager
    function withdraw(bytes32 messageHash) external nonReentrant {
        StakeRecord storage stake = _stakes[messageHash];

        if (!stake.active) revert NoStakeExists(messageHash);

        if (stake.staker != msg.sender) revert NotAuthorized();

        // Check withdrawal delay has passed
        if (block.timestamp < stake.depositedAt + WITHDRAWAL_DELAY) {
            revert WithdrawalNotAllowed(messageHash);
        }

        uint256 amount = stake.amount;
        stake.active = false;
        stake.amount = 0;

        (bool sent,) = msg.sender.call{ value: amount }("");
        require(sent, "Transfer failed");

        emit StakeWithdrawn(messageHash, msg.sender, amount);
    }

    /// @inheritdoc IStakeManager
    function slash(bytes32 messageHash, address challenger)
        external
        onlyDisputeManager
        nonReentrant
    {
        StakeRecord storage stake = _stakes[messageHash];

        if (!stake.active) revert NoStakeExists(messageHash);

        uint256 amount = stake.amount;
        address staker = stake.staker;

        stake.active = false;
        stake.amount = 0;

        // Transfer stake to challenger
        (bool sent,) = challenger.call{ value: amount }("");
        require(sent, "Transfer failed");

        emit StakeSlashed(messageHash, staker, challenger, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IStakeManager
    function exposureStake() external view returns (uint256 stake) {
        return _exposureStake;
    }

    /// @inheritdoc IStakeManager
    function getStake(bytes32 messageHash)
        external
        view
        returns (address staker, uint256 amount, uint64 depositedAt)
    {
        StakeRecord storage stake = _stakes[messageHash];
        return (stake.staker, stake.amount, stake.depositedAt);
    }

    /// @notice Check if stake is active for a message
    /// @param messageHash Hash of the message
    /// @return active True if stake is active
    function isStakeActive(bytes32 messageHash) external view returns (bool active) {
        return _stakes[messageHash].active;
    }

    /// @notice Check if stake is valid for exposure
    /// @dev Called by exposer wrappers to verify stake before exposure
    /// @param messageHash Hash of the message
    /// @param exposer Address attempting to expose
    /// @return valid True if stake is valid for this exposer
    function hasValidStake(bytes32 messageHash, address exposer)
        external
        view
        returns (bool valid)
    {
        StakeRecord storage stake = _stakes[messageHash];
        return stake.active && stake.amount >= _exposureStake && stake.staker == exposer;
    }

    /// @notice Check if withdrawal is allowed
    /// @param messageHash Hash of the message
    /// @return allowed True if withdrawal is allowed
    function canWithdraw(bytes32 messageHash) external view returns (bool allowed) {
        StakeRecord storage stake = _stakes[messageHash];
        return stake.active && block.timestamp >= stake.depositedAt + WITHDRAWAL_DELAY;
    }
}
