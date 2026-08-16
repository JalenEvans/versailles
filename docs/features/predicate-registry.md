# Feature: Predicate Registry Tooling

**Commands:**
- `versailles register-predicate <name> --source <Module.functionName> [--params <csv>] [--paramTypes <csv>] [--sourceHash <hash>] [--verifiedPure]`
- `versailles verify-purity <name>`
- `versailles remind-unverified`

**Primary context:** [predicate-registry](../domains/predicate-registry.md) (+ workspace-context, contract-language)
**Vocabulary:** [glossary](../glossary.md) — *predicate, verifiedPure, sourceHash*

## Overview

The tooling around `predicates.json` — the named, verified-pure functions contract expressions are allowed to call. Registration adds or updates **exactly one** entry per invocation with a mechanically verified `sourceRef`/`sourceHash`; purity (`verifiedPure`) is a **human-only** gate set at registration or after a manual lint; the reminder surfaces unverified predicates to reviewers without ever writing.

## User story

> As a reviewer, I want to register callable predicates with proof they trace to real source and a manual purity gate, so contract expressions never call hallucinated or impure functions.

## Flow

1. **Register** — `versailles register-predicate <name> --source <Module.functionName>`:
   - the predicate name must match the `predicate_call` IDENT grammar;
   - `sourceRef` is resolved under `config.sourceRoots` and `sourceHash` is computed against the current function implementation (a provided `--sourceHash` must match — nothing invented);
   - the entry is written as a **single-entry read-modify-write** of `predicates.json`; `verifiedPure` is `false` unless the human passed `--verifiedPure` at registration.
2. **Lint & verify** — after a human lints the function source, `versailles verify-purity <name>` flips `verifiedPure` true; `sourceRef`/`sourceHash` are never recomputed or rewritten.
3. **Remind** — `versailles remind-unverified` reports exactly the entries with `verifiedPure` missing/false (with their `sourceRef`); it never writes.
4. **Enforce** — contract-language's semantic validator hard-errors on any predicate call resolving to a missing or unverified entry (build-spec §5.1); the registry only provides the data.

## Domain events

- `predicateRegistered` — a named predicate entered `predicates.json` with `verifiedPure` set at registration-time purity review.

## Business rules

- `verifiedPure` is human-only — never automated purity/termination analysis (ADR-0006, build-spec §14 default).
- Every entry's `sourceRef`/`sourceHash` is mechanically verified against real source before writing.
- Writes are single-entry read-modify-writes — never a full-file rewrite; git records each change (ADR-0003).
- No entry is removed as a side effect of registering or verifying another.

## Edge cases

- **Invalid predicate name** → structured `INVALID_PREDICATE_NAME` error before any read/write; nothing written.
- **Unresolvable `sourceRef`** → structured `SOURCE_REF_UNRESOLVED` error; nothing written.
- **`--sourceHash` mismatch** → structured `SOURCE_HASH_MISMATCH` error; nothing written.
- **`verify-purity` on a missing/non-conforming entry** → structured `NOT_FOUND`/`INVALID_ENTRY` error; `predicates.json` stays byte-identical (no degenerate write).

## Source of authority

[build-spec §3.4, §13 milestone 8, §14](../build-spec.md) · [ADR-0003](../decisions/0003-git-history-as-audit-trail.md) · [ADR-0006](../decisions/0006-predicate-purity-registration-gate.md) · [Domain: Predicate Registry](../domains/predicate-registry.md) · [Spec: Predicate Registry](../specs/predicate-registry.md)