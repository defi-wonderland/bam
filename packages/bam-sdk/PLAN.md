# BAM SDK: Dual Encoding Architecture

## Context

The SDK needs two encoding paths for different use cases:

**Compact batch** (`encodeBatch`/`decodeBatch`) — space-efficient encoding using author tables and timestamp deltas. Good for aggregator-mediated messaging. Messages are NOT individually KZG-addressable.

**Exposure batch** (`encodeExposureBatch` / `parseBlob`) — messages stored in on-chain raw format `[author(20)][timestamp(4)][nonce(2)][content]` so KZG proofs can extract exactly the bytes that `BLSExposer.expose()` verifies on-chain.

The current `blob-parser.ts` was intended for the exposure path but has an incompatible format with `batch.ts` (different magic, version size, field widths, conditional fields) and a fundamental byte-offset bug (uses compact format offsets with raw format lengths). It has no tests.

## Exposure Batch Format

### Header
```
Offset  Field              Size    Notes
0-3     Magic              4B      MAGIC_EXPOSURE ("SOB2" = 0x534F4232)
4       Version            1B      0x01
5       Flags              1B      bit 0: has aggregate BLS sig
6-7     Message count      2B      uint16 BE
8-55    Aggregate BLS sig  48B     present if flag bit 0 set, else zeros
```
Fixed header: 56 bytes

### Message entries (repeated × message count)
```
Offset  Field              Size    Notes
0-1     Raw bytes length   2B      uint16 BE
2+      Raw message bytes  var     [author(20)][timestamp(4)][nonce(2)][content(N)]
```

KZG proofs target the raw bytes (offset 2+), NOT the length prefix.
This is exactly what `BLSExposer.expose()` verifies.

## Implementation Checklist

### Phase 1: Exposure encoder
- [x] Add `MAGIC_EXPOSURE` + `EXPOSURE_HEADER_SIZE` + `EXPOSURE_MSG_PREFIX_SIZE` to `constants.ts`
- [x] Create `exposure/encoder.ts` — `encodeExposureBatch()` and `decodeExposureBatch()`
- [x] Add `ExposureBatch` and `DecodedExposureBatch` types to `exposure/types.ts`
- [x] Export from `index.ts` and `browser.ts`

### Phase 2: Fix blob-parser
- [x] Rewrite `parseBlob()` to parse the exposure batch format (SOB2 magic)
- [x] Correct header layout: magic(4) + version(1) + flags(1) + msgCount(2) + blsSig(48)
- [x] Fix `byteOffset`/`byteLength` → consistent with `rawBytes` (past length prefix)
- [x] Remove old incompatible code (author tables, timestamp deltas, conditional fields)

### Phase 3: Tests
- [x] `encodeExposureBatch` → `decodeExposureBatch` roundtrip (single + multi message)
- [x] Byte offset correctness: extract at offset/length from batch data === rawBytes
- [x] Contiguous message layout verification
- [x] Aggregate signature roundtrip
- [x] All 122 tests pass (13 new + 109 existing)

### Phase 4: Demo app update
- [x] `post-blob/route.ts` → use `encodeExposureBatch` instead of `encodeBatch`
- [x] `blobs/[txHash]/route.ts` → use `decodeExposureBatch` for decoding
- [x] Demo app builds successfully

## Key Files

| File | Action |
|------|--------|
| `src/constants.ts` | Add `MAGIC_EXPOSURE` |
| `src/exposure/encoder.ts` | **New** — exposure batch encode/decode |
| `src/exposure/blob-parser.ts` | **Rewrite** — parse exposure format |
| `src/exposure/types.ts` | Add `ExposureBatch` type |
| `src/index.ts` | Export new functions |
| `src/browser.ts` | Export new functions (decode only) |
| `tests/unit/exposure-encoder.test.ts` | **New** — roundtrip + byte offset tests |
| `apps/exposure-demo/src/app/api/post-blob/route.ts` | Use exposure encoder |
| `apps/exposure-demo/src/app/api/blobs/[txHash]/route.ts` | Use exposure decoder |
| `apps/exposure-demo/src/app/api/exposure/build/route.ts` | Verify parseBlob works |
