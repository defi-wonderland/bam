#!/usr/bin/env node

import { Cli, z } from 'incur'
import {
  // Key generation & signing
  generateBLSPrivateKey,
  deriveBLSPublicKey,
  serializeBLSPrivateKey,
  serializeBLSPublicKey,
  generateECDSAPrivateKey,
  deriveAddress,
  signBLS,
  verifyBLS,
  aggregateBLS,
  verifyAggregateBLS,
  deserializeBLSPrivateKey,
  deserializeBLSPublicKey,
  deserializeBLSSignature,
  serializeBLSSignature,
  // ERC-8180 primitives
  computeMessageHash,
  computeMessageId,
  encodeContents,
  splitContents,
  signECDSAWithKey,
  verifyECDSA,
  encodeBatch,
  decodeBatch,
  estimateBatchSize,
  hexToBytes,
  bytesToHex,
  // Compression
  compress,
  decompress,
  isCompressed,
  compressionRatio,
  loadDictionary,
  // Aggregator
  AggregatorClient,
  // Constants
  PROTOCOL_VERSION_STRING,
  BLOB_SIZE_LIMIT,
  BLOB_USABLE_CAPACITY,
  BLS_SIGNATURE_SIZE,
  ECDSA_SIGNATURE_SIZE,
  // Types
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk'
import { readFile, writeFile } from 'node:fs/promises'

const cli = Cli.create('bam', {
  version: '0.2.0',
  description:
    'CLI for the BAM (Blob Authenticated Messaging) protocol — key management, ERC-8180 message primitives, batch operations, and aggregator info.',
  sync: {
    suggestions: [
      'generate an ECDSA keypair',
      'hash a BAMMessage (sender, nonce, contents)',
      'encode a batch of BAMMessages',
    ],
  },
})

// ─── Key Management ──────────────────────────────────────────────────────────

const key = Cli.create('key', { description: 'Key generation and derivation' })

key.command('generate', {
  description: 'Generate a new BLS or ECDSA keypair',
  args: z.object({
    scheme: z.enum(['bls', 'ecdsa']).describe('Signature scheme'),
  }),
  options: z.object({
    output: z.string().optional().describe('Write keypair to file (JSON)'),
  }),
  alias: { output: 'o' },
  examples: [
    { args: { scheme: 'bls' }, description: 'Generate a BLS keypair' },
    { args: { scheme: 'ecdsa' }, description: 'Generate an ECDSA keypair' },
    { args: { scheme: 'bls' }, options: { output: 'key.json' }, description: 'Save keypair to file' },
  ],
  async run({ args, options }) {
    if (args.scheme === 'bls') {
      const privateKey = generateBLSPrivateKey()
      const publicKey = deriveBLSPublicKey(privateKey)
      const keypair = {
        scheme: 'bls' as const,
        privateKey: serializeBLSPrivateKey(privateKey),
        publicKey: serializeBLSPublicKey(publicKey),
      }
      if (options.output) {
        await writeFile(options.output, JSON.stringify(keypair, null, 2) + '\n')
      }
      return keypair
    } else {
      const privateKey = generateECDSAPrivateKey()
      const address = deriveAddress(privateKey)
      const keypair = {
        scheme: 'ecdsa' as const,
        privateKey,
        address,
      }
      if (options.output) {
        await writeFile(options.output, JSON.stringify(keypair, null, 2) + '\n')
      }
      return keypair
    }
  },
})

cli.command(key)

// ─── Message Primitives (ERC-8180) ───────────────────────────────────────────

const msg = Cli.create('message', {
  description:
    'ERC-8180 message primitives: compute messageHash, sign / verify ECDSA over EIP-712.',
})

msg.command('hash', {
  description:
    'Compute ERC-8180 messageHash = keccak256(sender || nonce || contents).',
  options: z.object({
    sender: z.string().describe('Sender address (0x...)'),
    nonce: z.coerce.bigint().describe('Per-sender uint64 nonce'),
    contents: z
      .string()
      .describe('Contents bytes (0x-prefixed hex; must be >= 32 bytes including contentTag prefix)'),
  }),
  run({ options }) {
    const contents = hexToBytes(options.contents)
    const hash = computeMessageHash(options.sender as Address, options.nonce, contents)
    return { messageHash: hash }
  },
})

msg.command('message-id', {
  description:
    'Compute ERC-8180 messageId = keccak256(sender || nonce || batchContentHash). Known only after a batch is assembled.',
  options: z.object({
    sender: z.string().describe('Sender address (0x...)'),
    nonce: z.coerce.bigint().describe('Per-sender uint64 nonce'),
    batchContentHash: z
      .string()
      .describe('Batch content hash (blob versioned hash or keccak256 of calldata, 0x + 32 bytes)'),
  }),
  run({ options }) {
    const id = computeMessageId(
      options.sender as Address,
      options.nonce,
      options.batchContentHash as Bytes32
    )
    return { messageId: id }
  },
})

msg.command('sign', {
  description:
    'Sign a BAMMessage via EIP-712 typed data (scheme 0x01). Outputs a 65-byte hex signature with canonical low-s and v ∈ {27, 28}.',
  options: z.object({
    privateKey: z.string().describe('ECDSA private key (0x + 32 bytes)'),
    sender: z.string().describe('Sender address (0x...); must match the private key'),
    nonce: z.coerce.bigint().describe('Per-sender uint64 nonce'),
    contents: z.string().describe('Contents bytes (0x-prefixed hex, >= 32 bytes)'),
    chainId: z.coerce.number().describe('EIP-712 domain chain id'),
  }),
  run({ options }) {
    const contents = hexToBytes(options.contents)
    const message: BAMMessage = {
      sender: options.sender as Address,
      nonce: options.nonce,
      contents,
    }
    const signature = signECDSAWithKey(
      options.privateKey as `0x${string}`,
      message,
      options.chainId
    )
    const messageHash = computeMessageHash(options.sender as Address, options.nonce, contents)
    return { signature, messageHash }
  },
})

msg.command('verify', {
  description:
    'Verify an ECDSA signature over an EIP-712-constructed BAMMessage. Returns valid=true only on a signature produced by `expectedSender` on the given `chainId`.',
  options: z.object({
    sender: z.string().describe('Sender address (0x...)'),
    nonce: z.coerce.bigint().describe('Per-sender uint64 nonce'),
    contents: z.string().describe('Contents bytes (0x-prefixed hex)'),
    signature: z.string().describe('65-byte signature (0x + 130 hex chars)'),
    chainId: z.coerce.number().describe('EIP-712 domain chain id'),
  }),
  run({ options }) {
    const contents = hexToBytes(options.contents)
    const valid = verifyECDSA(
      {
        sender: options.sender as Address,
        nonce: options.nonce,
        contents,
      },
      options.signature as `0x${string}`,
      options.sender as Address,
      options.chainId
    )
    return { valid }
  },
})

msg.command('pack-contents', {
  description:
    'Build a `contents` byte string with a 32-byte contentTag prefix. Output is 0x-prefixed hex.',
  options: z.object({
    contentTag: z.string().describe('Content tag (0x + 32 bytes)'),
    appBytes: z.string().describe('App-opaque portion (0x + hex)'),
  }),
  run({ options }) {
    const out = encodeContents(options.contentTag as Bytes32, hexToBytes(options.appBytes))
    return { contents: bytesToHex(out) }
  },
})

msg.command('unpack-contents', {
  description: 'Split `contents` into its contentTag prefix and the app-opaque tail.',
  options: z.object({
    contents: z.string().describe('Contents bytes (0x + hex)'),
  }),
  run({ options }) {
    const { contentTag, appBytes } = splitContents(hexToBytes(options.contents))
    return { contentTag, appBytes: bytesToHex(appBytes) }
  },
})

cli.command(msg)

// ─── Batch Operations ───────────────────────────────────────────────────────

const batch = Cli.create('batch', {
  description: 'Encode and decode ERC-8180 batches (arrays of BAMMessages + signatures).',
})

interface BatchInputJSON {
  messages: Array<{ sender: Address; nonce: string | number; contents: string }>
  signatures: string[]
}

function loadBatchInput(raw: string): { messages: BAMMessage[]; signatures: Uint8Array[] } {
  const parsed = JSON.parse(raw) as BatchInputJSON
  const messages: BAMMessage[] = parsed.messages.map((m) => ({
    sender: m.sender,
    nonce: BigInt(m.nonce),
    contents: hexToBytes(m.contents),
  }))
  const signatures = parsed.signatures.map((s) => hexToBytes(s))
  return { messages, signatures }
}

batch.command('encode', {
  description:
    'Encode a batch from a JSON file with `{ messages, signatures }`. Each message is { sender, nonce, contents (0x hex) }; signatures are parallel 65-byte hex strings.',
  args: z.object({
    input: z.string().describe('Path to JSON file with messages + signatures arrays'),
  }),
  options: z.object({
    codec: z.enum(['none', 'zstd']).optional().describe('Codec (default: none)'),
    output: z.string().optional().describe('Write encoded batch to file'),
  }),
  alias: { output: 'o' },
  async run({ args, options }) {
    const raw = await readFile(args.input, 'utf-8')
    const { messages, signatures } = loadBatchInput(raw)

    const encoded = encodeBatch(messages, signatures, {
      codec: options.codec,
    })

    if (options.output) {
      await writeFile(options.output, Buffer.from(encoded.data))
    }

    return {
      size: encoded.size,
      messageCount: encoded.messageCount,
      codec: encoded.codec,
      hex: bytesToHex(encoded.data),
    }
  },
})

batch.command('decode', {
  description: 'Decode a batch from hex or binary file into BAMMessages + signatures.',
  args: z.object({
    input: z.string().describe('Hex-encoded batch or path to binary file'),
  }),
  async run({ args }) {
    let data: Uint8Array
    if (args.input.startsWith('0x')) {
      data = hexToBytes(args.input)
    } else {
      const buf = await readFile(args.input)
      data = new Uint8Array(buf)
    }

    const decoded = decodeBatch(data)
    return {
      messageCount: decoded.messages.length,
      messages: decoded.messages.map((m, i) => ({
        sender: m.sender,
        nonce: m.nonce.toString(),
        contents: bytesToHex(m.contents),
        signature: bytesToHex(decoded.signatures[i]),
      })),
    }
  },
})

batch.command('estimate', {
  description: 'Estimate the encoded size of a batch (upper bound).',
  args: z.object({
    input: z.string().describe('Path to JSON file with messages array'),
  }),
  async run({ args }) {
    const raw = await readFile(args.input, 'utf-8')
    const { messages } = loadBatchInput(raw)
    const size = estimateBatchSize(messages)
    return {
      estimatedSize: size,
      messageCount: messages.length,
      fitsInBlob: size <= BLOB_USABLE_CAPACITY,
      blobCapacity: BLOB_USABLE_CAPACITY,
    }
  },
})

cli.command(batch)

// ─── Compression ─────────────────────────────────────────────────────────────

const comp = Cli.create('compress', { description: 'Compress and decompress data with Zstd' })

comp.command('encode', {
  description: 'Compress data with optional Zstd dictionary',
  args: z.object({
    input: z.string().describe('Path to file to compress'),
  }),
  options: z.object({
    dictionary: z.string().optional().describe('Path to Zstd dictionary'),
    output: z.string().optional().describe('Write compressed data to file'),
  }),
  alias: { output: 'o' },
  async run({ args, options }) {
    const data = new Uint8Array(await readFile(args.input))

    let dict: { data: Uint8Array; id: number } | undefined
    if (options.dictionary) {
      const dictBuf = await readFile(options.dictionary)
      dict = loadDictionary(new Uint8Array(dictBuf))
    }

    const compressed = compress(data, dict)
    const ratio = compressionRatio(data.length, compressed.length)

    if (options.output) {
      await writeFile(options.output, Buffer.from(compressed))
    }

    return {
      originalSize: data.length,
      compressedSize: compressed.length,
      ratio,
    }
  },
})

comp.command('decode', {
  description: 'Decompress Zstd-compressed data',
  args: z.object({
    input: z.string().describe('Path to compressed file'),
  }),
  options: z.object({
    dictionary: z.string().optional().describe('Path to Zstd dictionary'),
    output: z.string().optional().describe('Write decompressed data to file'),
  }),
  alias: { output: 'o' },
  async run({ args, options }) {
    const data = new Uint8Array(await readFile(args.input))

    let dict: { data: Uint8Array; id: number } | undefined
    if (options.dictionary) {
      const dictBuf = await readFile(options.dictionary)
      dict = loadDictionary(new Uint8Array(dictBuf))
    }

    const decompressed = decompress(data, dict)

    if (options.output) {
      await writeFile(options.output, Buffer.from(decompressed))
    }

    return {
      compressedSize: data.length,
      decompressedSize: decompressed.length,
      ratio: compressionRatio(decompressed.length, data.length),
    }
  },
})

comp.command('check', {
  description: 'Check if data is Zstd-compressed',
  args: z.object({
    input: z.string().describe('Path to file or hex data'),
  }),
  async run({ args }) {
    let data: Uint8Array
    if (args.input.startsWith('0x')) {
      data = hexToBytes(args.input)
    } else {
      data = new Uint8Array(await readFile(args.input))
    }
    return {
      compressed: isCompressed(data),
      size: data.length,
    }
  },
})

cli.command(comp)

// ─── Aggregator Client ───────────────────────────────────────────────────────

const agg = Cli.create('aggregator', { description: 'Interact with a BAM aggregator node' })

agg.command('health', {
  description: 'Check aggregator health status',
  args: z.object({
    url: z.string().describe('Aggregator base URL'),
  }),
  env: z.object({
    BAM_AGGREGATOR_URL: z.string().optional().describe('Default aggregator URL'),
  }),
  async run({ args, env }) {
    const url = args.url || env.BAM_AGGREGATOR_URL
    if (!url) return { error: 'No aggregator URL provided' }
    const client = new AggregatorClient(url)
    return await client.health()
  },
})

agg.command('info', {
  description: 'Get aggregator info and capabilities',
  args: z.object({
    url: z.string().describe('Aggregator base URL'),
  }),
  async run({ args }) {
    const client = new AggregatorClient(args.url)
    return await client.info()
  },
})

agg.command('status', {
  description: 'Check the status of a submitted message',
  args: z.object({
    url: z.string().describe('Aggregator base URL'),
    messageId: z.string().describe('Message ID to check'),
  }),
  async run({ args }) {
    const client = new AggregatorClient(args.url)
    return await client.status(args.messageId)
  },
})

// No `aggregator submit`: submission goes through a Poster's HTTP
// endpoint, which accepts `{ contentTag, message: { sender, nonce,
// contents, signature } }` produced by `message sign` above.

cli.command(agg)

// ─── BLS Aggregation ────────────────────────────────────────────────────────

const bls = Cli.create('bls', { description: 'BLS signature aggregation utilities' })

bls.command('aggregate', {
  description: 'Aggregate multiple BLS signatures into one',
  args: z.object({
    signatures: z.string().describe('Comma-separated hex signatures'),
  }),
  run({ args }) {
    const sigs = args.signatures.split(',').map((s) => deserializeBLSSignature(s.trim()))
    const aggregated = aggregateBLS(sigs)
    return {
      aggregateSignature: serializeBLSSignature(aggregated),
      inputCount: sigs.length,
    }
  },
})

bls.command('verify-aggregate', {
  description: 'Verify an aggregate BLS signature',
  options: z.object({
    publicKeys: z.string().describe('Comma-separated hex public keys'),
    messageHashes: z.string().describe('Comma-separated hex message hashes'),
    signature: z.string().describe('Aggregate signature (hex)'),
  }),
  async run({ options }) {
    const pks = options.publicKeys.split(',').map((s) => deserializeBLSPublicKey(s.trim()))
    const hashes = options.messageHashes.split(',').map((s) => s.trim() as Bytes32)
    const sig = deserializeBLSSignature(options.signature)
    const valid = await verifyAggregateBLS(pks, hashes, sig)
    return { valid }
  },
})

bls.command('sign', {
  description: 'Sign an arbitrary hash with a BLS private key (building block for scheme 0x02).',
  options: z.object({
    privateKey: z.string().describe('BLS private key (hex)'),
    messageHash: z.string().describe('Hash to sign (0x + 32 bytes)'),
  }),
  async run({ options }) {
    const sk = deserializeBLSPrivateKey(options.privateKey)
    const sig = await signBLS(sk, options.messageHash as Bytes32)
    return { signature: serializeBLSSignature(sig) }
  },
})

bls.command('verify', {
  description: 'Verify a single BLS signature.',
  options: z.object({
    publicKey: z.string().describe('BLS public key (hex)'),
    messageHash: z.string().describe('Signed hash (0x + 32 bytes)'),
    signature: z.string().describe('BLS signature (hex)'),
  }),
  async run({ options }) {
    const pk = deserializeBLSPublicKey(options.publicKey)
    const sig = deserializeBLSSignature(options.signature)
    const valid = await verifyBLS(pk, options.messageHash as Bytes32, sig)
    return { valid }
  },
})

cli.command(bls)

// ─── Info ────────────────────────────────────────────────────────────────────

cli.command('info', {
  description: 'Show BAM protocol constants and limits',
  run() {
    return {
      protocolVersion: PROTOCOL_VERSION_STRING,
      blobSizeLimit: BLOB_SIZE_LIMIT,
      blobUsableCapacity: BLOB_USABLE_CAPACITY,
      blsSignatureSize: BLS_SIGNATURE_SIZE,
      ecdsaSignatureSize: ECDSA_SIGNATURE_SIZE,
    }
  },
})

cli.serve()
