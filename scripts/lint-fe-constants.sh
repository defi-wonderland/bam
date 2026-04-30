#!/usr/bin/env bash
#
# CI gate: reject literal field-element constants in bam-poster /
# bam-reader source. Both packages MUST source `* 31`, `* 32`, and
# `4096` from `bam-sdk`'s blob/constants.ts (the single source of
# truth). Inline literals drift over time and become a silent
# producer/reader divergence (red-team C-8 / G-9 in
# docs/specs/features/006-blob-packing-multi-tag/plan.md).
#
# Allowed: identifiers and imports (handled by exempting `import`
# lines and tolerating constant *imports* but no standalone
# declarations).
#
# Exit 0 on a clean tree; exit 1 if any forbidden literal lands.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES=("packages/bam-poster/src" "packages/bam-reader/src")
# Patterns: literal multiplications and assignments + the bare 4096
# literal anywhere outside an import. Word-boundary anchored.
FORBIDDEN_RE='\* 31[^0-9]|\* 32[^0-9]|= 31[^0-9]|= 32[^0-9]|\b4096\b'

violations=0
for pkg in "${PACKAGES[@]}"; do
  while IFS= read -r -d '' file; do
    # Skip the test files (they may legitimately use literal constants
    # in fixtures).
    case "$file" in
      *.test.ts) continue ;;
    esac
    # Strip line/block comments and string literals before applying
    # the forbidden-literal regex. This avoids flagging documentation
    # ("range [0, 4096)"), JSDoc blocks, and string error messages.
    # Per-file pipeline:
    #   1. strip block comments (/* … */ across lines via tr+sed pair)
    #   2. strip line comments (// to end of line)
    #   3. strip single- and double-quoted strings (greedy is OK; we
    #      only ever apply this to ts source where strings stay on
    #      one logical line for our grep purposes).
    matches=$(awk '
      BEGIN { inblock = 0 }
      {
        line = $0
        # Strip block comments (single-line /* … */ and partial
        # spans). For multi-line we just track an "inside block"
        # flag.
        if (inblock) {
          if (sub(/^.*\*\//, "", line)) { inblock = 0 } else { next }
        }
        while (sub(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//, "", line)) {}
        if (sub(/\/\*.*$/, "", line)) { inblock = 1 }
        sub(/\/\/.*$/, "", line)
        # Strip string literals.
        gsub(/"([^"\\\\]|\\\\.)*"/, "\"\"", line)
        gsub(/'\''([^'\''\\\\]|\\\\.)*'\''/, "'\'''\''", line)
        # Print with original line number prefix for the matcher.
        printf "%d:%s\n", NR, line
      }
    ' "$file" \
      | grep -E ":.*($FORBIDDEN_RE)" \
      | grep -vE "^[0-9]+:\s*import\s|REORG_WINDOW|MAX_FEE|RPC_URL|PORT|MAX_BLOCKS_PER_RANGE|MAX_BLOCKS_BACKFILL|RETRY|RATE_LIMIT|chainId|gas|timeout" \
      || true)
    if [ -n "$matches" ]; then
      while IFS= read -r line; do
        echo "$file:$line" >&2
        violations=$((violations + 1))
      done <<< "$matches"
    fi
  done < <(find "$REPO_ROOT/$pkg" -type f \( -name "*.ts" -o -name "*.tsx" \) -print0)
done

if [ "$violations" -gt 0 ]; then
  echo >&2
  echo "lint-fe-constants: $violations forbidden literal(s) in bam-poster/bam-reader src." >&2
  echo "Import the constants from 'bam-sdk' instead." >&2
  exit 1
fi

echo "lint-fe-constants: clean ($(echo "${PACKAGES[*]}"))"
