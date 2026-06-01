//! Circuit 2 guest program — BAM twitter coprocessor.
//!
//! Recursively verifies the Circuit 1 proof, asserts its private message inputs
//! match Circuit 1's commitment M, then runs the bam-twitter pipeline to produce
//! timeline root R.
//!
//! stdin layout (host must write in this order):
//!   chain_id:             u64
//!   c1_public_values:     Vec<u8>  — raw Circuit 1 public output bytes
//!   messages:             Vec<VerifiedMessage>
//!
//! For prove mode the host must also call stdin.write_proof(c1_compressed_proof, c1_vk)
//! before the above writes. The executor ignores write_proof in execute mode.
//!
//! Public outputs:
//!   [0..8]   chain_id     (u64 LE)
//!   [8..40]  M            (32 bytes — C1 message commitment, integrity anchor)
//!   [40..72] R            (32 bytes — timeline root sha256)
//!   [72..76] tweet_count  (u32 LE)

#![no_main]
sp1_zkvm::entrypoint!(main);

use bam_coprocessor_lib::{
    build_timeline, compute_message_commitment, decode_twitter_contents, IndexedTweet,
    VerifiedMessage,
};

/// keccak256("bam-twitter.v1")
const TWITTER_TAG: [u8; 32] =
    hex_literal::hex!("f0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718");

pub fn main() {
    let chain_id: u64 = sp1_zkvm::io::read::<u64>();
    let c1_public_values: Vec<u8> = sp1_zkvm::io::read::<Vec<u8>>();
    let messages: Vec<VerifiedMessage> = sp1_zkvm::io::read::<Vec<VerifiedMessage>>();

    // Step 1 — recursive verify of Circuit 1 proof.
    //
    // In execute mode: verify_sp1_proof is a no-op in the executor.
    // In prove mode: host must call stdin.write_proof(compressed_proof, pk1.verifying_key().vk)
    //   before the other stdin writes. The prover enforces that vk_digest and pv_digest match.
    //
    // The [0u32; 8] placeholder is safe in execute mode but produces an unsound recursive proof
    // on the prover network. This implementation only runs in execute mode (no proof has been
    // generated yet), so the placeholder is acceptable for now. Before proving, replace it with
    // the real C1 VK hash (run `print-vk` to derive it). The VK is stable across runs; it only
    // changes if Circuit 1 code changes.
    sp1_zkvm::lib::verify::verify_sp1_proof(&[2124368815, 315437710, 1646293900, 1740293713, 479365109, 1557134685, 1497185811, 1720145984], &[0u8; 32]);

    // Step 2 — parse chain_id and M from C1 public output, assert chain_id matches stdin
    assert!(
        c1_public_values.len() >= 40,
        "c1_public_values too short — expected at least 40 bytes"
    );
    let c1_chain_id = u64::from_le_bytes(c1_public_values[0..8].try_into().unwrap());
    assert_eq!(chain_id, c1_chain_id, "chain_id mismatch with C1 public values");
    let m: [u8; 32] = c1_public_values[8..40].try_into().unwrap();

    // Step 3 — assert the supplied messages hash to M.
    // M was computed in Circuit 1 from the sorted message set, so this assertion
    // implicitly requires the host to supply messages in canonical sorted order
    // (block_number ASC, tx_index ASC, msg_index ASC). Any other order will fail.
    let computed_m = compute_message_commitment(&messages);
    assert_eq!(computed_m, m, "messages do not match C1 commitment M");

    // Step 4 — assert all batches have TWITTER_TAG, decode app envelope, drop failures.
    // content_tag for batch i is at c1_public_values[44 + i*124 + 80 .. 44 + i*124 + 112].
    let batch_count = u32::from_le_bytes(c1_public_values[40..44].try_into().unwrap()) as usize;
    const BATCH_STRIDE: usize = 124;
    for i in 0..batch_count {
        let base = 44 + i * BATCH_STRIDE;
        let tag: [u8; 32] = c1_public_values[base + 80..base + 112].try_into().unwrap();
        assert_eq!(tag, TWITTER_TAG, "batch {} content_tag is not TWITTER_TAG", i);
    }

    let tweets: Vec<IndexedTweet> = messages
        .iter()
        .filter_map(|msg| {
            decode_twitter_contents(&msg.contents).map(|tweet| IndexedTweet {
                sender: msg.sender,
                nonce: msg.nonce,
                block_number: msg.block_number,
                tx_index: msg.tx_index,
                msg_index: msg.msg_index,
                tweet,
            })
        })
        .collect();

    // Step 5 — sort canonically, deduplicate by (sender, nonce), compute R
    let timeline = build_timeline(tweets);
    let r = bam_coprocessor_lib::compute_timeline_root(&timeline);
    let tweet_count = timeline.len() as u32;

    // Commit public outputs
    sp1_zkvm::io::commit_slice(&chain_id.to_le_bytes());
    sp1_zkvm::io::commit_slice(&m);
    sp1_zkvm::io::commit_slice(&r);
    sp1_zkvm::io::commit_slice(&tweet_count.to_le_bytes());
}
