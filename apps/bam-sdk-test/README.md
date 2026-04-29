# bam-sdk-test

A simple playground for the [`bam-sdk`](../../packages/bam-sdk) browser entrypoint. Each
section surfaces one family of SDK functions with prefilled demo data — generate keys,
sign, verify, encode batches, run BPE, etc.

## Run

```bash
pnpm --filter bam-sdk-test dev
# → http://localhost:3030
```

## What's surfaced

| Section     | Functions |
|-------------|-----------|
| Hex         | `hexToBytes`, `bytesToHex` |
| Message     | `encodeContents`, `splitContents`, `computeMessageHash`, `computeMessageId` |
| ECDSA       | `generateECDSAPrivateKey`, `deriveAddress`, `computeECDSADigest`, `signECDSAWithKey`, `signECDSA` (via injected wallet), `verifyECDSA` |
| BLS         | `generateBLSPrivateKey`, `deriveBLSPublicKey`, `signBLS`, `verifyBLS`, `aggregateBLS`, `verifyAggregateBLS` |
| Batch       | `encodeBatch`, `decodeBatch`, `estimateBatchSize` |
| Exposure    | `buildRawMessageBytes`, `encodeExposureBatch`, `decodeExposureBatch` |
| BPE         | `buildBPEDictionary`, `serializeBPEDictionary`, `bpeEncode`, `bpeDecode` |
| Compression | `decompress`, `isCompressed`, `getDecompressedSize`, `compressionRatio` |

## What's NOT surfaced

- KZG proof generation (`kzg/*`) — requires the `c-kzg` native addon
- `parseBlobForMessages` / `buildExposureParams` — depend on KZG
- `loadBundledDictionary` / `loadDictionaryFromFile` — Node-only (`node:fs`, `node:crypto`)
- `BAMClient` / `AggregatorClient` — require live RPC + aggregator endpoints

The wallet path uses a minimal viem `createWalletClient({ transport: custom(window.ethereum) })`
— no wagmi/RainbowKit. Any injected EIP-1193 provider (MetaMask, Rabby, Brave, …) works.
The wallet's current chain id is what gets bound into the EIP-712 signature.

For the wallet + on-chain flow, see the [`message-in-a-blobble`](../message-in-a-blobble)
app instead.
