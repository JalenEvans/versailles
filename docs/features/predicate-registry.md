# Feature: Predicate Declarations

**Verified by:** `versailles validate` (declarative predicate verification, ADR-0013)

**Primary context:** [predicate-registry](../domains/predicate-registry.md) (+ workspace-context, contract-language)
**Vocabulary:** [glossary](../glossary.md) — *predicate, sourceRef, declarative predicate*

## Overview

Predicates are declared inline in `contracts.json` as a top-level `predicates` map (ADR-0013).
Each entry declares the predicate's source reference and parameter shape. `validate`
mechanically verifies every declaration: predicate name validity and `sourceRef` resolution
under `config.sourceRoots` (resolve-or-warn). The declaration itself is the attestation — no
purity gate (ADR-0019). The registration CLI (`register-predicate` / `verify-purity` /
`remind-unverified`) and the stored `sourceHash` are removed (ADR-0013).

## User story

> As a contract author, I want to declare callable predicates inline in `contracts.json` with
> proof they trace to real source, so contract expressions never call hallucinated functions —
> with the declaration sitting next to the contracts that use it, verified in one gate
> (`validate`). Purity needs no separate ceremony: an impure or non-terminating predicate
> surfaces as a failing or hanging generated test on the first suite run.

## Flow

1. **Declare** — author adds a predicate entry to the top-level `predicates` map of
   `contracts.json`: `{ "source": "<Module.functionName>", "params": [...], "paramTypes": [...],
   "returnType": "boolean" }`.
2. **Verify** — `versailles validate` mechanically verifies every declaration:
   - the predicate name must match the `predicate_call` IDENT grammar;
   - the `source` field is resolved under `config.sourceRoots` (resolve-or-warn →
     `PREDICATE_SOURCE_UNRESOLVED` warning if unresolvable).
3. **Enforce** — contract-language's semantic validator hard-errors on any predicate call
   resolving to a missing entry and checks arity and argument types (build-spec §5.1); the
   registry only provides the data.

## Discoverability: reverse-reference index (`validate --verbose`)

Because predicates live in a flat top-level `predicates` map, the cost of a new predicate is
low but the visibility cost is real: nothing in the map says which clauses use a predicate,
and nothing flags a declaration that nothing uses. `versailles validate --verbose` answers
both with `verbose.predicateReferences` — a reverse-reference index (VERSAILLES-173).

**What authors see** — one entry per *declared* predicate:

```json
{
  "predicate": "isPositive",
  "source": "Math.isPositive",
  "clauses": ["OrderService.addItem.pre1", "OrderService.addItem.post0"],
  "singleUse": false
}
```

- `clauses` — the sorted ids of parsed clauses whose expressions call the predicate.
- `singleUse` — exactly `clauses.length === 1`: a true signal that the predicate is
  either a deliberate shared-layer abstraction or a candidate to inline back into the
  expression grammar.

**How it helps** — authors can see the full reach of the flat predicate map in one pass:
which contracts depend on a predicate, whether a predicate is shared or single-use, and
whether a declaration is dead weight.

**The unused-predicate signal** — every declared predicate appears, *including*
declared-but-unused ones, pinned as `clauses: []` / `singleUse: false`. An unused
declaration is never hidden; it is the author's cue to use it or remove it.

**Determinism** — entries sorted by predicate name, clauses by clause id; a predicate
referenced by no parsed clause (or whose referencing clause failed to parse) contributes
nothing. Same workspace, same index, run to run (ADR-0002).

## Domain events

- `predicateDeclarationVerified` — a predicate declaration was verified by `validate`.

## Business rules

- No purity gate — the declaration (existence + shape + resolvable `sourceRef`) is the attestation; purity is neither asserted nor analyzed (ADR-0019).
- Every entry's `source` field is resolved by `validate` under `config.sourceRoots`; unresolvable sources produce a `PREDICATE_SOURCE_UNRESOLVED` warning (ADR-0005, ADR-0013).
- Predicate declarations are authored inline in `contracts.json` — no separate `predicates.json` file, no registration CLI (ADR-0013).
- No stored `sourceHash` is maintained for predicates (ADR-0013).
- Every declared predicate is discoverable: `validate --verbose` emits `verbose.predicateReferences` — one deterministic entry per declared predicate (unused ones included, `clauses: []`), entries sorted by predicate name, clauses by id, `singleUse` exactly `clauses.length === 1` (ADR-0002, VERSAILLES-173).

## Edge cases

- **Invalid predicate name** → structured `INVALID_PREDICATE_NAME` hard error before any validation.
- **Unresolvable `source`** → structured `PREDICATE_SOURCE_UNRESOLVED` warning (non-blocking).
- **Contract references an undeclared predicate** → hard validation error (UNKNOWN_PREDICATE).
- **Contract references a declared predicate with wrong arity or argument types** → hard validation error.
- **Declared-but-unused predicate** → still appears in `verbose.predicateReferences` with `clauses: []` and `singleUse: false` — the unused-predicate signal (VERSAILLES-173).
- **No declared predicates** → `verbose.predicateReferences` is `[]` under `--verbose`; without `--verbose`, no `verbose` key at all.

## Source of authority

[build-spec §3.4, §13 milestone 8, §14](../build-spec.md) · [ADR-0002](../decisions/0002-deterministic-generation-llm-authoring-only.md) · [ADR-0003](../decisions/0003-git-history-as-audit-trail.md) · [ADR-0013](../decisions/0013-declarative-predicates-remove-registration-cli.md) · [ADR-0019](../decisions/0019-drop-verified-pure-field.md) · [Domain: Predicate Registry](../domains/predicate-registry.md) · [Spec: Predicate Registry](../specs/predicate-registry.md)
