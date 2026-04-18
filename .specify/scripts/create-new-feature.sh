#!/usr/bin/env bash
# Create a new feature directory under docs/specs/features/ with the next
# zero-padded number and the given slug. Prints the directory path on stdout.
#
# Usage: .specify/scripts/create-new-feature.sh <slug>

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <slug>" >&2
  exit 1
fi

slug="$1"

if ! [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: slug must be lowercase letters, digits, and hyphens" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
features_dir="$repo_root/docs/specs/features"
mkdir -p "$features_dir"

last_num=$(
  find "$features_dir" -maxdepth 1 -mindepth 1 -type d \
    -printf '%f\n' 2>/dev/null \
  | grep -E '^[0-9]{3}-' \
  | sort \
  | tail -n1 \
  | cut -d- -f1 \
  || true
)
last_num="${last_num:-000}"
next_num=$(printf "%03d" "$((10#$last_num + 1))")

feature_dir="$features_dir/${next_num}-${slug}"
if [ -e "$feature_dir" ]; then
  echo "error: $feature_dir already exists" >&2
  exit 1
fi

mkdir -p "$feature_dir"
echo "$feature_dir"
