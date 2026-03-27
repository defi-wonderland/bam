// ABI fragments needed for this demo.
// Sourced from bam-sdk/contracts/abis.ts (auto-generated from Foundry).

export const BLS_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'isRegistered',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'registered', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'register',
    inputs: [
      { name: 'blsPubKey', type: 'bytes' },
      { name: 'popSignature', type: 'bytes' },
    ],
    outputs: [{ name: 'index', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getKey',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'blsPubKey', type: 'bytes' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'KeyRegistered',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'pubKey', type: 'bytes', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const;

export const BLS_EXPOSER_ABI = [
  {
    type: 'function',
    name: 'expose',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'versionedHash', type: 'bytes32' },
          {
            name: 'kzgProofs',
            type: 'tuple[]',
            components: [
              { name: 'z', type: 'uint256' },
              { name: 'y', type: 'uint256' },
              { name: 'commitment', type: 'bytes' },
              { name: 'proof', type: 'bytes' },
            ],
          },
          { name: 'byteOffset', type: 'uint256' },
          { name: 'byteLength', type: 'uint256' },
          { name: 'messageBytes', type: 'bytes' },
          { name: 'blsSignature', type: 'bytes' },
          { name: 'registrationProof', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'messageId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'isExposed',
    inputs: [{ name: 'messageId', type: 'bytes32' }],
    outputs: [{ name: 'exposed', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'MessageExposed',
    inputs: [
      { name: 'contentHash', type: 'bytes32', indexed: true },
      { name: 'messageId', type: 'bytes32', indexed: true },
      { name: 'author', type: 'address', indexed: true },
      { name: 'exposer', type: 'address', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
    anonymous: false,
  },
] as const;

export const SIMPLE_BOOL_VERIFIER_ABI = [
  {
    type: 'function',
    name: 'verifyRegistration',
    inputs: [
      { name: '', type: 'address' },
      { name: 'contentHash', type: 'bytes32' },
      { name: '', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
] as const;
