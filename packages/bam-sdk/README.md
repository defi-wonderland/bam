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

// Batch multiple messages (with 9x+ Zstd compression)
const batch = encodeBatch(signedMessages, { compress: true });
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
| **Compression** | `compress`, `decompress`, `loadDictionary`, `isCompressed`, `compressionRatio` |
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

The SDK bundles a trained Zstd dictionary (`data/dictionaries/v1.dict`) that achieves 9.17x
compression on social media text at batch size 100. Load it with:

```typescript
import { loadBundledDictionary, compress, decompress } from 'bam-sdk';

const dict = await loadBundledDictionary(); // Node.js only
const compressed = compress(data, dict);
const original = decompress(compressed, dict);
```

> **Note:** `loadBundledDictionary` and `loadDictionaryFromFile` are Node-only (they use `node:fs`
> and `node:crypto`). In the browser, use `loadDictionary(bytes)` with dictionary bytes fetched
> from a URL or bundled as a static asset.

## Development

```bash
# Build
pnpm build

# Unit tests (88)
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

This is a reference implementation — see the [BAM protocol specs](../../specs/) for the full
specification. Built by [Wonderland](https://wonderland.xyz).

## License

MIT
