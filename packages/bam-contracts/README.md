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
│  - Optional IRegistrationHook        │                              │
├───────────────────────────────────────────────────────────────────────┤
│                        VERIFICATION LAYER                            │
├───────────────────────────────────────────────────────────────────────┤
│  SimpleBoolVerifier (V1)             │  Future: ZK/Receipt Verifiers│
│  - IRegistrationHook (from Core)     │  - STARK proofs              │
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
| `SocialBlobsCore` | Zero-storage registrar — emits `BlobRegistered` / `CalldataRegistered` events. Optional `IRegistrationHook` for atomic verifier registration |
| `BlobAuthenticatedMessagingCore` | ERC-BAM compliant wrapper — blob segment declaration + batch registration |
| `BLSRegistry` | BLS12-381 public key registry with Proof of Possession |
| `ECDSARegistry` | ERC-8180 scheme-`0x01` ECDSA key registry — supports keyed and keyless verification paths |
| `SignatureRegistryDispatcher` | ERC-8180 dispatcher — routes verification calls to the scheme-specific registry (BLS / ECDSA) |
| `BlobSpaceSegments` | ERC-BSS implementation for field element sub-ranges |

### Application Layer

| Contract | Description |
|----------|-------------|
| `BLSExposer` | On-chain message exposure with KZG proofs + BLS verification |
| `SimpleBoolVerifier` | V1 registration verifier — implements `IRegistrationHook` for atomic registration from Core. Access-controlled: only the linked Core can register hashes |
| `IRegistrationHook` | Callback interface for Core to notify verifiers atomically on registration |
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

## Registration Hook

`SocialBlobsCore` accepts an optional `IRegistrationHook` at deploy time. When set, the hook is
called atomically after each `registerBlob` / `registerCalldata`, allowing a verifier to record
the content hash in the same transaction. When set to `address(0)`, no external call is made
and the core operates at zero overhead (the default for the demo app).

This solves a trust gap: without the hook, the `SimpleBoolVerifier` was permissionless — anyone
could call `register()` with an arbitrary hash, undermining the exposer's registration check.
With the hook, only the core contract can register hashes in the verifier.

### Deployment patterns

**Demo app (no on-chain exposure needed):**
```solidity
SocialBlobsCore core = new SocialBlobsCore(address(0));  // no hook
```

**Full deployment (on-chain exposure via BLSExposer):**
```solidity
SimpleBoolVerifier verifier = new SimpleBoolVerifier();
SocialBlobsCore core = new SocialBlobsCore(address(verifier));
verifier.setCore(address(core));  // one-time link, cannot be changed
```

`setCore()` resolves the chicken-and-egg problem: the core needs the verifier address at deploy,
and the verifier needs the core address to restrict `onRegistered()`. The call can only be made
once — after that, the link is permanent.

## Development

```bash
# Install dependencies
forge install

# Build
forge build

# Test (1000 fuzz runs by default)
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
| BlobAuthenticatedMessagingCore | `0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314` |
| SocialBlobsCore (legacy) | `0x11a825a0774d0471292eab4706743bffcdd5d137` |
| BLSRegistry | `0x15866bf5a8724f2aa9fe75e262d8f00ba2818e25` |
| ECDSARegistry | `0xF4Ce909305a112C2CBEC6b339a42f34bA8bf3381` |
| SignatureRegistryDispatcher | `0x3431A94c9132b8a1b0c4aE8a80E7Ef0F0EC630Cf` |
| BLSExposer | `0x443029b4b96fbf2d8feba77d828a394d19615a48` |
| SimpleBoolVerifier | `0xdec5faa3e32d6296e53bae7e359e059b58a482f4` |

## Future Work

- **On-chain BPE Decoder**: Deploy a contract with an embedded compression dictionary that can decompress BPE-encoded batch payloads on-chain. This would enable fully on-chain message extraction without relying on off-chain decompression. See SocialBlobs' `decoder.vy` for a reference Vyper implementation using 12-bit codes and a 10KB dictionary injected at deploy time.

## License

MIT
