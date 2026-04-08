# Long-term blob storage

## Context

Currently Ethereum blob data (EIP-4844) is pruned after approximately 18 days by default. Accessing blob data after that point therefore depends on an out-of-protocol archival mechanism. Long-term availability of blobs is required for many blob use-cases.

Today the main users of blobs are L2 rollups and block explorers. Rollups (Base, Optimism, Scroll, Arbitrum) use them as a data availability layer to publish transaction data; a new node that needs to derive the chain state requires access to historical blob data even after the pruning period. On the other hand, block explorers (Blobscan, Etherscan, Blockscout) archive blobs as a source of information for their users.

The goal of this document is to summarise the currently available solutions for long-term blob storage.

## Comparison of existing solutions


| Service        | Operator                                       | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Economic model                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blobscan**   | Blobscan                                       | Indexes all blobs from the network and stores them in multiple backends in parallel (Google Cloud Storage, PostgreSQL, Ethereum Swarm).                                                                                                                                                                                                                                                                                                                                                                                         | As a blob explorer, archiving is part of its purpose as an exploration tool.                                                                                                                                                                                                                                                                                                                                           |
| **Etherscan**  | Etherscan                                      | Archives blobs as part of its general Ethereum indexation. The infrastructure is not publicly available, [multiple posts](https://x.com/etherscan/status/1876985385928032746) confirm [they store blobs](https://x.com/etherscan/status/1905230322008219863) but it is not revealed where or with what guarantees.                                                                                                                                                                                                              | General Ethereum explorer. Blob archival is a natural extension of their product.                                                                                                                                                                                                                                                                                                                                      |
| **EthStorage** | Network of storage providers                   | It is a storage layer 2. It works under a pay-to-store model: someone calls `putBlob()` on an L1 contract and pays in ETH. Its nodes also called providers download the blob, store it, and have to periodically prove they still hold it via zk-SNARK proofs. If the proof is valid, they collect from the original fee.                                                                                                                                                                                                       | Decentralised storage protocol. Providers earn ETH for keeping the data alive. Their documentation mentions the cost is around ~0.1% of L1 storage cost.                                                                                                                                                                                                                                                               |
| **Blockscout** | Blockscout                                     | Block explorer software that indexes blobs directly into PostgreSQL (it has `beacon_blobs` and `beacon_blobs_transactions` tables). They currently also store blobs, but without formal guarantee of continuing to do so in the future. Sources: [1](https://www.blog.blockscout.com/blobs/), [2](https://docs.blockscout.com/api-reference/transactions/list-blobs-for-a-transaction)                                                                                                                                          | Archiving blobs is part of its function as a blob explorer.                                                                                                                                                                                                                                                                                                                                                            |
| **Quicknode**  | Quicknode                                      | [Blob sidecar API](https://www.quicknode.com/docs/ethereum/eth-v1-beacon-blob_sidecars-id). They said that "The complete history of blob data is supported."                                                                                                                                                                                                                                                                                                                                                                    | RPC provider. Blob access is part of their Ethereum node infrastructure.                                                                                                                                                                                                                                                                                                                                               |
| **Base**       | Base `blob-archiver`                           | A blob archiver that tracks the beacon chain and stores blobs. It supports both disk and S3-compatible storage. It exposes a Beacon sidecar API so clients can query archived blobs transparently. This is listed as a [requirement](https://github.com/base/node/blob/main/.env.mainnet) in Base's production node configuration. [Source](https://github.com/base-org/blob-archiver)                                                                                                                                          | It's an internal infrastructure for their OP Stack chain.                                                                                                                                                                                                                                                                                                                                                              |
| **Optimism**   | Optimism `op-node`                             | op-node has a [--l1.beacon-fallbacks](https://docs.optimism.io/node-operators/reference/op-node-config) flag that points to fallback endpoints implementing the Beacon API for fetching expired blobs. In practice, this connects to a blob archiver like the one Base built. [Source](https://arc.net/l/quote/yliihlbu)                                                                                                                                                                                                        | Part of OP Stack node infrastructure. Operators are free to integrate [any archiver](https://arc.net/l/quote/uwxuosfx) backend that implements the Beacon API: a beacon node without pruning (Lighthouse), the Base blob-archiver, or an external service. Other sources: [1](https://docs.optimism.io/chain-operators/guides/features/blobs) , [2](https://docs.optimism.io/op-mainnet/network-information/snapshots) |
| **Arbitrum**   | Arbitrum (delegates archival to third parties) | Does not have a dedicated blob archiver. Nodes depend on [beacon RPC providers](https://docs.arbitrum.io/run-arbitrum-node/l1-ethereum-beacon-chain-rpc-providers) with historical blob support. If a blob has expired, the node directs operators to a [list of third-party](https://docs.arbitrum.io/run-arbitrum-node/beacon-nodes-historical-blobs) providers.                                                                                                                                                              | No dedicated archival. Delegates to third-party beacon RPC providers.                                                                                                                                                                                                                                                                                                                                                  |
| **Scroll**     | Scroll                                         | Operates a dedicated blob archive via [AWS S3 buckets](https://github.com/scroll-tech/go-ethereum/releases/tag/scroll-v5.10.0). Their node supports multiple blob data sources through dedicated flags: `--da.blob.awss3` (Scroll's S3, recommended), `--da.blob.beaconnode`, `--da.blob.blobscan`, and `--da.blob.blocknative`. Post-Fusaka, S3 is the [recommended primary source](https://docs.scroll.io/en/developers/guides/running-a-scroll-node/) since normal beacon nodes can no longer serve blob data under PeerDAS. | Internal infrastructure. Scroll operates the S3 archive for their chain.                                                                                                                                                                                                                                                                                                                                               |
| **Aztec**      | Aztec                                          | Stores all blobs relevant for the rollup so that nodes can recreate the state from scratch. Blobs are uploaded to a Cloudflare R2 bucket and made publicly downloadable. [Source](https://docs.aztec.network/operate/operators/setup/syncing_best_practices) | Internal infrastructure. Aztec operates the R2 archive for their chain. |


More details are presented below. If not needed, this section can be skipped directly to the conclusion.

## In depth

### Blobscan

[https://blobscan.com/](https://blobscan.com/)

Blobscan is an explorer designed specifically for blobs. It currently supports 6 storage backends that can run in parallel: Google Cloud Storage, AWS S3, Ethereum Swarm, Swarmy Cloud, PostgreSQL and filesystem.

The public instance at [blobscan.com](https://blobscan.com) uses GCS and Ethereum Swarm simultaneously, which gives it redundancy between a centralised and a decentralised backend.

The REST API allows querying blobs by versioned hash, KZG commitment, tx hash, slot or block number.

Sources: [docs.blobscan.com/docs/storages](https://docs.blobscan.com/docs/storages), [docs.blobscan.com/docs/features](https://docs.blobscan.com/docs/features), [GitHub](https://github.com/Blobscan/blobscan)

### OP Stack

[https://github.com/base-org/blob-archiver](https://github.com/base-org/blob-archiver)

Base built a [blob archiver](https://github.com/base-org/blob-archiver) that stores blobs before they are pruned from the beacon chain. It supports disk and S3-compatible storage and exposes the standard Beacon sidecar API (`/eth/v1/beacon/blob_sidecars`).

The OP Stack integrates blob archiving through `op-node's` `[--l1.beacon-fallbacks](https://docs.optimism.io/node-operators/reference/op-node-config)` flag. When the primary beacon node no longer has a blob, `op-node` queries these fallback endpoints instead. They are most likely using the blob-archiver created by Base.

In addition, in 2024 Optimism also funded EthStorage through a [grant](https://blog.ethstorage.io/ethstorage-receives-grant-from-optimism-for-offering-a-complete-long-term-da-solution-for-op-stack/) to integrate long-term blob storage into the OP Stack.

Sources: [blob-archiver repo](https://github.com/base-org/blob-archiver), [Base node config](https://github.com/base/node/blob/main/.env.mainnet), [op-node config reference](https://docs.optimism.io/node-operators/reference/op-node-config), [OP Stack blob management](https://docs.optimism.io/operators/node-operators/management/blobs), [EthStorage grant announcement](https://blog.ethstorage.io/ethstorage-receives-grant-from-optimism-for-offering-a-complete-long-term-da-solution-for-op-stack/)

### EthStorage

[https://ethstorage.io/](https://ethstorage.io/)

[https://www.youtube.com/watch?v=r9fXJ_QuR0Q](https://www.youtube.com/watch?v=r9fXJ_QuR0Q)

EthStorage is a storage Layer 2 for Ethereum and the only solution this research found with a decentralised incentive model for persisting blobs.

For this mechanism to work, a user or application must pay for the data to persist over time. If certain data is required to remain available, `putBlob` is called on the EthStorage contract deployed on L1, paying a fee in ETH that is around 0.1% of L1 storage cost according to their documentation.

The storage providers detect that transaction and download the blob from the Ethereum P2P network before it expires (before the 18 days). They have an anti-sybil mechanism, where each provider encodes the data with their own Ethereum address.

Periodically, the contract selects a provider at random and asks them to prove they hold the data. The provider generates a zk-SNARK proof (Proof of Random Access). If the proof is valid they collect a portion of the original fee.

The mainnet alpha has been live since October 14, 2025 on Ethereum mainnet, although storage providers still need to be whitelisted and the network is not permissionless yet.

Currently the applications built on EthStorage are mainly demos from the team itself, such as [web3://](https://ethstorage.medium.com/erc-4804-the-1st-web-protocol-standard-for-eth-is-now-finalized-db258d4d9912) (a protocol for on-chain websites) and [GoE](https://github.com/ethstorage/goe-cli) (decentralised Git on Ethereum). Through [HTTP gateways](https://github.com/ethstorage/web3url-gateway) like w3eth.io, the team has also published on-chain demos such as a [Vitalik blog](https://vitalikblog.w3eth.io/), a [web3 blog](https://w3-blog.w3eth.io/), a music application [w3Music](https://w3-music.w3eth.io/) and a mail application [w3Mail](https://w3-email.w3eth.io/#/), among others.

*Below is a graphic showing the applications that could be enabled under this system according to EthStorage.*

![Applications enabled by ETHStorage](images/ethstorage-apps.png)

The protocol has received multiple grants since its inception, including one from Optimism, and has worked with recognised teams such as Taiko and Celestia, but the product has not yet fully materialised.

Sources: [docs.ethstorage.io](https://docs.ethstorage.io/), [EthStorage Mainnet Alpha Launch](https://blog.ethstorage.io/ethstorage-mainnet-alpha-launch-petabyte-scale-decentralized-storage-on-ethereum/), [2025 Annual Report](https://blog.ethstorage.io/ethstorage-2025-annual-report/)

## Conclusion

Long-term blob storage today falls into two main categories: general services and rollup-specific solutions. General services like Blobscan, Etherscan and Blockscout archive blobs and make them publicly available through centralised servers (Google Cloud Storage, AWS S3, PostgreSQL). Rollups have built solutions with similar dependencies: Base has developed a blob-archiver with disk and S3 support, Optimism uses fallbacks in its op-node that point to these archivers, Scroll operates an archive on S3, and Arbitrum does not have its own archiver and delegates to third-party RPC providers. All of these solutions in practice depend on centralised infrastructure.

On the other hand, a new solution could decentralise blob storage. EthStorage is a decentralised storage L2 where nodes store blobs in exchange for ETH and periodically prove they still hold them via zk-SNARKs. However, this solution is still under development and its viability has only been demonstrated through demos built by the team itself.

## Additional Sources

- [Blobscan docs](https://docs.blobscan.com/)
- [Blobscan GitHub](https://github.com/Blobscan/blobscan)
- [Etherscan: Blobs Are Temporary and Permanent](https://medium.com/etherscan-blog/blobs-are-temporary-and-permanent-e07f3c4ca6e4)
- [EthStorage docs](https://docs.ethstorage.io/)
- [EthStorage Mainnet Alpha Launch](https://blog.ethstorage.io/ethstorage-mainnet-alpha-launch-petabyte-scale-decentralized-storage-on-ethereum/)
- [EthStorage 2025 Annual Report](https://blog.ethstorage.io/ethstorage-2025-annual-report/)
- [Blobs on Blockscout](https://www.blog.blockscout.com/blobs/)
- [Blockscout beacon/blob.ex](https://github.com/blockscout/blockscout/blob/master/apps/explorer/lib/explorer/chain/beacon/blob.ex)
- [Vitalik: Ethereum has blobs. Where do we go from here?](https://vitalik.eth.limo/general/2024/03/28/blobs.html)