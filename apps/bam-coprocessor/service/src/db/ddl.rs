//! Run the embedded coprocessor schema at service startup. Idempotent;
//! safe to call on every boot. No SCHEMA_VERSION coupling with bam-store.

use sqlx::PgPool;

const SCHEMA_SQL: &str = include_str!("schema.sql");

pub async fn ensure_schema(pool: &PgPool) -> anyhow::Result<()> {
    // sqlx::Executor::execute on a multi-statement &str runs the whole
    // batch in one round-trip. Each statement is wrapped in IF NOT EXISTS.
    sqlx::raw_sql(SCHEMA_SQL).execute(pool).await?;
    Ok(())
}
