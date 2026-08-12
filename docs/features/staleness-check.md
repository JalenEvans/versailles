# Feature: Staleness Check (CI Lint)

**Command:** `versailles check`
**Primary context:** [workspace-context](../domains/workspace-context.md) (+ contract-language, manifest-extraction)
**Vocabulary:** [glossary](../glossary.md) — *sourceHash, stale, rejected command, exit code, structured error*

## Overview

The CI-mode command that fails when the workspace has drifted from source. After validation, it **recomputes every stored `sourceHash`** — manifest entries (sorted field name+type pairs), predicates (function implementation), and contract operations (signature + docstring) — and compares against the stored hashes. Staleness is about **structural shape only**; unrelated edits to method bodies do not count.

## User story

> As a CI pipeline, I want `versailles check` to fail loudly when contracts or manifests no longer match the source they were derived from, so drift is caught before merge.

## Flow

1. Load the workspace via the [workspace-context](../domains/workspace-context.md) loader.
2. Fail if `parseErrors` or `validationErrors` are non-empty (exit `1`).
3. Recompute `sourceHash` for every manifest entry, predicate, and contract operation from current source; compare against stored hashes.
4. On mismatch:
   - `config.staleness.blockOnStale === true` → hard fail with the list of stale IDs (exit `2`);
   - otherwise → emit a warning report (e.g. CI annotation) and exit `0`.

## Domain events

- `stalenessDetected` — for each drifted ID (blocking behavior follows config).

## Business rules

- Validation errors always precede staleness reporting — a contract that does not parse cannot be meaningfully staleness-checked.
- `sourceHash` covers structural shape only; body-only edits must not trigger false staleness (ADR-0005, build-spec §7).
- Exit codes are distinct and documented: `0` clean, `1` parse/validation error, `2` staleness violation (when blocking) (build-spec §8).

## Edge cases

- **`blockOnStale: false`** → warning report, exit `0`; CI can still branch on the annotation.
- **Component removed from source without `--prune`** → manifest entry preserved (extraction never prunes implicitly); a check against the pruned source would surface it as staleness until a deliberate re-extract.

## Source of authority

[build-spec §8](../build-spec.md) · [ADR-0005](../decisions/0005-static-analysis-first-manifest-extraction.md) · [Spec §8](../specs/versailles.md)