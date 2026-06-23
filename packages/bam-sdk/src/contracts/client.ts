/**
 * Contract Client for BAM (Blob Authenticated Messaging)
 * @module bam-sdk/contracts/client
 *
 * Viem-based client for interacting with the BAM core, BLSExposer, and signature
 * registry contracts. The core is events-only (ERC-8180); BLSExposer handles
 * on-chain exposure.
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
  BAM_CORE_ABI,
  BLS_EXPOSER_ABI,
  BLS_REGISTRY_ABI,
  ECDSA_REGISTRY_ABI,
} from './abis.js';

export {
  BAM_CORE_ABI,
  BAM_DECODER_ABI,
  ECDSA_REGISTRY_ABI,
  SIGNATURE_REGISTRY_DISPATCHER_ABI,
} from './abis.js';

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
  /** BlobAuthenticatedMessagingCore contract address (ERC-BAM compliant) */
  bamCoreAddress?: Address;
  /** BLSExposer contract address (required for exposure operations) */
  blsExposerAddress?: Address;
  /** Account for write operations (private key or local account) */
  account?: Account;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Client
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Contract client for the BAM protocol.
 * The core emits events only (ERC-8180); BLSExposer handles on-chain exposure.
 */
export class BAMClient {
  readonly publicClient: PublicClient<Transport, Chain>;
  private walletClient?: WalletClient<Transport, Chain, Account>;
  private readonly bamCoreAddress?: Address;
  private readonly blsExposerAddress?: Address;
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

    this.bamCoreAddress = options.bamCoreAddress;
    this.blsExposerAddress = options.blsExposerAddress;
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
      contentTag: params.contentTag as `0x${string}`,
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
      contentTag: params.contentTag as `0x${string}`,
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
      contentTag: params.contentTag as `0x${string}`,
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
      contentTag: params.contentTag as `0x${string}`,
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
  // ECDSA REGISTRY OPERATIONS (ERC-8180 scheme 0x01)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Register a delegate signing key with an ECDSA registry.
   *
   * @param registry     Deployed ECDSARegistry address.
   * @param delegate     20-byte Ethereum address of the delegate's EOA key.
   * @param popProof     65-byte proof-of-possession signature: the delegate
   *                     key's `personal_sign` of `computeEcdsaPopMessage({
   *                     owner: msg.sender, chainId, registry })`.
   * @returns            The registry index assigned to the new binding.
   */
  async registerEcdsaDelegate(
    registry: Address,
    delegate: Address,
    popProof: `0x${string}`
  ): Promise<bigint> {
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: registry as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'register',
      args: [delegate as `0x${string}`, popProof],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const event = this.findEvent(receipt.logs, ECDSA_REGISTRY_ABI, 'KeyRegistered');
    if (!event) throw new Error('KeyRegistered event not found');
    return event.args.index as bigint;
  }

  /**
   * Rotate a delegate signing key in an ECDSA registry.
   *
   * @param registry     Deployed ECDSARegistry address.
   * @param newDelegate  20-byte Ethereum address of the new delegate's EOA key.
   * @param newPopProof  65-byte PoP signature from the new delegate.
   * @returns            The fresh registry index assigned to the new binding.
   */
  async rotateEcdsaDelegate(
    registry: Address,
    newDelegate: Address,
    newPopProof: `0x${string}`
  ): Promise<bigint> {
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      address: registry as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'rotate',
      args: [newDelegate as `0x${string}`, newPopProof],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const event = this.findEvent(receipt.logs, ECDSA_REGISTRY_ABI, 'KeyRotated');
    if (!event) throw new Error('KeyRotated event not found');
    return event.args.newIndex as bigint;
  }

  /**
   * Verify a signature against an explicit delegate address (`registry.verify`).
   */
  async verifyEcdsa(
    registry: Address,
    delegate: Address,
    messageHash: Bytes32,
    signature: `0x${string}`
  ): Promise<boolean> {
    return this.publicClient.readContract({
      address: registry as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'verify',
      args: [delegate as `0x${string}`, messageHash as `0x${string}`, signature],
    });
  }

  /**
   * Verify a signature using an owner's registered delegate (or keyless
   * fallback) via `registry.verifyWithRegisteredKey`.
   */
  async verifyEcdsaWithRegisteredKey(
    registry: Address,
    owner: Address,
    messageHash: Bytes32,
    signature: `0x${string}`
  ): Promise<boolean> {
    return this.publicClient.readContract({
      address: registry as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'verifyWithRegisteredKey',
      args: [owner as `0x${string}`, messageHash as `0x${string}`, signature],
    });
  }

  /**
   * Canonical "keyed vs keyless" query — true iff `owner` has a bound
   * delegate in the ECDSA registry.
   */
  async hasEcdsaDelegate(registry: Address, owner: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: registry as `0x${string}`,
      abi: ECDSA_REGISTRY_ABI,
      functionName: 'hasDelegate',
      args: [owner as `0x${string}`],
    });
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
