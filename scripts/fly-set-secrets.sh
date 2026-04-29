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
# Run once; the script handles both apps (bam-poster and bam-reader).

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
# `|| true` so a no-match grep (env file with no POSTER_* lines) doesn't
# abort under set -euo pipefail before POSTGRES_URL gets staged.
{
  grep -E '^POSTER_' "$ENV_FILE" || true
  printf 'POSTGRES_URL=%s\n' "$DSN"
} | fly secrets import -a bam-poster --stage

# bam-reader: chain-side READER_* + POSTGRES_URL.
# IMPORTANT: do NOT also import POSTER_CHAIN_ID — the reader refuses to
# start when both POSTER_CHAIN_ID and READER_CHAIN_ID are present and
# differ.
{
  grep -E '^READER_' "$ENV_FILE" || true
  printf 'POSTGRES_URL=%s\n' "$DSN"
} | fly secrets import -a bam-reader --stage

echo
echo "Staged. Deploy each app to apply:"
echo "  fly deploy -c fly.poster.toml"
echo "  fly deploy -c fly.reader.toml"
