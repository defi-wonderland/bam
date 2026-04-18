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

last_num=0
shopt -s nullglob
for dir in "$features_dir"/[0-9][0-9][0-9]-*; do
  [ -d "$dir" ] || continue
  base="${dir##*/}"
  num=$((10#${base%%-*}))
  if [ "$num" -gt "$last_num" ]; then
    last_num="$num"
  fi
done
shopt -u nullglob

next_num=$(printf "%03d" "$((last_num + 1))")

feature_dir="$features_dir/${next_num}-${slug}"
if [ -e "$feature_dir" ]; then
  echo "error: $feature_dir already exists" >&2
  exit 1
fi

mkdir -p "$feature_dir"
echo "$feature_dir"
