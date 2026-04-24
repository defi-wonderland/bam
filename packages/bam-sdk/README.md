# bam-sdk

Reference TypeScript SDK for the BAM (Blob Authenticated Messaging) protocol, built by
[Wonderland](https://wonderland.xyz). Encode messages, compress batches, sign with BLS/ECDSA,
generate KZG proofs, and interact with on-chain contracts.

## Signature schemes

BAM messages are signed under ERC-8180's
`messageHash = keccak256(sender ‖ nonce ‖ contents)` (chain-agnostic,
exported as `computeMessageHash`). The wire format mandates a
32-byte `contentTag` prefix in `contents`; every scheme that signs over
`contents` therefore binds the tag.

- **Scheme 0x01 (ECDSA-secp256k1).** All ECDSA signing in this SDK
  uses **EIP-712 typed data over `BAMMessage`** with domain
  `{ name: "BAM", version: "1", chainId }`. Wallet callers use
  `signECDSA(walletClient, message)`; headless callers use
  `signECDSAWithKey(privateKey, message, chainId)`. Both paths
  produce byte-identical 65-byte signatures over the same digest;
  a single `verifyECDSA(message, signature, expectedSender,
  chainId)` rebuilds the digest and `ecrecover`s. Low-s is enforced;
  `v ∈ {27, 28}`. Cross-chain replay is blocked by the chainId field
  in the signing domain.

  This is a reference-implementation choice within the space
  ERC-8180 §Rationale 847–852 already permits — the ERC's default
  `signedHash = keccak256(domain ‖ messageHash)` construction is
  **not** used here for scheme 0x01. The choice is deliberate: EIP-712
  gives consistent wallet / headless UX without an
  EIP-191-vs-raw-hash digest fork.

- **Scheme 0x02 (BLS-12-381) building blocks.** `signBLS`,
  `verifyBLS`, `aggregateBLS`, `verifyAggregateBLS`, and the BLS
  (de)serializers are retained so non-ECDSA schemes can be wired up
  later. No BLS validator is wired into any Poster or ingest path
  in this feature.

- **Registry lookup.** The default Poster validator is
  `ecrecover`-native per ERC-8180 §Signature Registry #8 and does
  not read any on-chain registry.

## Install

```bash
pnpm add bam-sdk
```

## Quick Start

```typescript
import {
  computeMessageHash,
  encodeBatch,
  encodeContents,
  hexToBytes,
  signECDSAWithKey,
  verifyECDSA,
  generateECDSAPrivateKey,
  deriveAddress,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

// Generate keys — the sender address is derived from your signing key.
const privateKey = generateECDSAPrivateKey();
const sender = deriveAddress(privateKey);

// BAM messages carry a 32-byte `contentTag` prefix at the start of
// `contents`; everything after the prefix is app-opaque.
const contentTag = ('0x' + '01'.repeat(32)) as Bytes32;
const appBytes = new TextEncoder().encode('Hello from BAM!');

const message: BAMMessage = {
  sender,
  nonce: 0n,
  contents: encodeContents(contentTag, appBytes),
};

// Pre-batch identifier — chain-agnostic; stable across the message's lifetime.
const messageHash = computeMessageHash(message.sender, message.nonce, message.contents);

// Sign under ERC-8180 scheme 0x01 (EIP-712 typed data over BAMMessage).
const chainId = 11_155_111; // Sepolia
const signature = signECDSAWithKey(privateKey as `0x${string}`, message, chainId);

// Verify — returns `false` on tamper, length != 65, wrong chain id, high-s, etc.
const valid = verifyECDSA(message, signature, sender, chainId);

// Encode a batch for blob submission. Signatures are parallel to messages.
const batch = encodeBatch([message], [hexToBytes(signature)]);
```

### Contract Client

```typescript
import { BAMClient, getDeployment } from 'bam-sdk';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Look up deployed addresses for Sepolia
const deployment = getDeployment(sepolia.id)!;

const client = new BAMClient({
  chain: sepolia,
  rpcUrl: 'https://rpc.sepolia.org',
  coreAddress: deployment.contracts.SocialBlobsCore!.address,
  blsExposerAddress: deployment.contracts.BLSExposer!.address,
  account: privateKeyToAccount('0x...'),
});

// Register a calldata batch
const result = await client.registerCalldata(batch.data);

// Expose a message on-chain
const exposure = await client.expose(exposureParams);
```

## Browser Usage

The SDK provides a browser-safe entrypoint that excludes modules depending on Node.js built-ins
(`node:fs`, `node:crypto`) and native addons (`c-kzg`):

```typescript
import { computeMessageHash, verifyECDSA, encodeBatch } from 'bam-sdk/browser';
```

The `bam-sdk/browser` entrypoint re-exports everything from the main barrel except:
- `kzg/` (c-kzg native module)
- `compression-node` (`loadBundledDictionary`, `loadDictionaryFromFile`)
- `exposure/blob-parser` and `exposure/builder` (depend on kzg/proof-generator)

This works in Next.js client components, Vite, and other browser bundlers without errors.

## API

### Protocol Layer

| Module | Exports |
|--------|---------|
| **Message** | `computeMessageHash`, `computeMessageId`, `encodeContents`, `splitContents`, `hexToBytes`, `bytesToHex` |
| **Batch** | `encodeBatch`, `decodeBatch`, `estimateBatchSize` — operate on `BAMMessage[]` + parallel signatures |
| **Batch (Exposure)** | `encodeExposureBatch`, `decodeExposureBatch`, `buildRawMessageBytes` |
| **BPE Codec** | `bpeEncode`, `bpeDecode`, `buildBPEDictionary`, `serializeBPEDictionary`, `deserializeBPEDictionary` |
| **Compression (Zstd)** | `compress`, `decompress`, `loadDictionary`, `isCompressed`, `compressionRatio` |
| **Compression (Node)** | `loadBundledDictionary`, `loadDictionaryFromFile` — requires `node:fs`, `node:crypto` |
| **Signatures (ECDSA scheme 0x01)** | `signECDSA` (wallet), `signECDSAWithKey` (headless), `verifyECDSA`, `computeECDSADigest`, `EIP712_DOMAIN_NAME`, `EIP712_DOMAIN_VERSION`, `EIP712_TYPES` |
| **Signatures (BLS scheme 0x02, building blocks)** | `signBLS`, `verifyBLS`, `aggregateBLS`, `verifyAggregateBLS` |
| **Key Management** | `generateBLSPrivateKey`, `deriveBLSPublicKey`, `generateECDSAPrivateKey`, `deriveAddress` |

### On-Chain Layer

| Module | Exports |
|--------|---------|
| **KZG** | `commitToBlob`, `generateProofsForByteRange`, `verifyProofBatch` |
| **Exposure** | `parseBlobForMessages`, `buildExposureParams`, `buildCalldataExposureParams` |
| **Client** | `BAMClient`, `createClient`, `BAM_CORE_ABI`, `BAM_DECODER_ABI` |
| **Deployments** | `getDeployment`, `getAllDeployments` |

### Aggregator

| Module | Exports |
|--------|---------|
| **AggregatorClient** | `AggregatorClient` — HTTP client for aggregator nodes (submit, status, health) |

## Batch Encoding

The SDK provides two batch encoding paths for different use cases:

### Compact Batch (`encodeBatch` / `decodeBatch`)

Space-efficient encoding using author tables and timestamp deltas. Supports BPE and Zstd
compression. Messages are NOT individually KZG-addressable — use this for aggregator-mediated
messaging where on-chain exposure is not needed.

```typescript
import { encodeBatch, decodeBatch } from 'bam-sdk';

const batch = encodeBatch(signedMessages, { codec: 'bpe', dictionary });
const decoded = decodeBatch(batch.data, { data: dictionary, id: 0 });
```

### Exposure Batch (`encodeExposureBatch` / `decodeExposureBatch`)

Each message is stored in on-chain raw format `[author(20)][timestamp(4)][nonce(2)][content]`,
making it directly verifiable via KZG proofs and `BLSExposer.expose()`. Use this when you need
per-message on-chain exposure.

```typescript
import { encodeExposureBatch, decodeExposureBatch } from 'bam-sdk';

const batch = encodeExposureBatch(messages);
// batch.messageOffsets[i] points to rawBytes in the batch data
// batch.messageLengths[i] is the rawBytes length
// These are the exact values needed for KZG proof generation

const decoded = decodeExposureBatch(batch.data);
```

The exposure format uses a different magic (`SOB2`) and stores messages with 2-byte length
prefixes followed by raw bytes. KZG proofs target the raw bytes directly (past the length
prefix), so extracted bytes match exactly what the BLSExposer contract verifies.

**Full exposure flow:**
```
encodeExposureBatch() → createBlob() → registerBlob()
                                     → parseBlob() → buildExposureParams() → BLSExposer.expose()
```

## Compression

The SDK supports two compression codecs, specified via the `codec` option on `encodeBatch`:

| Codec | ID | Status | Ratio | Dependencies |
|-------|----|--------|-------|-------------|
| **BPE** | `0x01` | Working | ~30-40% reduction | None (pure TypeScript) |
| **Zstd** | `0x02` | Decompression only | 9.17x (benchmarked) | `fzstd` (decompression-only) |

The codec ID is stored in the batch header so `decodeBatch` automatically routes to the correct
decompressor — no configuration needed on the read side.

### BPE (recommended)

BPE (Byte-Pair Encoding) is a pure TypeScript codec with zero dependencies. Build a dictionary
from a corpus, serialize it, and pass it to `encodeBatch`:

```typescript
import { buildBPEDictionary, serializeBPEDictionary, encodeBatch, decodeBatch } from 'bam-sdk';

// Build dictionary from training corpus (do this once)
const dict = buildBPEDictionary(corpusBytes);
const serialized = serializeBPEDictionary(dict);

// Encode with BPE compression
const batch = encodeBatch(messages, { codec: 'bpe', dictionary: serialized });

// Decode — reads codec byte from header, no codec option needed
const decoded = decodeBatch(batch.data, { data: serialized, id: 0 });
```

The dictionary is identified by its keccak hash in the `dictionaryRef` header field. Different
dictionaries can be used for different batches — the decoder just needs access to the matching
dictionary.

### Zstd (future)

The SDK bundles a trained Zstd dictionary (`data/dictionaries/v1.dict`) and supports Zstd
decompression via `fzstd`. Zstd compression is not yet implemented (requires a WASM or native
Zstd library). See `ISSUE_COMPRESSION_CODEC.md` at the repo root for the plan.

> **Note:** `loadBundledDictionary` and `loadDictionaryFromFile` are Node-only (they use `node:fs`
> and `node:crypto`). In the browser, use `loadDictionary(bytes)` with dictionary bytes fetched
> from a URL or bundled as a static asset.

## Development

```bash
# Build
pnpm build

# Unit tests (122)
pnpm test:run

# Integration tests (37, requires Anvil)
pnpm test:integration

# Lint
pnpm lint
```

### ABI Sync

Contract ABIs are auto-generated from Foundry build output. After changing Solidity interfaces:

```bash
# From workspace root
pnpm sync:abis
```

## About

This is a reference implementation — see the [BAM protocol specs](../../docs/specs/) for the full
specification. Built by [Wonderland](https://wonderland.xyz).

## License

MIT
