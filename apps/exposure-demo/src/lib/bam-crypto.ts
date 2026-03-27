import { keccak256, encodePacked, toHex } from 'viem';
import { signBLS } from 'bam-sdk/browser';

/**
 * Compute the BAM domain separator: keccak256("ERC-BAM.v1" || chainId)
 */
export function computeBAMDomain(chainId: number): `0x${string}` {
  return keccak256(
    encodePacked(
      ['string', 'uint256'],
      ['ERC-BAM.v1', BigInt(chainId)]
    )
  );
}

/**
 * Compute the domain-separated signed hash for a BAM message.
 * signedHash = keccak256(domain || keccak256(author || nonce(uint64) || contents))
 */
export function computeSignedHash(
  author: string,
  nonce: number,
  content: string,
  chainId: number
): `0x${string}` {
  const domain = computeBAMDomain(chainId);
  const contentBytes = new TextEncoder().encode(content);

  const messageHash = keccak256(
    encodePacked(
      ['address', 'uint64', 'bytes'],
      [
        author as `0x${string}`,
        BigInt(nonce),
        toHex(contentBytes),
      ]
    )
  );

  return keccak256(
    encodePacked(['bytes32', 'bytes32'], [domain, messageHash])
  );
}

/**
 * Compute BLS proof of possession signature.
 * domainSep = keccak256("SocialBlobs-BLS-PoP-v1" || chainId || registryAddress)
 * popMessage = keccak256(domainSep || owner || blsPubKey)
 */
export async function computePopSignature(
  privateKey: Uint8Array,
  address: string,
  pubKeyBytes: Uint8Array,
  chainId: number,
  registryAddress: string
): Promise<Uint8Array> {
  const domainSep = keccak256(
    encodePacked(
      ['string', 'uint256', 'address'],
      ['SocialBlobs-BLS-PoP-v1', BigInt(chainId), registryAddress as `0x${string}`]
    )
  );

  const popMessage = keccak256(
    encodePacked(
      ['bytes32', 'address', 'bytes'],
      [domainSep, address as `0x${string}`, toHex(pubKeyBytes)]
    )
  );

  return signBLS(privateKey, popMessage);
}
