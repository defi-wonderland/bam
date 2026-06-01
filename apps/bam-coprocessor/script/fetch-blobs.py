#!/usr/bin/env python3
"""
Fetch raw EIP-4844 blob bytes for BAM batches from the Ethereum Sepolia
beacon chain and write a blob cache JSON compatible with prove-reader --cache.

No API key required. Uses the Lodestar Sepolia public beacon API.

Usage:
    python3 fetch-blobs.py [--output multi-blob-cache.json]

Dependencies: pip install requests

After running:
    cargo run --release --bin prove-reader -- --execute \
        --cache multi-blob-cache.json --chain-id 11155111
"""

import argparse
import hashlib
import json
import sys
import requests

BAM_READER_URL = "https://bam-reader.fly.dev"
BEACON_URL     = "https://lodestar-sepolia.chainsafe.io"
CONTENT_TAG    = "0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718"

# Two calibration points for Sepolia (exec_block, beacon_slot):
#   (10926101, 10338743) and (10933021, 10345720)
# The offset = exec_block - slot decreases ~0.0082/slot going forward as
# missed slots accumulate. We use linear interpolation between the two
# reference points to estimate the slot for any exec block.
REF_EXEC_A, REF_SLOT_A = 10926101, 10338743
REF_EXEC_B, REF_SLOT_B = 10933021, 10345720
SEARCH_RADIUS = 50  # ±50 slots to handle remaining drift


def versioned_hash_from_commitment(commitment_hex: str) -> str:
    b = bytes.fromhex(commitment_hex.removeprefix("0x"))
    return "0x01" + hashlib.sha256(b).digest()[1:].hex()


def get_exec_block_at_slot(slot: int):
    """Return the execution block number at a beacon slot, or None if slot missed."""
    try:
        resp = requests.get(f"{BEACON_URL}/eth/v2/beacon/blocks/{slot}", timeout=10)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return int(resp.json()["data"]["message"]["body"]["execution_payload"]["block_number"])
    except Exception:
        return None


def estimate_slot(exec_block: int) -> int:
    """Linearly interpolate the beacon slot from two calibration points."""
    slope = (REF_SLOT_B - REF_SLOT_A) / (REF_EXEC_B - REF_EXEC_A)
    return round(REF_SLOT_A + slope * (exec_block - REF_EXEC_A))


def find_slot_for_exec_block(exec_block: int) -> int:
    """Find the beacon slot that contains the given execution block number."""
    approx = estimate_slot(exec_block)
    for delta in range(SEARCH_RADIUS + 1):
        for candidate in ([approx + delta] if delta == 0 else [approx - delta, approx + delta]):
            bn = get_exec_block_at_slot(candidate)
            if bn == exec_block:
                return candidate
    raise RuntimeError(
        f"Could not find beacon slot for exec block {exec_block} "
        f"(searched slots {approx - SEARCH_RADIUS}..{approx + SEARCH_RADIUS})"
    )


def fetch_blob_at_slot(slot: int, want_vh: str) -> str:
    """Return 0x-prefixed 131072-byte blob hex from beacon sidecars at slot."""
    resp = requests.get(f"{BEACON_URL}/eth/v1/beacon/blob_sidecars/{slot}", timeout=30)
    resp.raise_for_status()
    sidecars = resp.json().get("data", [])
    if not sidecars:
        raise RuntimeError(f"No blob sidecars at slot {slot}")

    for sidecar in sidecars:
        vh = versioned_hash_from_commitment(sidecar["kzg_commitment"])
        if vh.lower() == want_vh.lower():
            blob_bytes = bytes.fromhex(sidecar["blob"].removeprefix("0x"))
            if len(blob_bytes) != 131_072:
                raise RuntimeError(f"Unexpected blob size: {len(blob_bytes)}")
            print(f"    matched sidecar index={sidecar['index']} among {len(sidecars)} ✓")
            return "0x" + blob_bytes.hex()

    available = [versioned_hash_from_commitment(s["kzg_commitment"]) for s in sidecars]
    raise RuntimeError(f"No sidecar matched {want_vh} at slot {slot}. Available: {available}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reader-url", default=BAM_READER_URL)
    parser.add_argument("--content-tag", default=CONTENT_TAG)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--output", default="multi-blob-cache.json")
    args = parser.parse_args()

    print(f"Fetching batches from {args.reader_url}…")
    url = f"{args.reader_url}/batches?contentTag={args.content_tag}&status=confirmed&limit={args.limit}"
    batches = requests.get(url, timeout=30).json().get("batches", [])
    print(f"  {len(batches)} confirmed batch(es)\n")

    if not batches:
        print("No batches found.")
        sys.exit(0)

    cache = []
    for i, batch in enumerate(batches):
        versioned_hash = batch["blobVersionedHash"]
        exec_block     = batch["blockNumber"]
        print(f"[{i+1}/{len(batches)}] block={exec_block} tx={batch['txIndex']} vh={versioned_hash[:14]}…")
        try:
            print(f"    finding beacon slot…")
            slot = find_slot_for_exec_block(exec_block)
            print(f"    slot={slot}")
            blob_hex = fetch_blob_at_slot(slot, versioned_hash)
            cache.append({
                "versionedHash": versioned_hash,
                "blockNumber":   exec_block,
                "txIndex":       batch["txIndex"],
                "logIndex":      0,
                "txHash":        batch["txHash"],
                "startFE":       0,
                "endFE":         4096,
                "blobBytesHex":  blob_hex,
                "contentTag":    batch["contentTag"],
            })
            print(f"    saved ({len(blob_hex) // 2 - 1} bytes)\n")
        except Exception as e:
            print(f"    ERROR: {e}\n", file=sys.stderr)

    if not cache:
        print("No blobs fetched.", file=sys.stderr)
        sys.exit(1)

    with open(args.output, "w") as f:
        json.dump(cache, f)

    print(f"Saved {len(cache)} blob(s) to {args.output}")
    print(f"\nNext:")
    print(f"  cargo run --release --bin prove-reader -- --execute \\")
    print(f"    --cache {args.output} --chain-id 11155111")


if __name__ == "__main__":
    main()
