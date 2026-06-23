# bam-contracts

Solidity smart contracts for the BAM (Blob Authenticated Messaging) protocol.

## Overview

The contract system follows a "dumb inbox" architecture: the core contract is stateless and
only emits events (ERC-8180). Decoding, signature verification, and exposure live in the
application layer. A batch's registration is discovered off-chain from the core's event log.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                            │
├───────────────────────────────────────────────────────────────────────┤
│  BLSExposer          │  Other Exposers...   │  Custom Apps          │
│  - KZG verification  │  - ECDSA Exposer     │  - Voting             │
│  - BLS signature     │  - ZK Exposer (v2)   │  - Reputation         │
│  - MessageExposed    │                      │  - etc.               │
├───────────────────────────────────────────────────────────────────────┤
│                            CORE LAYER                                │
├───────────────────────────────────────────────────────────────────────┤
│  BlobAuthenticatedMessagingCore      │  BLSRegistry                 │
│  - registerBlobBatch(...)            │  - register(pubKey, popSig)  │
│  - registerCalldataBatch(...)        │  - rotate(newPubKey, popSig) │
│  - Emits events only, no storage     │  - revoke()                  │
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
| `BlobAuthenticatedMessagingCore` | ERC-BAM compliant core — blob segment declaration + batch registration. Zero-storage; emits `BlobBatchRegistered` / `CalldataBatchRegistered` |
| `BLSRegistry` | BLS12-381 public key registry with Proof of Possession |
| `ECDSARegistry` | ERC-8180 scheme-`0x01` ECDSA key registry — supports keyed and keyless verification paths |
| `SignatureRegistryDispatcher` | ERC-8180 dispatcher — routes verification calls to the scheme-specific registry (BLS / ECDSA) |
| `BlobSpaceSegments` | ERC-BSS implementation for field element sub-ranges |

### Application Layer

| Contract | Description |
|----------|-------------|
| `BLSExposer` | On-chain message exposure with KZG proofs + BLS verification |
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

## Registration verification

The BAM core is events-only: `registerBlobBatch` / `registerCalldataBatch` emit
`BlobBatchRegistered` / `CalldataBatchRegistered` and write nothing. A batch's registration is
therefore proven off-chain by reading that event from the log — or, trustlessly, via a
Merkle-Patricia proof of the transaction receipt against a block header's `receiptsRoot`.

`BLSExposer` does not re-check registration on-chain. The KZG proof at exposure time already
proves the exposed bytes were in the blob behind the versioned hash, and the BLS signature
proves authorship against the trusted registry — together a stronger guarantee than a stored
boolean. (Earlier revisions used a `SimpleBoolVerifier` populated by an `IRegistrationHook` on a
stateful `SocialBlobsCore`; that re-introduced the per-batch `SSTORE` the zero-storage core
exists to avoid, and has been removed.)

### Deployment pattern

```solidity
BlobAuthenticatedMessagingCore core = new BlobAuthenticatedMessagingCore();
BLSRegistry blsRegistry = new BLSRegistry();
BLSExposer exposer = new BLSExposer(address(core), address(blsRegistry), address(0));
```

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
| BlobAuthenticatedMessagingCore | `0xC572A7F6dba1f3cB666b14d357671903685BeDdb` |
| BLSRegistry | `0x15866bf5a8724f2aa9fe75e262d8f00ba2818e25` |
| ECDSARegistry | `0xF4Ce909305a112C2CBEC6b339a42f34bA8bf3381` |
| SignatureRegistryDispatcher | `0x3431A94c9132b8a1b0c4aE8a80E7Ef0F0EC630Cf` |
| BLSExposer | _redeploy pending_ (constructor changed; registration gate removed) |
| SocialBlobsCore (legacy, removed) | `0x11a825a0774d0471292eab4706743bffcdd5d137` |
| SimpleBoolVerifier (removed) | `0xdec5faa3e32d6296e53bae7e359e059b58a482f4` |

## Future Work

- **On-chain BPE Decoder**: Deploy a contract with an embedded compression dictionary that can decompress BPE-encoded batch payloads on-chain. This would enable fully on-chain message extraction without relying on off-chain decompression. See SocialBlobs' `decoder.vy` for a reference Vyper implementation using 12-bit codes and a 10KB dictionary injected at deploy time.

## License

MIT
