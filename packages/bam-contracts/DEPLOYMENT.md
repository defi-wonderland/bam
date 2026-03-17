# Contract Deployment Guide

This guide covers deploying Social-Blobs contracts following Wonderland best practices.

## Prerequisites

- [Foundry](https://getfoundry.sh/) installed
- Ethereum account with sufficient ETH
- RPC endpoint for target network

## Quick Start

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Edit .env with your configuration
# Set PRIVATE_KEY, RPC URLs, and ETHERSCAN_API_KEY

# 3. Deploy to Sepolia (testnet)
forge script script/Deploy.s.sol:DeployTestnet \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify

# 4. Verify deployment
SOCIAL_BLOBS_CORE=0x... BLS_REGISTRY=0x... BLS_EXPOSER=0x... \
forge script script/Verify.s.sol:VerifyDeployment \
  --rpc-url $SEPOLIA_RPC_URL
```

## Deployment Scripts

| Script              | Purpose                                      | Command                                              |
| ------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `DeploySocialBlobs` | Basic deployment (Core + Registry + Exposer) | `forge script script/Deploy.s.sol:DeploySocialBlobs` |
| `DeployTestnet`     | Testnet with balance checks                  | `forge script script/Deploy.s.sol:DeployTestnet`     |
| `DeployFull`        | All contracts including peripherals          | `forge script script/Deploy.s.sol:DeployFull`        |

## Verification Scripts

| Script             | Purpose                      | Command                                             |
| ------------------ | ---------------------------- | --------------------------------------------------- |
| `VerifyDeployment` | Full deployment verification | `forge script script/Verify.s.sol:VerifyDeployment` |
| `HealthCheck`      | Quick health check           | `forge script script/Verify.s.sol:HealthCheck`      |

## Deployment Flow (Wonderland Pattern)

```
1. Build     → forge build
2. Test      → forge test
3. Deploy    → forge script ... --broadcast
4. Verify    → forge verify-contract ...
5. Health    → forge script Verify.s.sol:HealthCheck
```

## Network Configuration

| Network | Chain ID | RPC Variable      | Notes               |
| ------- | -------- | ----------------- | ------------------- |
| Mainnet | 1        | `MAINNET_RPC_URL` | Production          |
| Sepolia | 11155111 | `SEPOLIA_RPC_URL` | Recommended testnet |
| Holesky | 17000    | `HOLESKY_RPC_URL` | Alternative testnet |
| Local   | 31337    | `LOCAL_RPC_URL`   | Anvil               |

## Local Development

```bash
# Terminal 1: Start local node
anvil

# Terminal 2: Deploy locally
forge script script/Deploy.s.sol:DeploySocialBlobs \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast
```

## Contract Verification on Etherscan

```bash
# Verify SocialBlobsCore (no constructor args)
forge verify-contract $SOCIAL_BLOBS_CORE \
  src/core/SocialBlobsCore.sol:SocialBlobsCore \
  --chain-id 11155111 \
  --watch

# Verify BLSExposer (with constructor args)
forge verify-contract $BLS_EXPOSER \
  src/exposers/BLSExposer.sol:BLSExposer \
  --chain-id 11155111 \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" $SOCIAL_BLOBS_CORE $BLS_REGISTRY 0x0000000000000000000000000000000000000000) \
  --watch
```

## Deployed Addresses

### Sepolia (Testnet)

| Contract        | Address |
| --------------- | ------- |
| SocialBlobsCore | `0x...` |
| BLSRegistry     | `0x...` |
| BLSExposer      | `0x...` |

> Update these after deployment!

## Rollback Procedure

All core contracts are **immutable and permissionless**. Rollback means deploying new versions:

1. Deploy new contracts
2. Update client configurations
3. Old contracts remain functional (no migration needed)

## Security Checklist

- [ ] Private key stored securely (use `cast wallet import`)
- [ ] Verified correct network before deployment
- [ ] Checked deployer balance is sufficient
- [ ] Ran `forge test` before deployment
- [ ] Verified contracts on block explorer
- [ ] Ran `VerifyDeployment` script
- [ ] Updated deployed addresses documentation
