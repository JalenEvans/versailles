#!/usr/bin/env bash
#
# validate-docs.sh — docs drift gate
#
# Contributor-runnable, CI-gated. Walks docs/ and exits non-zero when the docs
# layer has drifted:
#   1. an artifact referenced in an index is missing, or
#   2. a file exists in docs/ that no index points to (drift).
#
# Indexes are every `index.md` under docs/ (including docs/index.md, the
# contributor map). Artifacts are the .md and .contract.yaml files they link.
# The root pointer itself and sub-directory indexes are the pointers, not
# artifacts, so they are exempt from the drift check.
#
# Usage: scripts/validate-docs.sh   (run from anywhere in the repo)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_DIR="$ROOT/docs"

fail=0

err() { printf 'ERROR: %s\n' "$*" >&2; fail=1; }

# normalize_rel PATH — collapse "." and ".." components of a relative path.
# Assumes the path stays inside docs/ (links never escape it).
normalize_rel() {
  local path="$1" out="" part
  local IFS='/'
  read -ra parts <<< "$path"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|'.') ;;
      '..') if [[ "$out" == */* ]]; then out="${out%/*}"; else out=""; fi ;;
      *)     out="${out:+$out/}$part" ;;
    esac
  done
  printf '%s' "$out"
}

declare -A referenced=()

echo "validating docs tree under $DOCS_DIR"
echo "pass 1: every relative link in every index must resolve"

# --- Pass 1: links from indexes must point at existing files ---------------
while IFS= read -r -d '' idx; do
  rel_idx="${idx#"$DOCS_DIR"/}"
  base="$(dirname "$rel_idx")"
  [[ "$base" == "." ]] && base=""

  # extract markdown link targets: [text](target)
  targets="$(grep -oE '\[[^]]*\]\([^)]*\)' "$idx" 2>/dev/null | sed -nE 's/^\[[^]]*\]\(([^)]*)\)$/\1/p' || true)"

  while IFS= read -r target; do
    [ -z "$target" ] && continue
    case "$target" in
      '#'*|'http://'*|'https://'*|'mailto:'*) continue ;;  # anchors / external
    esac
    target="${target%%#*}"   # strip fragment
    target="${target%%\?*}"  # strip query
    [ -z "$target" ] && continue

    rel_target="$(normalize_rel "${base:+$base/}$target")"
    if [ -f "$DOCS_DIR/$rel_target" ]; then
      referenced["$rel_target"]=1
    else
      err "missing artifact: $rel_idx links to '$target' but docs/$rel_target does not exist"
    fi
  done <<< "$targets"
done < <(find "$DOCS_DIR" -name 'index.md' -type f -print0)

echo "pass 2: every docs artifact must be referenced by some index"

# --- Pass 2: drift — files in docs/ that no index points to -----------------
while IFS= read -r -d '' f; do
  rel="${f#"$DOCS_DIR"/}"

  # index files are the pointers, not artifacts
  case "$rel" in
    index.md|*/index.md) continue ;;
  esac
  # only docs artifacts are subject to the drift rule
  case "$rel" in
    *.md|*.contract.yaml) ;;
    *) continue ;;
  esac

  if [[ -z "${referenced[$rel]+x}" ]]; then
    err "drift: $rel exists in docs/ but no index references it (register it in the appropriate index)"
  fi
done < <(find "$DOCS_DIR" -type f -print0)

if [ "$fail" -eq 0 ]; then
  file_count="$(find "$DOCS_DIR" -type f | wc -l | tr -d ' ')"
  echo "PASS: docs tree is consistent ($file_count files, no drift)"
  exit 0
fi

echo "FAIL: docs drift detected" >&2
exit 1