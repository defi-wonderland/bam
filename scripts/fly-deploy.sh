#!/usr/bin/env bash
# Redeploys the chain-side Fly apps (bam-poster, bam-reader, bam-indexer)
# sequentially via `flyctl deploy --remote-only -c fly.<svc>.toml`.
# Sequential and without --detach so a failure stops the chain instead of
# leaving half the fleet on a new image.
#
# Usage:
#   scripts/fly-deploy.sh                                  # all apps, in order
#   scripts/fly-deploy.sh --app bam-poster                 # single app
#   scripts/fly-deploy.sh -- --strategy rolling            # forward to flyctl
#   scripts/fly-deploy.sh --app bam-reader -- --build-only
#
# bam-pg is a Fly Managed Postgres cluster, not a deployable app, so it
# is intentionally not handled here.

set -euo pipefail

# Default deploy order: poster → reader → indexer. Indexer is downstream
# of reader (it reads from bam-store's tables that reader populates), so
# bringing it up last is the natural sequence.
#
# A case function instead of `declare -A` keeps this compatible with
# macOS's default bash 3.2 — contributors shouldn't need `brew install
# bash` to run a deploy.
APPS=(bam-poster bam-reader bam-indexer)
toml_for() {
  case "$1" in
    bam-poster)  echo fly.poster.toml ;;
    bam-reader)  echo fly.reader.toml ;;
    bam-indexer) echo fly.indexer.toml ;;
    *) return 1 ;;
  esac
}

usage() {
  cat >&2 <<'USAGE'
usage: scripts/fly-deploy.sh [--app <name>] [-- <flyctl args>...]

Deploys the chain-side Fly apps via `flyctl deploy --remote-only`.
Defaults to deploying bam-poster, then bam-reader, then bam-indexer.

  --app <name>   deploy only the named app (bam-poster | bam-reader | bam-indexer)
  --             forward all subsequent args to `flyctl deploy`
  -h, --help     show this message

Run from the repo root.
USAGE
}

SELECTED=""
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      if [[ $# -lt 2 ]]; then
        echo "error: --app requires a value" >&2
        exit 1
      fi
      SELECTED="$2"
      shift 2
      ;;
    --)
      shift
      EXTRA=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

TARGETS=()
if [[ -n "$SELECTED" ]]; then
  if ! toml_for "$SELECTED" >/dev/null; then
    echo "error: unknown app: $SELECTED (expected one of: ${APPS[*]})" >&2
    exit 1
  fi
  TARGETS=("$SELECTED")
else
  TARGETS=("${APPS[@]}")
fi

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not found on PATH" >&2
  exit 1
fi

echo "flyctl: $(flyctl version)"

for app in "${TARGETS[@]}"; do
  toml=$(toml_for "$app")
  if [[ ! -f "$toml" ]]; then
    echo "error: $toml not found (run from repo root)" >&2
    exit 1
  fi
  echo
  echo "==> deploying $app ($toml)"
  flyctl deploy -c "$toml" --remote-only "${EXTRA[@]}"
done
