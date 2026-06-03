//! Blob retrieval: bam-reader `/blobs/:vh` first, beacon-API fallback.
//!
//! Beacon slot resolution uses a bracket + binary search (logarithmic in
//! window) so a ±tens-of-thousands-of-slots drift against the linear
//! interpolation estimate still terminates quickly. Earlier ±50 linear
//! scan silently failed past that radius.

use std::io::Read;

use sha2::{Digest, Sha256};

/// Beacon API calibration (Sepolia). The slope between these two points
/// gives us a starting slot estimate from an execution block number.
pub const BEACON_URL_SEPOLIA: &str = "https://lodestar-sepolia.chainsafe.io";
pub const REF_EXEC_A: f64 = 10_926_101.0;
pub const REF_SLOT_A: f64 = 10_338_743.0;
pub const REF_EXEC_B: f64 = 10_933_021.0;
pub const REF_SLOT_B: f64 = 10_345_720.0;

const PROBE_BLOCK_DEPTH: i64 = 64;
const BRACKET_WINDOWS: &[i64] = &[200, 1000, 5000, 20_000, 100_000];

// ── Hex helpers (used by callers + by the binary tests) ─────────────────────

pub fn decode_hex32(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s)
        .expect("invalid hex")
        .try_into()
        .expect("expected 32 bytes")
}

pub fn decode_hex20(s: &str) -> [u8; 20] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s)
        .expect("invalid hex")
        .try_into()
        .expect("expected 20 bytes")
}

pub fn decode_hex_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex")
}

// ── Blob retrieval ──────────────────────────────────────────────────────────

/// Try bam-reader first; on failure fall through to the beacon API.
pub fn fetch_blob_bytes(
    reader_url: &str,
    versioned_hash_hex: &str,
    versioned_hash: &[u8; 32],
    exec_block: u64,
    chain_id: u64,
) -> Vec<u8> {
    let url = format!("{}/blobs/{}", reader_url, versioned_hash_hex);
    match ureq::get(&url).call() {
        Ok(resp) => {
            let mut bytes = Vec::with_capacity(131_072);
            match resp.into_reader().read_to_end(&mut bytes) {
                Ok(_) if bytes.len() == 131_072 => return bytes,
                Ok(_) => eprintln!(
                    "  bam-reader blob: got {} bytes (expected 131072), trying beacon chain…",
                    bytes.len()
                ),
                Err(e) => eprintln!("  bam-reader blob read failed ({}), trying beacon chain…", e),
            }
        }
        Err(e) => eprintln!("  bam-reader blob fetch failed ({}), trying beacon chain…", e),
    }

    let beacon_url = match chain_id {
        11155111 => BEACON_URL_SEPOLIA,
        other => panic!(
            "bam-reader blob fetch failed and no beacon fallback is configured for chain {other}.\n\
             Only Sepolia (11155111) has a built-in beacon fallback."
        ),
    };

    eprintln!("  fetching from beacon chain (block {exec_block})…");
    fetch_blob_from_beacon(beacon_url, exec_block, versioned_hash)
        .unwrap_or_else(|e| panic!("beacon fallback failed: {e}"))
}

// ── Beacon slot search ──────────────────────────────────────────────────────

pub fn estimate_beacon_slot(exec_block: u64) -> u64 {
    let slope = (REF_SLOT_B - REF_SLOT_A) / (REF_EXEC_B - REF_EXEC_A);
    (REF_SLOT_A + slope * (exec_block as f64 - REF_EXEC_A)).round() as u64
}

pub fn get_exec_block_at_slot(beacon_url: &str, slot: u64) -> Option<u64> {
    let url = format!("{}/eth/v2/beacon/blocks/{}", beacon_url, slot);
    let resp = ureq::get(&url).call().ok()?;
    let json: serde_json::Value = resp.into_json().ok()?;
    json["data"]["message"]["body"]["execution_payload"]["block_number"]
        .as_str()
        .and_then(|s| s.parse().ok())
}

/// Forward-probe up to `PROBE_BLOCK_DEPTH` slots looking for a non-missed
/// slot; returns `Some((slot, block_number))` or `None` if all of them
/// were missed.
fn probe_forward(
    beacon_url: &str,
    start: u64,
    upper_inclusive: u64,
) -> Option<(u64, u64)> {
    let end = std::cmp::min(start + PROBE_BLOCK_DEPTH as u64, upper_inclusive.saturating_add(1));
    for s in start..end {
        if let Some(bn) = get_exec_block_at_slot(beacon_url, s) {
            return Some((s, bn));
        }
    }
    None
}

/// Backward-probe up to `PROBE_BLOCK_DEPTH` slots looking for a non-missed
/// slot; returns `Some((slot, block_number))` or `None` if all of them
/// were missed.
fn probe_backward(
    beacon_url: &str,
    start: u64,
    lower_inclusive: u64,
) -> Option<(u64, u64)> {
    let mut s = start;
    let mut left = PROBE_BLOCK_DEPTH as u64;
    while left > 0 && s >= lower_inclusive {
        if let Some(bn) = get_exec_block_at_slot(beacon_url, s) {
            return Some((s, bn));
        }
        if s == 0 {
            break;
        }
        s -= 1;
        left -= 1;
    }
    None
}

