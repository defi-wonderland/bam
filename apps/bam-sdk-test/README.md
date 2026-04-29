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
| ECDSA       | `generateECDSAPrivateKey`, `deriveAddress`, `computeECDSADigest`, `signECDSAWithKey`, `verifyECDSA` |
| BLS         | `generateBLSPrivateKey`, `deriveBLSPublicKey`, `signBLS`, `verifyBLS`, `aggregateBLS`, `verifyAggregateBLS` |
| Batch       | `encodeBatch`, `decodeBatch`, `estimateBatchSize` |
| Exposure    | `buildRawMessageBytes`, `encodeExposureBatch`, `decodeExposureBatch` |
| BPE         | `buildBPEDictionary`, `serializeBPEDictionary`, `bpeEncode`, `bpeDecode` |
| Compression | `decompress`, `isCompressed`, `getDecompressedSize`, `compressionRatio` |

## What's NOT surfaced

- Wallet-path `signECDSA` (needs a viem `WalletClient` / connected wallet)
- KZG proof generation (`kzg/*`) — requires the `c-kzg` native addon
- `parseBlobForMessages` / `buildExposureParams` — depend on KZG
- `loadBundledDictionary` / `loadDictionaryFromFile` — Node-only (`node:fs`, `node:crypto`)
- `BAMClient` / `AggregatorClient` — require live RPC + aggregator endpoints

For the wallet + on-chain flow, see the [`message-in-a-blobble`](../message-in-a-blobble)
app instead.
