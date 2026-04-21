/**
 * Contract Client for BAM (Blob Authenticated Messaging)
 * @module bam-sdk/contracts/client
 *
 * Viem-based client for interacting with SocialBlobsCore, SimpleBoolVerifier,
 * and BLSExposer contracts. Stateless Core architecture where Core handles
 * registration (events only) and BLSExposer handles exposure.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
  type Log,
  decodeEventLog,
} from 'viem';
import type { Address, Bytes32 } from '../types.js';
import type {
  ExposureParams,
  ExposureResult,
  BlobRegistrationResult,
  CalldataRegistrationResult,
  CalldataExposureParams,
} from '../exposure/types.js';
import type { VersionedHash } from '../kzg/types.js';

// ABIs — auto-generated from Foundry build output by scripts/sync-abis.ts
import {
  SOCIAL_BLOBS_CORE_ABI,
  BAM_CORE_ABI,
  BLS_EXPOSER_ABI,
  SIMPLE_BOOL_VERIFIER_ABI,
  BLS_REGISTRY_ABI,
} from './abis.js';

export { BAM_CORE_ABI, BAM_DECODER_ABI } from './abis.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Client Options & Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Client options
 */
export interface ContractClientOptions {
  /** Chain configuration (e.g., mainnet, sepolia) */
  chain: Chain;
  /** RPC transport URL */
  rpcUrl: string;
  /** SocialBlobsCore contract address (legacy) */
  coreAddress: Address;
  /** BlobAuthenticatedMessagingCore contract address (ERC-BAM compliant) */
  bamCoreAddress?: Address;
  /** BLSExposer contract address (required for exposure operations) */
  blsExposerAddress?: Address;
  /** SimpleBoolVerifier contract address (required for registration with verifier) */
  verifierAddress?: Address;
  /** Account for write operations (private key or local account) */
  account?: Account;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Client
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Contract client for BAM protocol
 * Stateless Core architecture: Core emits events only,
 * SimpleBoolVerifier tracks registrations, BLSExposer handles exposure.
 */
export class BAMClient {
  readonly publicClient: PublicClient<Transport, Chain>;
  private walletClient?: WalletClient<Transport, Chain, Account>;
  private readonly coreAddress: Address;
  private readonly bamCoreAddress?: Address;
  private readonly blsExposerAddress?: Address;
  private readonly verifierAddress?: Address;
  private blsRegistryAddress?: Address;

  constructor(options: ContractClientOptions) {
    this.publicClient = createPublicClient({
      chain: options.chain,
      transport: http(options.rpcUrl),
    });

    if (options.account) {
      this.walletClient = createWalletClient({
        chain: options.chain,
        transport: http(options.rpcUrl),
        account: options.account,
      });
    }

    this.coreAddress = options.coreAddress;
    this.bamCoreAddress = options.bamCoreAddress;
    this.blsExposerAddress = options.blsExposerAddress;
    this.verifierAddress = options.verifierAddress;
  }

  private requireWallet(): WalletClient<Transport, Chain, Account> {
    if (!this.walletClient) {
      throw new Error('Account required for write operations');
    }
    return this.walletClient;
  }

