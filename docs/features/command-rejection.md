# Feature: Rejected-Command Output

**Scope:** any `versailles` command on a context that cannot be processed
**Primary context:** cross-cutting (CLI + workspace-context, contract-language, manifest-extraction)
**Vocabulary:** [glossary](../glossary.md) — *rejected command, structured error, exit code, version gate, sourceHash*

## Overview

A **rejected command** is a first-class, deterministic outcome — not a crash. When the workspace is invalid (parse or validation errors), stale while blocking, or version-mismatched, the command exits with structured results and a distinct exit code. There is **no silent partial run, no unstructured throw** anywhere in the pipeline.

## What rejection looks like

| Condition | Command examples | Result | Exit code |
|---|---|---|---|
| Parse error (e.g. `old(...)` in an invariant, `=` instead of `==`) | `validate`, `check`, `generate` | Structured parse errors; processing stops | `1` |
| Semantic validation error (unknown field, type mismatch, unverified predicate) | `validate`, `check`, `generate` | Structured validation errors (`{ contractId, code, field, detail }`); processing stops | `1` |
| Staleness while `config.staleness.blockOnStale: true` | `check` | List of stale IDs; processing stops | `2` |
| Staleness while non-blocking | `check` | Warning report (CI annotation), continues | `0` |
| Grammar/schema version mismatch | all commands | Hard error with upgrade-path message | `1` (distinct message) |

A canonical **parse error** shape (build-spec §4.4):

```json
{
  "contractId": "OrderService.placeOrder.post0",
  "field": "postconditions[0]",
  "position": 20,
  "found": "=",
  "expected": ["=="],
  "message": "Unexpected token '=' at position 20 — did you mean '=='?"
}
```

A canonical **semantic error** shape (build-spec §5.2):

```json
{
  "contractId": "...",
  "code": "UNKNOWN_FIELD",
  "field": "postconditions[0]",
  "detail": "..."
}
```

## User story

> As a CI pipeline or LLM feedback loop, I want every failure to arrive as a machine-readable structured result with a distinct exit code, so I can render it, re-inject it, or branch on it programmatically.

## Flow

1. Load the workspace; the **version gate** fires first (mismatch = hard error with upgrade message, never a silent best-effort parse).
2. Parse all exprs; collect structured parse errors (parser never throws unstructured).
3. Run semantic validation; collect structured errors/warnings.
4. If `parseErrors`/`validationErrors` are non-empty → reject with exit `1` (or the command-specific code), surfacing the full structured report.
5. For `check`, additionally recompute `sourceHash` values and reject with exit `2` when blocking.
6. Exit `0` only on a fully clean, non-blocked run.

## Business rules

- Every parse/validation failure is a **structured object**, never a string and never a throw (build-spec §4.4, §5.2).
- Distinct exit codes (`0` / `1` / `2`) let CI branch behavior (build-spec §8).
- Version mismatch is a hard error with an upgrade-path message, not a silent degraded parse (build-spec §3.1).
- Generation and review only proceed from valid, non-stale contexts.

## Edge cases

- **Warnings present, errors absent** → not a rejection; warnings are non-blocking and surfaced (e.g. low-confidence fields, build-spec §5.1).
- **Multiple errors in one run** → all structured errors returned (the report is a list), so the LLM correction prompt and CI get the full picture in one pass.

## Source of authority

[build-spec §3.1, §4.4, §5.2, §8, §12](../build-spec.md) · [Spec: Invalid contracts block the pipeline](../specs/versailles.md)