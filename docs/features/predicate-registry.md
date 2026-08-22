# Feature: Predicate Declarations

**Verified by:** `versailles validate` (declarative predicate verification, ADR-0013)

**Primary context:** [predicate-registry](../domains/predicate-registry.md) (+ workspace-context, contract-language)
**Vocabulary:** [glossary](../glossary.md) — *predicate, verifiedPure, sourceRef, declarative predicate*

## Overview

Predicates are declared inline in `contracts.json` as a top-level `predicates` map (ADR-0013).
Each entry declares the predicate's source reference, parameter shape, and purity judgment.
`validate` mechanically verifies every declaration: predicate name validity, `sourceRef`
resolution under `config.sourceRoots` (resolve-or-warn), and the `verifiedPure` gate (ADR-0006
preserved). The registration CLI (`register-predicate` / `verify-purity` / `remind-unverified`)
and the stored `sourceHash` are removed (ADR-0013).

## User story

> As a contract author, I want to declare callable predicates inline in `contracts.json` with
> proof they trace to real source and a manual purity gate, so contract expressions never call
> hallucinated or impure functions — with the declaration sitting next to the contracts that
> use it, verified in one gate (`validate`).

## Flow

1. **Declare** — author adds a predicate entry to the top-level `predicates` map of
   `contracts.json`: `{ "source": "<Module.functionName>", "params": [...], "paramTypes": [...],
   "returnType": "boolean", "verifiedPure": true }`.
2. **Verify** — `versailles validate` mechanically verifies every declaration:
   - the predicate name must match the `predicate_call` IDENT grammar;
   - the `source` field is resolved under `config.sourceRoots` (resolve-or-warn →
     `PREDICATE_SOURCE_UNRESOLVED` warning if unresolvable);
   - `verifiedPure` is a human-set boolean — the validator hard-errors on any contract
     reference to a predicate with `verifiedPure` missing or false (ADR-0006).
3. **Enforce** — contract-language's semantic validator hard-errors on any predicate call
   resolving to a missing or unverified entry (build-spec §5.1); the registry only provides
   the data.

## Domain events

- `predicateDeclarationVerified` — a predicate declaration was verified by `validate`.

## Business rules

- `verifiedPure` is human-only — never automated purity/termination analysis (ADR-0006, build-spec §14 default).
- Every entry's `source` field is resolved by `validate` under `config.sourceRoots`; unresolvable sources produce a `PREDICATE_SOURCE_UNRESOLVED` warning (ADR-0005, ADR-0013).
- Predicate declarations are authored inline in `contracts.json` — no separate `predicates.json` file, no registration CLI (ADR-0013).
- No stored `sourceHash` is maintained for predicates (ADR-0013).

## Edge cases

- **Invalid predicate name** → structured `INVALID_PREDICATE_NAME` hard error before any validation.
- **Unresolvable `source`** → structured `PREDICATE_SOURCE_UNRESOLVED` warning (non-blocking).
- **Contract references an undeclared predicate** → hard validation error (ADR-0006).
- **Contract references a predicate with `verifiedPure` missing or false** → hard validation error (ADR-0006).

## Source of authority

[build-spec §3.4, §13 milestone 8, §14](../build-spec.md) · [ADR-0003](../decisions/0003-git-history-as-audit-trail.md) · [ADR-0006](../decisions/0006-predicate-purity-registration-gate.md) · [ADR-0013](../decisions/0013-declarative-predicates-remove-registration-cli.md) · [Domain: Predicate Registry](../domains/predicate-registry.md) · [Spec: Predicate Registry](../specs/predicate-registry.md)
