//! Typed sqlx queries against the `coprocessor.*` schema. Plain `sqlx::query`
//! calls (no compile-time `query!` macros — keeps CI off a live DB).

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool, Row};

#[derive(Debug, Clone)]
pub struct Watermark {
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
}

impl Default for Watermark {
    fn default() -> Self {
        Self { block_number: 0, tx_index: 0, msg_index: 0 }
    }
}

#[derive(Debug, Clone, FromRow)]
pub struct ValidationRow {
    pub message_hash: Vec<u8>,
    pub chain_id: i64,
    pub versioned_hash: Vec<u8>,
    pub content_tag: Vec<u8>,
    pub start_fe: i32,
    pub end_fe: i32,
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
    pub sender: Vec<u8>,
    pub nonce: i64,
    pub cycles: i64,
    pub validated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ProofSummaryRow {
    pub message_hash: Vec<u8>,
    pub chain_id: i64,
    pub versioned_hash: Vec<u8>,
    pub content_tag: Vec<u8>,
    pub start_fe: i32,
    pub end_fe: i32,
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
    pub sender: Vec<u8>,
    pub nonce: i64,
    pub cycles: i64,
    pub proof_size: i32,
    pub request_id: Vec<u8>,
    pub tx_hash: Option<Vec<u8>>,
    pub proof_type: String,
    pub sp1_version: String,
    pub proven_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ProofFullRow {
    pub message_hash: Vec<u8>,
    pub chain_id: i64,
    pub versioned_hash: Vec<u8>,
    pub content_tag: Vec<u8>,
    pub start_fe: i32,
    pub end_fe: i32,
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
    pub sender: Vec<u8>,
    pub nonce: i64,
    pub cycles: i64,
    pub proof_size: i32,
    pub proof_bytes: Vec<u8>,
    pub public_values: Vec<u8>,
    pub request_id: Vec<u8>,
    pub tx_hash: Option<Vec<u8>>,
    pub proof_type: String,
    pub sp1_version: String,
    pub proven_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct InFlightRow {
    pub request_id: Vec<u8>,
    pub message_hash: Vec<u8>,
    pub chain_id: i64,
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct VkCacheRow {
    pub vk_hash: String,
    pub groth16_vk: Vec<u8>,
    pub sp1_version: String,
    pub captured_at: DateTime<Utc>,
}

// ── Watermarks ─────────────────────────────────────────────────────────────

pub async fn read_watermark(
    pool: &PgPool,
    job: &str,
    chain_id: i64,
) -> anyhow::Result<Watermark> {
    let row = sqlx::query(
        "SELECT block_number, tx_index, msg_index
           FROM coprocessor.watermarks
          WHERE job = $1 AND chain_id = $2",
    )
    .bind(job)
    .bind(chain_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => Ok(Watermark {
            block_number: r.try_get("block_number")?,
            tx_index: r.try_get("tx_index")?,
            msg_index: r.try_get("msg_index")?,
        }),
        None => Ok(Watermark::default()),
    }
}

pub async fn upsert_watermark(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job: &str,
    chain_id: i64,
    w: &Watermark,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO coprocessor.watermarks
           (job, chain_id, block_number, tx_index, msg_index, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (job, chain_id) DO UPDATE
           SET block_number = EXCLUDED.block_number,
               tx_index     = EXCLUDED.tx_index,
               msg_index    = EXCLUDED.msg_index,
               updated_at   = now()",
    )
    .bind(job)
    .bind(chain_id)
    .bind(w.block_number)
    .bind(w.tx_index)
    .bind(w.msg_index)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ── Validations ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_validation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    message_hash: &[u8],
    chain_id: i64,
    versioned_hash: &[u8],
    content_tag: &[u8],
    start_fe: i32,
    end_fe: i32,
    block_number: i64,
    tx_index: i32,
    msg_index: i32,
    sender: &[u8],
    nonce: i64,
    cycles: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO coprocessor.validations
           (message_hash, chain_id, versioned_hash, content_tag,
            start_fe, end_fe, block_number, tx_index, msg_index,
            sender, nonce, cycles, validated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (chain_id, message_hash) DO NOTHING",
    )
    .bind(message_hash)
    .bind(chain_id)
    .bind(versioned_hash)
    .bind(content_tag)
    .bind(start_fe)
    .bind(end_fe)
    .bind(block_number)
    .bind(tx_index)
    .bind(msg_index)
    .bind(sender)
    .bind(nonce)
    .bind(cycles)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn validations_count(pool: &PgPool, chain_id: i64) -> anyhow::Result<i64> {
    let row = sqlx::query("SELECT COUNT(*)::bigint FROM coprocessor.validations WHERE chain_id = $1")
        .bind(chain_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<i64, _>(0)?)
}

pub async fn last_validation_at(
    pool: &PgPool,
    chain_id: i64,
) -> anyhow::Result<Option<DateTime<Utc>>> {
    let row = sqlx::query(
        "SELECT MAX(validated_at) FROM coprocessor.validations WHERE chain_id = $1",
    )
    .bind(chain_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get::<Option<DateTime<Utc>>, _>(0)?)
}

pub async fn list_validations_page(
    pool: &PgPool,
    chain_id: i64,
    after: Option<(DateTime<Utc>, Vec<u8>)>,
    limit: i64,
) -> anyhow::Result<Vec<ValidationRow>> {
    let rows = match after {
        None => {
            sqlx::query_as::<_, ValidationRow>(
                "SELECT message_hash, chain_id, versioned_hash, content_tag,
                        start_fe, end_fe, block_number, tx_index, msg_index,
                        sender, nonce, cycles, validated_at
                   FROM coprocessor.validations
                  WHERE chain_id = $1
                  ORDER BY validated_at DESC, message_hash DESC
                  LIMIT $2",
            )
            .bind(chain_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        Some((at, hash)) => {
            sqlx::query_as::<_, ValidationRow>(
                "SELECT message_hash, chain_id, versioned_hash, content_tag,
                        start_fe, end_fe, block_number, tx_index, msg_index,
                        sender, nonce, cycles, validated_at
                   FROM coprocessor.validations
                  WHERE chain_id = $1
                    AND (validated_at, message_hash) < ($2, $3)
                  ORDER BY validated_at DESC, message_hash DESC
                  LIMIT $4",
            )
            .bind(chain_id)
            .bind(at)
            .bind(hash)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}

// ── Proofs ─────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_proof(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    row: &ProofFullRow,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO coprocessor.proofs
           (message_hash, chain_id, versioned_hash, content_tag,
            start_fe, end_fe, block_number, tx_index, msg_index,
            sender, nonce, cycles, proof_size, proof_bytes, public_values,
            request_id, tx_hash, proof_type, sp1_version, proven_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 $11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (chain_id, message_hash) DO NOTHING",
    )
    .bind(&row.message_hash)
    .bind(row.chain_id)
    .bind(&row.versioned_hash)
    .bind(&row.content_tag)
    .bind(row.start_fe)
    .bind(row.end_fe)
    .bind(row.block_number)
    .bind(row.tx_index)
    .bind(row.msg_index)
    .bind(&row.sender)
    .bind(row.nonce)
    .bind(row.cycles)
    .bind(row.proof_size)
    .bind(&row.proof_bytes)
    .bind(&row.public_values)
    .bind(&row.request_id)
    .bind(&row.tx_hash)
    .bind(&row.proof_type)
    .bind(&row.sp1_version)
    .bind(row.proven_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn proof_count(pool: &PgPool, chain_id: i64) -> anyhow::Result<i64> {
    let row = sqlx::query("SELECT COUNT(*)::bigint FROM coprocessor.proofs WHERE chain_id = $1")
        .bind(chain_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<i64, _>(0)?)
}

pub async fn last_proof(
    pool: &PgPool,
    chain_id: i64,
) -> anyhow::Result<Option<(DateTime<Utc>, Vec<u8>)>> {
    let row = sqlx::query(
        "SELECT proven_at, message_hash
           FROM coprocessor.proofs
          WHERE chain_id = $1
          ORDER BY proven_at DESC, message_hash DESC
          LIMIT 1",
    )
    .bind(chain_id)
    .fetch_optional(pool)
    .await?;
    match row {
        None => Ok(None),
        Some(r) => {
            let at: DateTime<Utc> = r.try_get("proven_at")?;
            let h: Vec<u8> = r.try_get("message_hash")?;
            Ok(Some((at, h)))
        }
    }
}

pub async fn list_proofs_page(
    pool: &PgPool,
    chain_id: i64,
    after: Option<(DateTime<Utc>, Vec<u8>)>,
    limit: i64,
) -> anyhow::Result<Vec<ProofSummaryRow>> {
    let rows = match after {
        None => {
            sqlx::query_as::<_, ProofSummaryRow>(
                "SELECT message_hash, chain_id, versioned_hash, content_tag,
                        start_fe, end_fe, block_number, tx_index, msg_index,
                        sender, nonce, cycles, proof_size,
                        request_id, tx_hash, proof_type, sp1_version, proven_at
                   FROM coprocessor.proofs
                  WHERE chain_id = $1
                  ORDER BY proven_at DESC, message_hash DESC
                  LIMIT $2",
            )
            .bind(chain_id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        Some((at, hash)) => {
            sqlx::query_as::<_, ProofSummaryRow>(
                "SELECT message_hash, chain_id, versioned_hash, content_tag,
                        start_fe, end_fe, block_number, tx_index, msg_index,
                        sender, nonce, cycles, proof_size,
                        request_id, tx_hash, proof_type, sp1_version, proven_at
                   FROM coprocessor.proofs
                  WHERE chain_id = $1
                    AND (proven_at, message_hash) < ($2, $3)
                  ORDER BY proven_at DESC, message_hash DESC
                  LIMIT $4",
            )
            .bind(chain_id)
            .bind(at)
            .bind(hash)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows)
}

pub async fn get_proof_by_hash(
    pool: &PgPool,
    chain_id: i64,
    message_hash: &[u8],
) -> anyhow::Result<Option<ProofFullRow>> {
    let row = sqlx::query_as::<_, ProofFullRow>(
        "SELECT message_hash, chain_id, versioned_hash, content_tag,
                start_fe, end_fe, block_number, tx_index, msg_index,
                sender, nonce, cycles, proof_size, proof_bytes, public_values,
                request_id, tx_hash, proof_type, sp1_version, proven_at
           FROM coprocessor.proofs
          WHERE chain_id = $1 AND message_hash = $2",
    )
    .bind(chain_id)
    .bind(message_hash)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_proofs_by_versioned_hash(
    pool: &PgPool,
    chain_id: i64,
    versioned_hash: &[u8],
) -> anyhow::Result<Vec<ProofSummaryRow>> {
    let rows = sqlx::query_as::<_, ProofSummaryRow>(
        "SELECT message_hash, chain_id, versioned_hash, content_tag,
                start_fe, end_fe, block_number, tx_index, msg_index,
                sender, nonce, cycles, proof_size,
                request_id, tx_hash, proof_type, sp1_version, proven_at
           FROM coprocessor.proofs
          WHERE chain_id = $1 AND versioned_hash = $2
          ORDER BY msg_index ASC",
    )
    .bind(chain_id)
    .bind(versioned_hash)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ── proof_in_flight (v1-unused; reserved for NetworkClient migration) ──────

#[allow(clippy::too_many_arguments, dead_code)]
pub async fn insert_in_flight(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    request_id: &[u8],
    message_hash: &[u8],
    chain_id: i64,
    block_number: i64,
    tx_index: i32,
    msg_index: i32,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO coprocessor.proof_in_flight
           (request_id, message_hash, chain_id, block_number, tx_index, msg_index, started_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (chain_id, request_id) DO NOTHING",
    )
    .bind(request_id)
    .bind(message_hash)
    .bind(chain_id)
    .bind(block_number)
    .bind(tx_index)
    .bind(msg_index)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn delete_in_flight(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    request_id: &[u8],
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM coprocessor.proof_in_flight WHERE request_id = $1")
        .bind(request_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn list_in_flight(pool: &PgPool) -> anyhow::Result<Vec<InFlightRow>> {
    let rows = sqlx::query_as::<_, InFlightRow>(
        "SELECT request_id, message_hash, chain_id,
                block_number, tx_index, msg_index, started_at
           FROM coprocessor.proof_in_flight",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn in_flight_count(pool: &PgPool, chain_id: i64) -> anyhow::Result<i64> {
    let row = sqlx::query(
        "SELECT COUNT(*)::bigint FROM coprocessor.proof_in_flight WHERE chain_id = $1",
    )
    .bind(chain_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get::<i64, _>(0)?)
}

// ── VK cache ───────────────────────────────────────────────────────────────

pub async fn get_vk(pool: &PgPool) -> anyhow::Result<Option<VkCacheRow>> {
    let row = sqlx::query_as::<_, VkCacheRow>(
        "SELECT vk_hash, groth16_vk, sp1_version, captured_at
           FROM coprocessor.vk_cache
          WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_vk(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    vk_hash: &str,
    groth16_vk: &[u8],
    sp1_version: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO coprocessor.vk_cache (id, vk_hash, groth16_vk, sp1_version, captured_at)
         VALUES (1, $1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE
           SET vk_hash = EXCLUDED.vk_hash,
               groth16_vk = EXCLUDED.groth16_vk,
               sp1_version = EXCLUDED.sp1_version,
               captured_at = now()",
    )
    .bind(vk_hash)
    .bind(groth16_vk)
    .bind(sp1_version)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
