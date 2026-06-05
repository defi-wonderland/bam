import { NextRequest, NextResponse } from 'next/server';

import {
  coprocessorErrorToResponse,
  getProofByMessageHash,
  getVk,
} from '@/lib/coprocessor-client';

/**
 * GET `/api/proof/[messageHash]/download` — server-composes a single
 * downloadable bundle so users can verify the proof offline. Includes:
 *   - the full Groth16 proof bytes (base64)
 *   - the public values (base64)
 *   - the SP1 verifying key material (`vkHash` + `groth16VkBytes`)
 *   - chain coordinates, sender, nonce, cycles, sp1Version
 *
 * Wraps the coprocessor's `/proof/:messageHash` + `/proof/vk` into one
 * JSON blob served with a `Content-Disposition: attachment` header so
 * browsers save it as `<messageHash>.proof.json`.
 */

const HASH_RE = /^0x[0-9a-f]{64}$/;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ messageHash: string }> }
): Promise<NextResponse> {
  const { messageHash } = await context.params;
  const lower = messageHash.toLowerCase();
  if (!HASH_RE.test(lower)) {
    return NextResponse.json({ error: 'invalid_message_hash' }, { status: 400 });
  }

  try {
    const [bundle, vk] = await Promise.all([
      getProofByMessageHash(lower),
      getVk(),
    ]);
    if (bundle === null) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const downloadable = {
      messageHash: bundle.messageHash,
      chainId: bundle.chainId,
      sender: bundle.sender,
      nonce: bundle.nonce,
      versionedHash: bundle.versionedHash,
      contentTag: bundle.contentTag,
      blockNumber: bundle.blockNumber,
      txIndex: bundle.txIndex,
      msgIndex: bundle.msgIndex,
      startFe: bundle.startFe,
      endFe: bundle.endFe,
      cycles: bundle.cycles,
      proofType: bundle.proofType,
      proofSize: bundle.proofSize,
      requestId: bundle.requestId,
      txHash: bundle.txHash,
      sp1Version: bundle.sp1Version,
      provenAt: bundle.provenAt,
      proofBytes: bundle.proofBytes,
      publicValues: bundle.publicValues,
      vk: vk
        ? {
            vkHash: vk.vkHash,
            groth16VkBytes: vk.groth16VkBytes,
            sp1Version: vk.sp1Version,
            capturedAt: vk.capturedAt,
          }
        : null,
    };

    return new NextResponse(JSON.stringify(downloadable, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${lower}.proof.json"`,
      },
    });
  } catch (err) {
    const mapped = coprocessorErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
