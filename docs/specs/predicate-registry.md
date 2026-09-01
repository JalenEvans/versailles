# Spec: Predicate Registry

**ID:** SPEC-pr
**Lifecycle:** implemented
**Owner:** associate-head-coach
**Threshold:** data (predicates are part of the tool's data layer — declared inline in `contracts.json`), public-api (the validator's predicate-verification behavior is user-facing)
**Linked contract:** `docs/contracts/predicate-registry.contract.yaml`
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

The predicate registry owns the declarative predicate declarations in `contracts.json` — the
named functions contract expressions are allowed to call (build-spec §3.4, ADR-0013).
Predicates are declared inline in a top-level `predicates` map, each entry
`{ source, params, paramTypes, returnType }`. The registration CLI (`register-predicate` /
`verify-purity` / `remind-unverified`) and the stored `sourceHash` are removed (ADR-0013).
`validate` mechanically verifies every declaration: predicate name validity
(`INVALID_PREDICATE_NAME` hard error on bad IDENT) and `sourceRef` resolution under
`config.sourceRoots` (resolve-or-warn → `PREDICATE_SOURCE_UNRESOLVED` warning). The
declaration itself is the attestation — no purity gate (ADR-0019). The registry is data for
the rest of the pipeline: workspace-context loads it jointly, and contract-language's
semantic validator hard-errors on any predicate call resolving to a missing entry and
checks arity and argument types — that cross-referencing boundary stays with
contract-language. The tool never invokes an LLM (ADR-0010). `validate --verbose`
additionally emits a reverse-reference index (`verbose.predicateReferences`) so authors can
discover which clauses call each declared predicate — including declared-but-unused ones
(VERSAILLES-168 Phase 5, VERSAILLES-173).

## Scope

**In scope:**
- The top-level `predicates` map in `contracts.json` (build-spec §3.4, ADR-0013): each entry `{ source, params, paramTypes, returnType }` — no purity gate (ADR-0019).
- Validator-time predicate declaration verification (ADR-0013): predicate name validity (IDENT grammar), `sourceRef` resolution under `config.sourceRoots` (resolve-or-warn → `PREDICATE_SOURCE_UNRESOLVED` warning).
- `sourceRef` recording: every entry's `source` field traces to a real function; `validate` resolves it on every run (ADR-0005 "nothing invented" via validate-time resolution).

**Workspace-level scope statement:** predicates are workspace-level (a flat top-level map in
`contracts.json`), so they are shared across every contract in the workspace. Single-use,
grammar-expressible checks (e.g. a one-off `x != ""` guard) belong inline in the expression
grammar, not in the predicate map; named predicates are the shared layer for non-grammar-
expressible logic. The reverse-reference index is what makes that flat shared layer
discoverable to authors.

**Out of scope:**
- Expression parsing, AST construction, and semantic validation of `predicate_call`s — contract-language owns those; this context only stores and maintains the predicate data.
- Predicate-call cross-referencing (existence, arity, arg types) — contract-language's semantic validator, operating on the predicate data this context maintains; no purity gate.
- Joint loading of the `.versailles/` file set — workspace-context owns the loader; predicate data is read through it.
- Manifest derivation from source — manifest-extraction owns that.
- Any LLM involvement — the tool never invokes an LLM (ADR-0010).

## Behavior

### Predicates are declared inline in contracts.json

- **Given** a `contracts.json` with a top-level `predicates` map
- **When** the workspace is loaded
- **Then** each entry is read as a declarative predicate — no separate `predicates.json` file, no registration CLI (ADR-0013)

### validate verifies every predicate declaration

- **Given** a predicate declaration in `contracts.json`
- **When** `versailles validate` runs
- **Then** the validator checks: the predicate name is a valid IDENT (`INVALID_PREDICATE_NAME` hard error otherwise), and the `source` field resolves under `config.sourceRoots` (`PREDICATE_SOURCE_UNRESOLVED` warning if not — resolve-or-warn, not a hard error)

### The declaration is the attestation — no purity gate