  /**
   * Get the BLS registry address (resolved from BLSExposer)
   */
  async getBLSRegistryAddress(): Promise<Address> {
    if (!this.blsRegistryAddress) {
      if (!this.blsExposerAddress) {
        throw new Error(
          'BLSExposer address required to access BLS registry. Provide blsExposerAddress in client options.'
        );
      }
      this.blsRegistryAddress = await this.publicClient.readContract({
        address: this.blsExposerAddress as `0x${string}`,
        abi: BLS_EXPOSER_ABI,
        functionName: 'blsRegistry',
      }) as Address;
    }
    return this.blsRegistryAddress;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BLOB OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Register a blob on-chain (legacy)
   * @param blobIndex Index of the blob in the transaction (0-5)
   */
  async registerBlob(blobIndex: number): Promise<BlobRegistrationResult> {
    const wallet = this.requireWallet();

    const hash = await wallet.writeContract({
      address: this.coreAddress as `0x${string}`,
      abi: SOCIAL_BLOBS_CORE_ABI,
      functionName: 'registerBlob',
      args: [BigInt(blobIndex)],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, SOCIAL_BLOBS_CORE_ABI, 'BlobRegistered');
    if (!event) throw new Error('BlobRegistered event not found');

    return {
      txHash: receipt.transactionHash as Bytes32,
      versionedHash: event.args.versionedHash as VersionedHash,
      blockNumber: Number(receipt.blockNumber),
    };
  }

  /**
   * Register a blob on the legacy SocialBlobsCore. Since the verifier is now a
   * registration hook wired atomically through the core, there is no second wallet-side
   * verifier call to make — the verifier is populated inside the same transaction. This
   * method asserts that happened by reading `verifier.isRegistered(contentHash)` and
   * throws if the hook did not fire (e.g. the core was deployed without the verifier
   * wired in).
   */
  async registerBlobWithVerifier(blobIndex: number): Promise<BlobRegistrationResult> {
    const result = await this.registerBlob(blobIndex);
    await this.assertVerifierRegistered(result.versionedHash, BigInt(result.blockNumber));
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CALLDATA OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Register a batch via calldata (self-publication)
   */
  async registerCalldata(batchData: Uint8Array): Promise<CalldataRegistrationResult> {
    const wallet = this.requireWallet();

    const hash = await wallet.writeContract({
      address: this.coreAddress as `0x${string}`,
      abi: SOCIAL_BLOBS_CORE_ABI,
      functionName: 'registerCalldata',
      args: [`0x${Buffer.from(batchData).toString('hex')}` as `0x${string}`],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, SOCIAL_BLOBS_CORE_ABI, 'CalldataRegistered');
    if (!event) throw new Error('CalldataRegistered event not found');

    return {
      txHash: receipt.transactionHash as Bytes32,
      contentHash: event.args.contentHash as Bytes32,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Register a calldata batch on the legacy SocialBlobsCore. See
   * {@link registerBlobWithVerifier} for why this is an assertion rather than a second
   * transaction.
   */
  async registerCalldataWithVerifier(batchData: Uint8Array): Promise<CalldataRegistrationResult> {
    const result = await this.registerCalldata(batchData);
    await this.assertVerifierRegistered(result.contentHash, BigInt(result.blockNumber));
    return result;
  }

  /**
   * Read-only check that `SimpleBoolVerifier.isRegistered(registrationHash)` returns true
   * — i.e., the core contract's hook fired and populated the verifier during the
   * registration transaction. Throws if the verifier was not updated, which usually
   * means the configured core was not deployed with the verifier wired as its hook.
   *
   * `registrationHash` is whichever identifier the core used — the EIP-4844 versioned
   * hash for blob registrations, or `keccak256(batchData)` for calldata. The verifier
   * doesn't distinguish; both land in the same `_registered` mapping.
   *
   * The read is pinned to `blockNumber` (typically the receipt's block) so load-balanced
   * RPC backends don't return a stale "latest" that predates the registration tx.
   */
  private async assertVerifierRegistered(
    registrationHash: Bytes32,
    blockNumber: bigint
  ): Promise<void> {
    if (!this.verifierAddress) {
      throw new Error('Verifier address required. Provide verifierAddress in client options.');
    }
    const isRegistered = await this.publicClient.readContract({
      address: this.verifierAddress as `0x${string}`,
      abi: SIMPLE_BOOL_VERIFIER_ABI,
      functionName: 'isRegistered',
      args: [registrationHash as `0x${string}`],
      blockNumber,
    });
    if (!isRegistered) {
      throw new Error(
        `Verifier at ${this.verifierAddress} did not record registration hash ` +
          `${registrationHash} at block ${blockNumber}. This usually means the core ` +
          'contract is not wired with the verifier as its registration hook. Deploy a ' +
          'core that accepts the verifier in its constructor and calls `onRegistered` ' +
          'inside `registerBlob` / `registerCalldata`.'
      );
    }
  }

  /**
   * @deprecated SimpleBoolVerifier is a registration hook invoked atomically by the core
   *   contract. Direct wallet calls to `onRegistered` revert with `OnlyCore`.
   *
   *   If the configured core already has the verifier wired as its hook, call
   *   `registerBlob` / `registerCalldata` and the verifier will be populated inside the
   *   same transaction — no separate `registerWithVerifier` step needed.
   *
   *   Retained as a synchronous throw so existing call sites surface the new model at
   *   lint/test time instead of paying gas for a guaranteed revert.
   */
  async registerWithVerifier(_contentHash: Bytes32): Promise<void> {
    throw new Error(
      'registerWithVerifier is no longer callable: SimpleBoolVerifier.onRegistered is a ' +
        'core-only hook (reverts with OnlyCore for wallet senders). Call registerBlob / ' +
        'registerCalldata on a core whose hook is wired to the verifier instead.'
    );
  }

  /**
   * Estimate gas for calldata registration
   */
  async estimateRegisterCalldataGas(batchData: Uint8Array): Promise<bigint> {
    return this.publicClient.estimateContractGas({
      address: this.coreAddress as `0x${string}`,
      abi: SOCIAL_BLOBS_CORE_ABI,
      functionName: 'registerCalldata',
      args: [`0x${Buffer.from(batchData).toString('hex')}` as `0x${string}`],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BAM BATCH REGISTRATION (ERC-BAM compliant)
  // ═══════════════════════════════════════════════════════════════════════════════

  private requireBamCore(): Address {
    if (!this.bamCoreAddress) {
      throw new Error('BAM Core address required. Provide bamCoreAddress in client options.');
    }
    return this.bamCoreAddress;
  }

  /**
   * Register a blob batch via ERC-BAM
   */
  async registerBlobBatch(
    blobIndex: number,
    startFE: number,
    endFE: number,
    contentTag: Bytes32,
    decoder: Address,
    signatureRegistry: Address
  ): Promise<BlobRegistrationResult> {
    const wallet = this.requireWallet();
    const bamCore = this.requireBamCore();

    const hash = await wallet.writeContract({
      address: bamCore as `0x${string}`,
      abi: BAM_CORE_ABI,
      functionName: 'registerBlobBatch',
      args: [
        BigInt(blobIndex),
        startFE,
        endFE,
        contentTag as `0x${string}`,
        decoder as `0x${string}`,
        signatureRegistry as `0x${string}`,
      ],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, BAM_CORE_ABI, 'BlobBatchRegistered');
    if (!event) throw new Error('BlobBatchRegistered event not found');

    return {
      txHash: receipt.transactionHash as Bytes32,
      versionedHash: event.args.versionedHash as VersionedHash,
      contentTag: event.args.contentTag as Bytes32,
      blockNumber: Number(receipt.blockNumber),
    };
  }

  /**
   * Register a calldata batch via ERC-BAM.
   *
   * @param batchData           Batch payload bytes.
   * @param contentTag          Protocol/content identifier emitted verbatim in
   *                            `CalldataBatchRegistered`. `bytes32(0)` is accepted by
   *                            the contract but NOT RECOMMENDED — prefer
   *                            `keccak256("<protocol>.v<n>")`.
   * @param decoder             Decoder contract address.
   * @param signatureRegistry   Signature registry address.
   */
  async registerCalldataBatch(
    batchData: Uint8Array,
    contentTag: Bytes32,
    decoder: Address,
    signatureRegistry: Address
  ): Promise<CalldataRegistrationResult> {
    const wallet = this.requireWallet();
    const bamCore = this.requireBamCore();

    const hash = await wallet.writeContract({
      address: bamCore as `0x${string}`,
      abi: BAM_CORE_ABI,
      functionName: 'registerCalldataBatch',
      args: [
        `0x${Buffer.from(batchData).toString('hex')}` as `0x${string}`,
        contentTag as `0x${string}`,
        decoder as `0x${string}`,
        signatureRegistry as `0x${string}`,
      ],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, BAM_CORE_ABI, 'CalldataBatchRegistered');
    if (!event) throw new Error('CalldataBatchRegistered event not found');

    return {
      txHash: receipt.transactionHash as Bytes32,
      contentHash: event.args.contentHash as Bytes32,
      contentTag: event.args.contentTag as Bytes32,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // EXPOSURE OPERATIONS (via BLSExposer)
  // ═══════════════════════════════════════════════════════════════════════════════

  private requireExposer(): Address {
    if (!this.blsExposerAddress) {
      throw new Error(
        'BLSExposer address required for exposure operations. Provide blsExposerAddress in client options.'
      );
    }
    return this.blsExposerAddress;
  }

  /**
   * Expose a message on-chain via BLSExposer
   */
  async expose(params: ExposureParams): Promise<ExposureResult> {
    const wallet = this.requireWallet();
    const exposer = this.requireExposer();

    const contractParams = {
      versionedHash: params.versionedHash as `0x${string}`,
      kzgProofs: params.kzgProofs.map((p) => ({
        z: p.z,
        y: p.y,
        commitment: toHex(p.commitment),
        proof: toHex(p.proof),
      })),
      byteOffset: BigInt(params.byteOffset),
      byteLength: BigInt(params.byteLength),
      messageBytes: toHex(params.messageBytes),
      blsSignature: toHex(params.blsSignature),
      registrationProof: toHex(params.registrationProof),
    };

    const hash = await wallet.writeContract({
      address: exposer as `0x${string}`,
      abi: BLS_EXPOSER_ABI,
      functionName: 'expose',
      args: [contractParams],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, BLS_EXPOSER_ABI, 'MessageExposed');
    if (!event) throw new Error('MessageExposed event not found');

    return {
      txHash: receipt.transactionHash as Bytes32,
      messageHash: event.args.messageId as Bytes32,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Expose a message from a calldata batch via BLSExposer
   */
  async exposeFromCalldata(params: CalldataExposureParams): Promise<ExposureResult> {
    const wallet = this.requireWallet();
    const exposer = this.requireExposer();

    const contractParams = {
      batchData: toHex(params.batchData),
      messageOffset: BigInt(params.messageOffset),
      messageBytes: toHex(params.messageBytes),
      signature: toHex(params.signature),
      registrationProof: toHex(params.registrationProof),
    };

    const hash = await wallet.writeContract({
      address: exposer as `0x${string}`,
      abi: BLS_EXPOSER_ABI,
      functionName: 'exposeFromCalldata',
      args: [contractParams],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, BLS_EXPOSER_ABI, 'MessageExposed');
    if (!event) throw new Error('MessageExposed event not found');

    return {
      txHash: receipt.transactionHash as Bytes32,
      messageHash: event.args.messageId as Bytes32,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
    };
  }

  /**
   * Check if a message has been exposed
   */
  async isExposed(messageId: Bytes32): Promise<boolean> {
    const exposer = this.requireExposer();
    return this.publicClient.readContract({
      address: exposer as `0x${string}`,
      abi: BLS_EXPOSER_ABI,
      functionName: 'isExposed',
      args: [messageId as `0x${string}`],
    });
  }

  /**
   * Estimate gas for exposure
   */
  async estimateExposeGas(params: ExposureParams): Promise<bigint> {
    const exposer = this.requireExposer();
    const contractParams = {
      versionedHash: params.versionedHash as `0x${string}`,
      kzgProofs: params.kzgProofs.map((p) => ({
        z: p.z,
        y: p.y,
        commitment: toHex(p.commitment),
        proof: toHex(p.proof),
      })),
      byteOffset: BigInt(params.byteOffset),
      byteLength: BigInt(params.byteLength),
      messageBytes: toHex(params.messageBytes),
      blsSignature: toHex(params.blsSignature),
      registrationProof: toHex(params.registrationProof),
    };

    return this.publicClient.estimateContractGas({
      address: exposer as `0x${string}`,
      abi: BLS_EXPOSER_ABI,
      functionName: 'expose',
      args: [contractParams],
    });
  }

  /**
   * Estimate gas for calldata exposure
   */
  async estimateExposeFromCalldataGas(params: CalldataExposureParams): Promise<bigint> {
    const exposer = this.requireExposer();
    const contractParams = {
      batchData: toHex(params.batchData),
      messageOffset: BigInt(params.messageOffset),
      messageBytes: toHex(params.messageBytes),
      signature: toHex(params.signature),
      registrationProof: toHex(params.registrationProof),
    };

    return this.publicClient.estimateContractGas({
      address: exposer as `0x${string}`,
      abi: BLS_EXPOSER_ABI,
      functionName: 'exposeFromCalldata',
      args: [contractParams],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // BLS REGISTRY OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Check if an author is registered in the BLS registry
   */
  async isAuthorRegistered(author: Address): Promise<boolean> {
    const registry = await this.getBLSRegistryAddress();
    return this.publicClient.readContract({
      address: registry as `0x${string}`,
      abi: BLS_REGISTRY_ABI,
      functionName: 'isRegistered',
      args: [author as `0x${string}`],
    });
  }

  /**
   * Get author's BLS public key
   * @returns BLS public key hex or null if not registered
   */
  async getAuthorPublicKey(author: Address): Promise<`0x${string}` | null> {
    const registry = await this.getBLSRegistryAddress();
    const key = await this.publicClient.readContract({
      address: registry as `0x${string}`,
      abi: BLS_REGISTRY_ABI,
      functionName: 'getKey',
      args: [author as `0x${string}`],
    });
    if (key === '0x' || key.length <= 2) return null;
    return key;
  }

  /**
   * Register a BLS public key
   * @param blsPubKey 48-byte BLS public key (hex)
   * @param popSignature 96-byte proof of possession signature (hex)
   * @returns Assigned registry index
   */
  async registerBLSKey(blsPubKey: `0x${string}`, popSignature: `0x${string}`): Promise<bigint> {
    const wallet = this.requireWallet();
    const registry = await this.getBLSRegistryAddress();

    const hash = await wallet.writeContract({
      address: registry as `0x${string}`,
      abi: BLS_REGISTRY_ABI,
      functionName: 'register',
      args: [blsPubKey, popSignature],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    const event = this.findEvent(receipt.logs, BLS_REGISTRY_ABI, 'KeyRegistered');
    if (!event) throw new Error('KeyRegistered event not found');

    return event.args.index;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    return Number(await this.publicClient.getBlockNumber());
  }

  /**
   * Find and decode a specific event from transaction logs
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findEvent(logs: Log[], abi: any, eventName: string): any {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        }) as { eventName: string; args: Record<string, unknown> };
        if (decoded.eventName === eventName) {
          return decoded;
        }
      } catch {
        // Not this event, continue
      }
    }
    return null;
  }
}

/**
 * Create a new BAMClient
 * @param options Client options
 * @returns Client instance
 */
export function createClient(options: ContractClientOptions): BAMClient {
  return new BAMClient(options);
}
