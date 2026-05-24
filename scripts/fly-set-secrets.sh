#!/usr/bin/env bash
# Imports per-service secrets into Fly from .env.local, plus the Managed
# Postgres DSN read from env or stdin.
#
# Usage (env):    FLY_POSTGRES_URL='postgres://user:pass@host/db' scripts/fly-set-secrets.sh
# Usage (stdin):  scripts/fly-set-secrets.sh <<< 'postgres://user:pass@host/db'
#
# The DSN is intentionally NOT accepted as a positional argument so it
# does not appear in `ps`, shell history, or process audit logs.
#
# Run once; the script handles all three apps (bam-poster, bam-reader,
# bam-indexer).

set -euo pipefail

DSN="${FLY_POSTGRES_URL:-}"
if [[ -z "$DSN" && ! -t 0 ]]; then
  read -r DSN
fi
if [[ -z "$DSN" ]]; then
  cat >&2 <<'USAGE'
error: Postgres DSN required.
  via env:    FLY_POSTGRES_URL='postgres://...' scripts/fly-set-secrets.sh
  via stdin:  scripts/fly-set-secrets.sh <<< 'postgres://...'
USAGE
  exit 1
fi
ENV_FILE="${ENV_FILE:-.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

# bam-poster: chain-side POSTER_* + POSTGRES_URL.
# The regex requires at least one char after `=` so placeholder lines
# like `POSTER_RPC_URL=` are skipped — Fly stores empty strings, and
# the poster's env parser treats '' the same as missing and refuses
# to start. `|| true` keeps a no-match grep from aborting under
# set -euo pipefail before POSTGRES_URL gets staged.
{
  grep -E '^POSTER_[A-Z0-9_]+=.+' "$ENV_FILE" || true
  printf 'POSTGRES_URL=%s\n' "$DSN"
} | fly secrets import -a bam-poster --stage

# bam-reader: chain-side READER_* + POSTGRES_URL.
# IMPORTANT: do NOT also import POSTER_CHAIN_ID — the reader refuses to
# start when both POSTER_CHAIN_ID and READER_CHAIN_ID are present and
# differ.
{
  grep -E '^READER_[A-Z0-9_]+=.+' "$ENV_FILE" || true
  printf 'POSTGRES_URL=%s\n' "$DSN"
} | fly secrets import -a bam-reader --stage

# bam-indexer: INDEXER_*. INDEXER_DB_URL is always set to the bam-pg
# DSN here, mirroring how POSTGRES_URL is set for poster/reader — the
# .env.local value is the developer's local DSN and would silently
# point a deployed indexer at localhost.
#
# Several INDEXER_* keys are filtered out before staging:
#   - INDEXER_DB_URL — always overridden from $DSN below.
#   - INDEXER_WRITE_DB_URL — left unset so the indexer falls back to
#     INDEXER_DB_URL (single-role strategy a). For strategy b, set it
#     out-of-band: `flyctl secrets set -a bam-indexer INDEXER_WRITE_DB_URL=...`
#     and grant the new role read on bam-store + write on the
#     indexer schemas. Filtering here prevents a local strategy-b
#     experiment from leaking through this script.
#   - INDEXER_HTTP_BIND / INDEXER_HTTP_PORT — set by fly.indexer.toml's
#     `[env]` block. Fly applies secrets after `[env]`, so staging
#     them as secrets would silently override the toml values
#     (e.g. a dev `INDEXER_HTTP_BIND=127.0.0.1` in .env.local would
#     make the indexer unreachable from Fly's proxy).
#
# Filtering only prevents new staging — it does not unset pre-existing
# Fly secrets. If you previously set any of the filtered keys via
# `flyctl secrets set` (e.g. a one-off strategy-b experiment), they
# persist and continue overriding `[env]`. Audit with
# `flyctl secrets list -a bam-indexer` and clear stale entries with
# `flyctl secrets unset -a bam-indexer <key>`.
{
  grep -E '^INDEXER_[A-Z0-9_]+=.+' "$ENV_FILE" \
    | grep -Ev '^INDEXER_(DB_URL|WRITE_DB_URL|HTTP_BIND|HTTP_PORT)=' \
    || true
  printf 'INDEXER_DB_URL=%s\n' "$DSN"
} | fly secrets import -a bam-indexer --stage

echo
echo "Staged. Deploy each app to apply:"
echo "  fly deploy -c fly.poster.toml"
echo "  fly deploy -c fly.reader.toml"
echo "  fly deploy -c fly.indexer.toml"
