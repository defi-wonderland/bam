// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStakeManager
/// @notice Interface for stake management (optional peripheral)
/// @dev Handles staking for exposure claims
interface IStakeManager {
    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Emitted when stake is deposited
    /// @param messageHash Hash of the message
    /// @param staker Address that deposited stake
    /// @param amount Amount deposited
    event StakeDeposited(bytes32 indexed messageHash, address indexed staker, uint256 amount);

    /// @notice Emitted when stake is withdrawn
    /// @param messageHash Hash of the message
    /// @param staker Address that withdrew stake
    /// @param amount Amount withdrawn
    event StakeWithdrawn(bytes32 indexed messageHash, address indexed staker, uint256 amount);

    /// @notice Emitted when stake is slashed
    /// @param messageHash Hash of the message
    /// @param staker Address whose stake was slashed
    /// @param challenger Address that receives the stake
    /// @param amount Amount slashed
    event StakeSlashed(
        bytes32 indexed messageHash,
        address indexed staker,
        address indexed challenger,
        uint256 amount
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Thrown when stake is insufficient
    error InsufficientStake(uint256 required, uint256 provided);

    /// @notice Thrown when stake already exists for message
    error StakeAlreadyExists(bytes32 messageHash);

    /// @notice Thrown when no stake exists for message
    error NoStakeExists(bytes32 messageHash);

    /// @notice Thrown when withdrawal is not allowed yet
    error WithdrawalNotAllowed(bytes32 messageHash);

    /// @notice Thrown when caller is not authorized
    error NotAuthorized();

    // ═══════════════════════════════════════════════════════════════════════════════
    // STAKING
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Deposit stake for an exposure
    /// @param messageHash Hash of the message being exposed
    function deposit(bytes32 messageHash) external payable;

    /// @notice Withdraw stake after challenge window
    /// @param messageHash Hash of the message
    function withdraw(bytes32 messageHash) external;

    /// @notice Slash stake for fraudulent exposure
    /// @param messageHash Hash of the message
    /// @param challenger Address to receive the stake
    function slash(bytes32 messageHash, address challenger) external;

    // ═══════════════════════════════════════════════════════════════════════════════
    // QUERIES
    // ═══════════════════════════════════════════════════════════════════════════════

    /// @notice Get stake requirement for exposures
    /// @return stake Required stake amount in wei
    function exposureStake() external view returns (uint256 stake);

    /// @notice Check stake status
    /// @param messageHash Hash of the message
    /// @return staker Address that deposited stake
    /// @return amount Stake amount
    /// @return depositedAt Timestamp when stake was deposited
    function getStake(bytes32 messageHash)
        external
        view
        returns (address staker, uint256 amount, uint64 depositedAt);
}
