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
  signECDSA,
  verifyBLS,
  verifyECDSA,
  aggregateBLS,
  verifyAggregateBLS,
  deserializeBLSPrivateKey,
  deserializeBLSPublicKey,
  deserializeBLSSignature,
  serializeBLSSignature,
  // Message encoding
  encodeMessageWithId,
  decodeMessage,
  computeMessageHash,
  computeMessageId,
  hexToBytes,
  bytesToHex,
  // Batch encoding
  encodeBatch,
  decodeBatch,
  buildAuthorTable,
  estimateBatchSize,
  // Compression
  compress,
  decompress,
  isCompressed,
  compressionRatio,
  loadDictionary,
  // Aggregator
  AggregatorClient,
  // Constants
  MAX_CONTENT_CHARS,
  PROTOCOL_VERSION_STRING,
  BLOB_SIZE_LIMIT,
  BLOB_USABLE_CAPACITY,
  BLS_SIGNATURE_SIZE,
  ECDSA_SIGNATURE_SIZE,
  // Types
  type SignedMessage,
  type SignatureType,
  type Address,
  type Bytes32,
} from 'bam-sdk'
import { readFile, writeFile } from 'node:fs/promises'

const cli = Cli.create('bam', {
  version: '0.1.0',
  description: 'CLI for the BAM (Blob Authenticated Messaging) protocol — key management, message encoding, batch operations, and aggregator interaction.',
  sync: {
    suggestions: [
      'generate a BLS keypair',
      'encode a message with ECDSA signature',
      'check aggregator health',
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

key.command('derive', {
  description: 'Derive public key or address from a private key',
  args: z.object({
    scheme: z.enum(['bls', 'ecdsa']).describe('Signature scheme'),
    privateKey: z.string().describe('Private key (hex)'),
  }),
  examples: [
    { args: { scheme: 'ecdsa', privateKey: '0xabc...' }, description: 'Derive Ethereum address' },
  ],
  run({ args }) {
    if (args.scheme === 'bls') {
      const sk = deserializeBLSPrivateKey(args.privateKey)
      const pk = deriveBLSPublicKey(sk)
      return { publicKey: serializeBLSPublicKey(pk) }
    } else {
      const address = deriveAddress(args.privateKey)
      return { address }
    }
  },
})

cli.command(key)

// ─── Message Operations ─────────────────────────────────────────────────────

const msg = Cli.create('message', { description: 'Encode, decode, sign, and verify messages' })

msg.command('encode', {
  description: 'Encode a signed message to its wire format. For ECDSA, the author address is derived from the private key automatically. For BLS, --author is required since BLS keys have no canonical address derivation.',
  options: z.object({
    author: z.string().optional().describe('Author address (0x...) — required for BLS, derived automatically for ECDSA'),
    content: z.string().describe('Message content'),
    nonce: z.coerce.number().default(0).describe('Message nonce'),
    timestamp: z.coerce.number().optional().describe('Unix timestamp (defaults to now)'),
    signatureType: z.enum(['bls', 'ecdsa']).default('ecdsa').describe('Signature scheme'),
    privateKey: z.string().describe('Private key to sign with (hex)'),
    output: z.string().optional().describe('Write encoded bytes to file'),
  }),
  alias: { output: 'o' },
  examples: [
    {
      options: {
        content: 'Hello BAM!', privateKey: '0xabc...',
      },
      description: 'Encode and sign a message with ECDSA (address derived from key)',
    },
    {
      options: {
        author: '0x1234...', content: 'Hello BAM!', privateKey: '0xabc...', signatureType: 'bls',
      },
      description: 'Encode and sign a message with BLS (author required)',
    },
  ],
  async run({ options, error }) {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)

    let author: Address
    let signature: Uint8Array
    let signatureType: SignatureType

    if (options.signatureType === 'bls') {
      if (!options.author) {
        return error({
          code: 'MISSING_AUTHOR',
          message: 'BLS signatures require --author since there is no canonical address derivation from a BLS key',
          retryable: true,
        })
      }
      author = options.author as Address
      const sk = deserializeBLSPrivateKey(options.privateKey)
      const messageHash = computeMessageHash({
        author, content: options.content, nonce: options.nonce, timestamp,
      })
      signature = await signBLS(sk, bytesToHex(messageHash) as Bytes32)
      signatureType = 'bls'
    } else {
      // ECDSA: derive author from private key, ignore --author if passed
      author = deriveAddress(options.privateKey)
      const messageHash = computeMessageHash({
        author, content: options.content, nonce: options.nonce, timestamp,
      })
      signature = await signECDSA(options.privateKey, bytesToHex(messageHash) as Bytes32)
      signatureType = 'ecdsa'
    }

    const message = { author, content: options.content, nonce: options.nonce, timestamp }
    const signed: SignedMessage = { ...message, signature, signatureType }
    const { data, messageId, size } = encodeMessageWithId(signed)

    if (options.output) {
      await writeFile(options.output, Buffer.from(data))
    }

    return {
      messageId,
      author,
      size,
      hex: bytesToHex(data),
    }
  },
})

msg.command('decode', {
  description: 'Decode a message from wire format',
  args: z.object({
    input: z.string().describe('Hex-encoded message or path to binary file'),
  }),
  async run({ args }) {
    let data: Uint8Array
    try {
      // Try as hex first
      if (args.input.startsWith('0x')) {
        data = hexToBytes(args.input)
      } else {
        // Try as file path
        const buf = await readFile(args.input)
        data = new Uint8Array(buf)
      }
    } catch {
      data = hexToBytes(args.input)
    }

    const decoded = decodeMessage(data)
    return {
      author: decoded.author,
      content: decoded.content,
      timestamp: decoded.timestamp,
      nonce: decoded.nonce,
      signatureType: decoded.signatureType,
      signature: bytesToHex(decoded.signature),
    }
  },
})

msg.command('hash', {
  description: 'Compute the hash and ID of a message',
  options: z.object({
    author: z.string().describe('Author address (0x...)'),
    content: z.string().describe('Message content'),
    nonce: z.coerce.number().default(0).describe('Message nonce'),
    timestamp: z.coerce.number().optional().describe('Unix timestamp (defaults to now)'),
  }),
  run({ options }) {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
    const message = {
      author: options.author as Address,
      content: options.content,
      nonce: options.nonce,
      timestamp,
    }
    const hash = computeMessageHash(message)
    const id = computeMessageId(message)
    return {
      messageHash: bytesToHex(hash),
      messageId: id,
    }
  },
})

msg.command('verify', {
  description: 'Verify a message signature',
  options: z.object({
    author: z.string().describe('Author address (0x...) or BLS public key'),
    content: z.string().describe('Message content'),
    nonce: z.coerce.number().default(0).describe('Message nonce'),
    timestamp: z.coerce.number().describe('Unix timestamp'),
    signatureType: z.enum(['bls', 'ecdsa']).default('ecdsa').describe('Signature scheme'),
    signature: z.string().describe('Signature (hex)'),
  }),
  async run({ options }) {
    const message = {
      author: options.author as Address,
      content: options.content,
      nonce: options.nonce,
      timestamp: options.timestamp,
    }
    const messageHash = bytesToHex(computeMessageHash(message)) as Bytes32

    let valid: boolean
    if (options.signatureType === 'bls') {
      const pk = deserializeBLSPublicKey(options.author)
      const sig = deserializeBLSSignature(options.signature)
      valid = await verifyBLS(pk, messageHash, sig)
    } else {
      const sig = hexToBytes(options.signature)
      valid = verifyECDSA(options.author as Address, messageHash, sig)
    }

    return { valid }
  },
})

cli.command(msg)

// ─── Batch Operations ───────────────────────────────────────────────────────

const batch = Cli.create('batch', { description: 'Batch encode and decode message batches' })

batch.command('encode', {
  description: 'Encode a batch of signed messages from a JSON file',
  args: z.object({
    input: z.string().describe('Path to JSON file with signed messages array'),
  }),
  options: z.object({
    dictionary: z.string().optional().describe('Path to Zstd dictionary file'),
    noCompress: z.boolean().optional().describe('Disable compression'),
    output: z.string().optional().describe('Write encoded batch to file'),
  }),
  alias: { output: 'o' },
  async run({ args, options }) {
    const raw = await readFile(args.input, 'utf-8')
    const messages: SignedMessage[] = JSON.parse(raw)

    let dict: { data: Uint8Array; id: number } | undefined
    if (options.dictionary) {
      const dictBuf = await readFile(options.dictionary)
      dict = loadDictionary(new Uint8Array(dictBuf))
    }

    const encoded = encodeBatch(messages, {
      dictionary: dict?.data,
      compress: !options.noCompress,
    })

    if (options.output) {
      await writeFile(options.output, Buffer.from(encoded.data))
    }

    return {
      totalSize: encoded.totalSize,
      headerSize: encoded.headerSize,
      compressedSize: encoded.compressedSize,
      messageCount: encoded.messageCount,
      authorCount: encoded.authorCount,
      compressionRatio: encoded.compressionRatio,
      hex: bytesToHex(encoded.data),
    }
  },
})

batch.command('decode', {
  description: 'Decode a batch from hex or binary file',
  args: z.object({
    input: z.string().describe('Hex-encoded batch or path to binary file'),
  }),
  options: z.object({
    dictionary: z.string().optional().describe('Path to Zstd dictionary file'),
  }),
  async run({ args, options }) {
    let data: Uint8Array
    if (args.input.startsWith('0x')) {
      data = hexToBytes(args.input)
    } else {
      const buf = await readFile(args.input)
      data = new Uint8Array(buf)
    }

    let dict: { data: Uint8Array; id: number } | undefined
    if (options.dictionary) {
      const dictBuf = await readFile(options.dictionary)
      dict = loadDictionary(new Uint8Array(dictBuf))
    }

    const decoded = decodeBatch(data, dict)
    return {
      messageCount: decoded.messages.length,
      compressedSize: decoded.compressedSize,
      decompressedSize: decoded.decompressedSize,
      authors: decoded.header.authors,
      messages: decoded.messages.map(m => ({
        author: m.author,
        content: m.content,
        timestamp: m.timestamp,
        nonce: m.nonce,
      })),
    }
  },
})

batch.command('estimate', {
  description: 'Estimate the encoded size of a batch',
  args: z.object({
    input: z.string().describe('Path to JSON file with messages array'),
  }),
  async run({ args }) {
    const raw = await readFile(args.input, 'utf-8')
    const messages = JSON.parse(raw)
    const size = estimateBatchSize(messages)
    const authors = buildAuthorTable(messages)
    return {
      estimatedSize: size,
      messageCount: messages.length,
      uniqueAuthors: authors.length,
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

agg.command('submit', {
  description: 'Submit a signed message to the aggregator. For ECDSA, author is derived from the private key. For BLS, --author is required.',
  args: z.object({
    url: z.string().describe('Aggregator base URL'),
  }),
  options: z.object({
    author: z.string().optional().describe('Author address (0x...) — required for BLS, derived automatically for ECDSA'),
    content: z.string().describe('Message content'),
    nonce: z.coerce.number().default(0).describe('Message nonce'),
    timestamp: z.coerce.number().optional().describe('Unix timestamp'),
    signatureType: z.enum(['bls', 'ecdsa']).default('ecdsa').describe('Signature scheme'),
    privateKey: z.string().describe('Private key to sign with'),
  }),
  async run({ args, options, error }) {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)

    let author: Address
    let signature: Uint8Array
    let signatureType: SignatureType

    if (options.signatureType === 'bls') {
      if (!options.author) {
        return error({
          code: 'MISSING_AUTHOR',
          message: 'BLS signatures require --author since there is no canonical address derivation from a BLS key',
          retryable: true,
        })
      }
      author = options.author as Address
      const sk = deserializeBLSPrivateKey(options.privateKey)
      const messageHash = bytesToHex(computeMessageHash({
        author, content: options.content, nonce: options.nonce, timestamp,
      })) as Bytes32
      signature = await signBLS(sk, messageHash)
      signatureType = 'bls'
    } else {
      author = deriveAddress(options.privateKey)
      const messageHash = bytesToHex(computeMessageHash({
        author, content: options.content, nonce: options.nonce, timestamp,
      })) as Bytes32
      signature = await signECDSA(options.privateKey, messageHash)
      signatureType = 'ecdsa'
    }

    const message = { author, content: options.content, nonce: options.nonce, timestamp }
    const signed: SignedMessage = { ...message, signature, signatureType }
    const client = new AggregatorClient(args.url)
    return await client.submit(signed)
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

cli.command(agg)

// ─── BLS Aggregation ────────────────────────────────────────────────────────

const bls = Cli.create('bls', { description: 'BLS signature aggregation utilities' })

bls.command('aggregate', {
  description: 'Aggregate multiple BLS signatures into one',
  args: z.object({
    signatures: z.string().describe('Comma-separated hex signatures'),
  }),
  run({ args }) {
    const sigs = args.signatures.split(',').map(s => deserializeBLSSignature(s.trim()))
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
    const pks = options.publicKeys.split(',').map(s => deserializeBLSPublicKey(s.trim()))
    const hashes = options.messageHashes.split(',').map(s => s.trim() as Bytes32)
    const sig = deserializeBLSSignature(options.signature)
    const valid = await verifyAggregateBLS(pks, hashes, sig)
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
      maxContentChars: MAX_CONTENT_CHARS,
      blobSizeLimit: BLOB_SIZE_LIMIT,
      blobUsableCapacity: BLOB_USABLE_CAPACITY,
      blsSignatureSize: BLS_SIGNATURE_SIZE,
      ecdsaSignatureSize: ECDSA_SIGNATURE_SIZE,
    }
  },
})

cli.serve()

export default cli