/// Bracket + binary search for the beacon slot containing `exec_block`.
/// Probes expanding windows around the linear estimate until the target
/// block is bracketed, then binary-searches inside the bracket. Logarithmic
/// in the window distance; survives missed slots and large drift.
pub fn find_slot_for_exec_block(
    beacon_url: &str,
    exec_block: u64,
) -> Result<u64, String> {
    let approx = estimate_beacon_slot(exec_block) as i64;

    let mut lo: i64 = approx;
    let mut hi: i64 = approx;
    let mut bracket = None;

    for &window in BRACKET_WINDOWS {
        let win_lo = std::cmp::max(0, approx - window) as u64;
        let win_hi = (approx + window) as u64;
        let Some((slot_lo, bn_lo)) = probe_forward(beacon_url, win_lo, win_hi) else {
            continue;
        };
        let Some((slot_hi, bn_hi)) = probe_backward(beacon_url, win_hi, win_lo) else {
            continue;
        };
        if bn_lo <= exec_block && exec_block <= bn_hi {
            lo = slot_lo as i64;
            hi = slot_hi as i64;
            bracket = Some(());
            break;
        }
    }

    if bracket.is_none() {
        return Err(format!(
            "could not bracket exec block {exec_block} around approx slot {approx}"
        ));
    }

    while lo <= hi {
        let mid = (lo + hi) / 2;
        let probe = probe_forward(beacon_url, mid as u64, hi as u64);
        let Some((slot, bn)) = probe else {
            // every slot from mid..=hi was missed → search lower half.
            hi = mid - 1;
            continue;
        };
        match bn.cmp(&exec_block) {
            std::cmp::Ordering::Equal => return Ok(slot),
            std::cmp::Ordering::Less => lo = slot as i64 + 1,
            std::cmp::Ordering::Greater => hi = mid - 1,
        }
    }

    Err(format!(
        "binary search did not converge for exec block {exec_block}"
    ))
}

/// Resolve the beacon slot for `exec_block`, fetch its blob sidecars, and
/// return the sidecar matching `want_vh`.
pub fn fetch_blob_from_beacon(
    beacon_url: &str,
    exec_block: u64,
    want_vh: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let slot = find_slot_for_exec_block(beacon_url, exec_block)?;
    eprintln!("  found beacon slot {slot} for exec block {exec_block}");

    let url = format!("{}/eth/v1/beacon/blob_sidecars/{}", beacon_url, slot);
    let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let sidecars = json["data"]
        .as_array()
        .ok_or_else(|| "no 'data' array in sidecar response".to_string())?;

    for sidecar in sidecars {
        let commitment_hex = sidecar["kzg_commitment"]
            .as_str()
            .ok_or_else(|| "missing kzg_commitment in sidecar".to_string())?;
        let c_bytes = hex::decode(commitment_hex.trim_start_matches("0x"))
            .map_err(|e| e.to_string())?;
        let c_hash: [u8; 32] = Sha256::digest(&c_bytes).into();
        let mut vh = [0u8; 32];
        vh[0] = 0x01;
        vh[1..].copy_from_slice(&c_hash[1..]);
        if &vh == want_vh {
            let blob_hex = sidecar["blob"]
                .as_str()
                .ok_or_else(|| "missing blob field in sidecar".to_string())?;
            let blob_bytes = hex::decode(blob_hex.trim_start_matches("0x"))
                .map_err(|e| e.to_string())?;
            if blob_bytes.len() != 131_072 {
                return Err(format!("unexpected blob size: {} bytes", blob_bytes.len()));
            }
            return Ok(blob_bytes);
        }
    }

    Err(format!(
        "no sidecar matched versioned hash 0x{} at slot {slot}",
        hex::encode(want_vh)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_beacon_slot_calibration_anchors() {
        let a = estimate_beacon_slot(REF_EXEC_A as u64);
        let b = estimate_beacon_slot(REF_EXEC_B as u64);
        assert_eq!(a, REF_SLOT_A as u64);
        assert_eq!(b, REF_SLOT_B as u64);
    }

    #[test]
    fn estimate_beacon_slot_is_monotonic() {
        let base = estimate_beacon_slot(REF_EXEC_A as u64);
        let next = estimate_beacon_slot(REF_EXEC_A as u64 + 1000);
        assert!(next > base);
    }

    #[test]
    fn decode_hex32_round_trip() {
        let bytes = decode_hex32("0x01bc15204a4c7779a37fd0d7988fe89a9cc4a148e7db926f4815f4c93ea879d1");
        assert_eq!(bytes[0], 0x01);
        assert_eq!(bytes[31], 0xd1);
    }
}
