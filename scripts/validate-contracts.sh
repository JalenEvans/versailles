#!/usr/bin/env bash
#
# validate-contracts.sh — contract validity gate
#
# Contributor-runnable, CI-gated. Parses every docs/contracts/*.contract.yaml
# and exits non-zero when a contract is invalid:
#   1. any required key is missing (context, owns, must, must_not, can,
#      limits, asserts), or
#   2. a contract's `context` has no matching spec at docs/specs/<context>.md.
#
# Empty-registry behavior: when no *.contract.yaml files exist, this script
# PASSES (exit 0) — a repo with no contracts registered is a valid bootstrap
# state. Contracts appear only when the contract authoring process registers
# the first one, and each one then requires its spec file (behavioral spec
# convention: docs/specs/<ctx>.md).
#
# Usage: scripts/validate-contracts.sh   (run from anywhere in the repo)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT/docs/contracts"
SPECS_DIR="$ROOT/docs/specs"

REQUIRED_KEYS=(context owns must must_not can limits asserts)

fail=0
err() { printf 'ERROR: %s\n' "$*" >&2; fail=1; }

shopt -s nullglob
contracts=("$CONTRACTS_DIR"/*.contract.yaml)

if [ "${#contracts[@]}" -eq 0 ]; then
  echo "PASS: no contracts registered (docs/contracts is empty — valid bootstrap state)"
  exit 0
fi

echo "validating contracts in $CONTRACTS_DIR"

for c in "${contracts[@]}"; do
  name="$(basename "$c")"

  # 1. required top-level keys must be present
  for key in "${REQUIRED_KEYS[@]}"; do
    if ! grep -qE "^${key}:" "$c"; then
      err "$name: missing required key '$key'"
    fi
  done

  # 2. context must have a matching spec: docs/specs/<context>.md
  ctx_raw="$(grep -E '^context:' "$c" | head -n1 | sed -nE 's/^context:[[:space:]]*(.*)$/\1/p' || true)"
  ctx="${ctx_raw%%#*}"                                             # strip trailing comment
  ctx="${ctx%\"}"; ctx="${ctx#\"}"                                 # strip surrounding double quotes
  ctx="${ctx%\'}"; ctx="${ctx#\'}"                                 # strip surrounding single quotes
  ctx="$(printf '%s' "$ctx" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"  # trim

  if [ -z "$ctx" ]; then
    err "$name: missing or empty 'context' key"
  elif [ ! -f "$SPECS_DIR/$ctx.md" ]; then
    err "$name: context '$ctx' has no matching spec at docs/specs/$ctx.md"
  else
    echo "  ok: $name (context=$ctx, spec=docs/specs/$ctx.md)"
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "PASS: ${#contracts[@]} contract(s) valid"
  exit 0
fi

echo "FAIL: contract validation errors" >&2
exit 1