- **Given** a predicate declaration in `contracts.json`
- **When** the author declares the predicate with a resolvable `sourceRef`
- **Then** the predicate is referenceable by contracts — no purity metadata, no purity gate, no automated purity or termination analysis (ADR-0019)

### Cross-referencing stays with contract-language

- **Given** a contract expression that calls a predicate
- **When** the semantic validator runs against the full workspace context
- **Then** predicate existence, arity, and arg types are enforced by contract-language (build-spec §5.1) — no purity gate; the predicate registry provides the data, never the validation

### validate --verbose emits the reverse-reference index

- **Given** a workspace whose `contracts.json` declares at least one predicate
- **When** `versailles validate --verbose` runs
- **Then** `output.verbose.predicateReferences` is an array with exactly one entry per declared predicate — `{ predicate, source, clauses, singleUse }` — mapping the predicate's name and declaration `source` to the sorted ids of parsed clauses whose expressions call it (references come from parsed ASTs only; a clause that failed to parse contributes nothing)
- **And** declared-but-unused predicates appear with `clauses: []` and `singleUse: false` — the unused-predicate signal
- **And** entries are sorted by predicate name and clauses by id — deterministic (ADR-0002); no declared predicates yields `[]`
- **And** the index is additive and detail-only: without `--verbose` the output keeps the existing `{ valid: boolean }` shape, and no error shape changes

## Constraints

- `must_not` perform automated purity or termination analysis, or maintain any purity gate on predicate declarations — purity is neither asserted nor checked (ADR-0019).
- `must_not` maintain a stored `sourceHash` for predicates (ADR-0013) — predicate drift is not staleness-checked.
- `must_not` provide a predicate registration CLI (ADR-0013) — predicate registration is part of authoring.
- `must_not` parse or semantically validate contract expressions or predicate calls — that is contract-language, reached through the workspace-context loader.
- `must_not` invoke an LLM anywhere in predicate-registry tooling (ADR-0010).
- `must_not` change the non-verbose output shape or any error/warning shape for the reverse-reference index — it is an additive, detail-only extension of the `--verbose` namespace (VERSAILLES-173).

## Non-Goals

- No automated purity/termination analysis and no purity gate — the declaration is the attestation (ADR-0019).
- No expression grammar, parser, AST, or semantic validator behavior (contract-language).
- No joint workspace loading (workspace-context).
- No manifest extraction from source (manifest-extraction).
- No LLM client, prompt templates, or in-tool LLM invocation (ADR-0010).
- No predicate registration CLI (ADR-0013).
- No stored `sourceHash` for predicates (ADR-0013).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-14 | associate-head-coach | Initial draft from build-spec §3.4, §13 milestone 8, §14; ADR-0003/0006/0010 |
| 2026-08-16 | associate-head-coach | Made the shipped CLI command names concrete (`register-predicate`, `verify-purity`, `remind-unverified`) — milestone 8 tooling is shipped (PR feat/review-ecosystem) |
| 2026-08-20 | head-coach | Lifecycle flipped draft → implemented: context shipped and verified for beta |
| 2026-08-22 | power-forward | Rewritten for declarative predicates (ADR-0013): predicates declared inline in contracts.json; registration CLI removed; sourceHash dropped; validate verifies declarations (resolve-or-warn, name validity, purity gate) |
| 2026-08-30 | general-manager | Reconcile with ADR-0018 (VERSAILLES-168 Phase 2/3 follow-up): predicates are part of the tool's data layer — dropped the stale "versioned" qualifier |
| 2026-08-30 | general-manager | Reverse-reference discoverability index (VERSAILLES-168 Phase 5, VERSAILLES-173): validate --verbose emits verbose.predicateReferences — one entry per declared predicate (unused included, clauses: []), entries/clauses sorted, singleUse = clauses.length === 1, deterministic (ADR-0002), additive/detail-only; added the workspace-level scope statement |
| 2026-08-31 | associate-head-coach | Drop the purity gate (ADR-0019): predicate declaration schema is { source, params, paramTypes, returnType }; purity metadata and the gate are removed; the declaration (existence + shape + resolvable sourceRef) is the attestation |
