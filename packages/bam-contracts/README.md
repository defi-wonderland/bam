# bam-contracts

Solidity smart contracts for the BAM (Blob Authenticated Messaging) protocol.

## Overview

The contract system follows a "dumb inbox" architecture where the core contract is stateless
and only emits events. All verification logic (exposure, signatures, etc.) lives in the
application layer.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                            │
├───────────────────────────────────────────────────────────────────────┤
│  BLSExposer          │  Other Exposers...   │  Custom Apps          │
│  - KZG verification  │  - ECDSA Exposer     │  - Voting             │
│  - BLS signature     │  - ZK Exposer (v2)   │  - Reputation         │
│  - Registration check│                      │  - etc.               │
├───────────────────────────────────────────────────────────────────────┤
│                            CORE LAYER                                │
├───────────────────────────────────────────────────────────────────────┤
│  SocialBlobsCore (Stateless)         │  BLSRegistry                 │
│  - registerBlob(blobIndex)           │  - register(pubKey, popSig)  │
│  - registerCalldata(batchData)       │  - rotate(newPubKey, popSig) │
│  - Emits events only, no storage     │  - revoke()                  │
├───────────────────────────────────────────────────────────────────────┤
│                        VERIFICATION LAYER                            │
├───────────────────────────────────────────────────────────────────────┤
│  SimpleBoolVerifier (V1)             │  Future: ZK/Receipt Verifiers│
│  - Permissionless registration       │  - STARK proofs              │
│  - Boolean mapping                   │  - Transaction receipts      │
├───────────────────────────────────────────────────────────────────────┤
│                           LIBRARIES                                  │
├───────────────────────────────────────────────────────────────────────┤
│  BLSVerifier   │  KZGVerifier     │  BLS12381       │ BLSDecompression│
│  - verify()    │  - verifyProof() │  - Field ops    │ - G1/G2 decomp  │
│  - EIP-2537    │  - EIP-4844 0x0A │  - 384-bit math │ - Point valid   │
└───────────────────────────────────────────────────────────────────────┘
```

## Contracts

### Core

| Contract | Description |
|----------|-------------|
| `SocialBlobsCore` | Zero-storage registrar — emits `BlobRegistered` / `CalldataRegistered` events |
| `BlobAuthenticatedMessagingCore` | ERC-BAM compliant wrapper — blob segment declaration + batch registration |
| `BLSRegistry` | BLS12-381 public key registry with Proof of Possession |
| `BlobSpaceSegments` | ERC-BSS implementation for field element sub-ranges |

### Application Layer

| Contract | Description |
|----------|-------------|
| `BLSExposer` | On-chain message exposure with KZG proofs + BLS verification |
| `SimpleBoolVerifier` | V1 registration verifier (permissionless boolean mapping) |
| `ABIDecoder` | Untrusted batch decoder for message extraction |

### Libraries

| Library | Description |
|---------|-------------|
| `BLSVerifier` | BLS12-381 signature verification via EIP-2537 precompiles |
| `KZGVerifier` | KZG proof verification via EIP-4844 point evaluation precompile (0x0A) |
| `BLS12381` | Pure Solidity 384-bit field arithmetic |
| `BLSDecompression` | G1/G2 point decompression |

### Peripheral

| Contract | Description |
|----------|-------------|
| `DictionaryRegistry` | Compression dictionary versioning |
| `ExposureRecord` | Optional exposure metadata storage |
| `DisputeManager` | Challenge/dispute resolution |
| `StakeManager` | Aggregator staking and slashing |

## Development

```bash
# Install dependencies
forge install

# Build
forge build

# Test (234 tests, 1000 fuzz runs)
forge test

# Test with verbosity
forge test -vvv

# Gas report
forge test --gas-report

# Format
forge fmt
```

### Configuration

- Solidity 0.8.24, Cancun EVM target
- Optimizer: 200 runs, via IR
- Fuzz: 1000 runs (default), 10000 (CI)

## Deployed Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| SocialBlobsCore | `0xAdd498490f0Ffc1ba15af01D6Bf6374518fE0969` |
| BLSRegistry | `0x2146758C8f24e9A0aFf98dF3Da54eef9f53BCFbf` |
| BLSExposer | `0x0136454b435fE6cCa5F7b8A6a8cFB5B549afB717` |
| SimpleBoolVerifier | `0x5163647B0057C5d07e568220AdD45D36C6b86C1b` |

## License

MIT
