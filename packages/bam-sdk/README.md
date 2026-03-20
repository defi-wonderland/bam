# bam-sdk

Reference TypeScript SDK for the BAM (Blob Authenticated Messaging) protocol, built by
[Wonderland](https://wonderland.xyz). Encode messages, compress batches, sign with BLS/ECDSA,
generate KZG proofs, and interact with on-chain contracts.

## Install

```bash
pnpm add bam-sdk
```

## Quick Start

```typescript
import {
  encodeMessage,
  encodeBatch,
  signECDSA,
  generateECDSAPrivateKey,
  deriveAddress,
  computeMessageHash,
} from 'bam-sdk';

// Generate keys — the author address is derived from your signing key
const privateKey = generateECDSAPrivateKey();
const author = deriveAddress(privateKey);

const message = {
  author,
  timestamp: Math.floor(Date.now() / 1000),
  nonce: 0,
  content: 'Hello from BAM!',
};

const hash = computeMessageHash(message);
const signature = await signECDSA(privateKey, hash);

// Encode for wire format
const encoded = encodeMessage({
  ...message,
  signature,
  signatureType: 'ecdsa',
});

// Batch multiple messages with BPE compression
const batch = encodeBatch(signedMessages, {
  codec: 'bpe',
  dictionary: bpeDictionaryBytes,
});
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
import { computeMessageHash, verifyECDSA, encodeMessage } from 'bam-sdk/browser';
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
| **Message** | `encodeMessage`, `decodeMessage`, `computeMessageHash`, `computeMessageId` |
| **Batch** | `encodeBatch`, `decodeBatch`, `estimateBatchSize`, `validateBatch`, `buildAuthorTable` |
| **BPE Codec** | `bpeEncode`, `bpeDecode`, `buildBPEDictionary`, `serializeBPEDictionary`, `deserializeBPEDictionary` |
| **Compression (Zstd)** | `compress`, `decompress`, `loadDictionary`, `isCompressed`, `compressionRatio` |
| **Compression (Node)** | `loadBundledDictionary`, `loadDictionaryFromFile` — requires `node:fs`, `node:crypto` |
| **Signatures** | `signBLS`, `verifyBLS`, `aggregateBLS`, `signECDSA`, `verifyECDSA`, `recoverAddress` |
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

# Unit tests (109)
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
