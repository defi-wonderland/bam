# Changelog

## 0.2.0 — BAM core `contentTag` uniformity

**Breaking change.** Implements the ERC-8180 amendment that carries `contentTag`
uniformly across BAM core events and the calldata registration path.

### Breaking

- **`ContractClient.registerCalldataBatch` signature change.** A new required
  positional argument `contentTag: Bytes32` is inserted between `batchData` and
  `decoder`. Call sites must be updated:

  ```ts
  // Before
  await client.registerCalldataBatch(batchData, decoder, signatureRegistry);
  // After
  await client.registerCalldataBatch(batchData, contentTag, decoder, signatureRegistry);
  ```

  `bytes32(0)` is accepted at the contract layer but NOT RECOMMENDED at the
  application layer — pick a protocol-identifying tag
  (e.g. `keccak256("<protocol>.v<n>")`).

- **`BlobBatchRegisteredEvent` and `CalldataBatchRegisteredEvent` gain a
  required `contentTag: Bytes32` field.** Callers who destructure or construct
  these shapes by hand must include the new field.

- **ABI break on `BlobBatchRegistered` and `CalldataBatchRegistered`.** Each
  event now carries `contentTag` as an indexed topic (`topic[3]`); `decoder`
  demotes to unindexed event data. Because the event signature changed, the
  `topic[0]` hash is different from the pre-amendment shape: pre-amendment
  `eth_getLogs` filters match **zero** events against the new deployment.
  Consumers must rescan from the new deployment block with the regenerated ABI.

### Added

- `BlobRegistrationResult.contentTag` and `CalldataRegistrationResult.contentTag`
  surface the tag parsed from the BAM core event receipt. Optional — unset for
  the legacy `registerBlob`/`registerCalldata` (`SocialBlobsCore`) paths, which
  do not emit a tag.
- Null-tag guidance in the relevant docstrings.

### ERC

- Carries the `docs/specs/erc-8180.md` amendment: `registerCalldataBatch` and
  both BAM core events now carry `contentTag`; the binding rule
  (emitted `contentTag` equals the caller-supplied argument verbatim) and the
  indexed-topic layout are specified in the Behavior section. See
  `docs/specs/erc-8180.md` for the full text.
