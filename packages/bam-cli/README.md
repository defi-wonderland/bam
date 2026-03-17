# bam-cli

Reference CLI for the BAM (Blob Authenticated Messaging) protocol, built by
[Wonderland](https://wonderland.xyz). Key management, message encoding, batch operations,
BLS aggregation, and aggregator interaction.

## Install

```bash
pnpm add bam-cli
```

Or run directly from the workspace:

```bash
pnpm --filter bam-cli build
node packages/bam-cli/dist/esm/index.js
```

## Commands

### Key Management

```bash
# Generate a BLS keypair
bam key generate bls

# Generate an ECDSA keypair
bam key generate ecdsa

# Save keypair to file
bam key generate bls -o key.json

# Derive address from private key
bam key derive ecdsa 0xabc...
```

### Message Operations

```bash
# Encode and sign a message (ECDSA — author derived from key)
bam message encode --content "Hello BAM!" --privateKey 0xabc...

# Encode and sign with BLS (author required)
bam message encode --content "Hello BAM!" --privateKey 0xabc... --signatureType bls --author 0x1234...

# Decode a message from hex
bam message decode 0x534f424d...

# Compute message hash and ID
bam message hash --author 0x1234... --content "Hello BAM!"

# Verify a signature
bam message verify --author 0x1234... --content "Hello BAM!" --timestamp 1700000000 --signature 0xabc...
```

### Batch Operations

```bash
# Encode a batch from JSON
bam batch encode messages.json

# Encode with dictionary and output to file
bam batch encode messages.json --dictionary v1.dict -o batch.bin

# Decode a batch
bam batch decode batch.bin

# Estimate batch size
bam batch estimate messages.json
```

### Compression

```bash
# Compress data
bam compress encode data.bin -o compressed.zst

# Decompress
bam compress decode compressed.zst -o data.bin

# Check if data is Zstd-compressed
bam compress check data.bin
```

### BLS Aggregation

```bash
# Aggregate multiple signatures
bam bls aggregate 0xsig1...,0xsig2...,0xsig3...

# Verify an aggregate signature
bam bls verify-aggregate --publicKeys 0xpk1...,0xpk2... --messageHashes 0xh1...,0xh2... --signature 0xagg...
```

### Aggregator Client

```bash
# Check aggregator health
bam aggregator health https://aggregator.example.com

# Get aggregator info
bam aggregator info https://aggregator.example.com

# Submit a signed message
bam aggregator submit https://aggregator.example.com --content "Hello!" --privateKey 0xabc...

# Check message status
bam aggregator status https://aggregator.example.com 0xmessageId...
```

### Info

```bash
# Show protocol constants and limits
bam info
```

## Development

```bash
pnpm build
pnpm lint
```

## License

MIT
