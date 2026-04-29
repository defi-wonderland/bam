#!/usr/bin/env bash
# Imports per-service secrets into Fly from .env.local, plus the Managed
# Postgres DSN passed as the first arg.
#
# Usage:
#   scripts/fly-set-secrets.sh "postgres://user:pass@host/db"
#
# Run once for each app (the script handles both: bam-poster and bam-reader).

set -euo pipefail

DSN="${1:?usage: fly-set-secrets.sh <POSTGRES_DSN>}"
ENV_FILE="${ENV_FILE:-.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

# bam-poster: chain-side POSTER_* + POSTGRES_URL
{
  grep -E '^POSTER_' "$ENV_FILE"
  printf 'POSTGRES_URL=%s\n' "$DSN"
} | fly secrets import -a bam-poster --stage

# bam-reader: chain-side READER_* + POSTGRES_URL.
# IMPORTANT: do NOT also import POSTER_CHAIN_ID — the reader refuses to
# start when both POSTER_CHAIN_ID and READER_CHAIN_ID are present and
# differ.
{
  grep -E '^READER_' "$ENV_FILE"
  printf 'POSTGRES_URL=%s\n' "$DSN"
} | fly secrets import -a bam-reader --stage

echo
echo "Staged. Deploy each app to apply:"
echo "  fly deploy -c fly.poster.toml"
echo "  fly deploy -c fly.reader.toml"
