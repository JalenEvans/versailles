# Domain: Predicate Registry

**Bounded context:** `predicate-registry`

## Responsibility (what this context owns)

The declarative predicate declarations in `contracts.json` — the data that contract expressions
are allowed to call (build-spec §3.4, ADR-0013):

- The top-level `predicates` map in `contracts.json`: each entry `{ source, params, paramTypes, returnType, verifiedPure }`.
- Validator-time **predicate declaration verification** (ADR-0013): predicate name validity (IDENT grammar → `INVALID_PREDICATE_NAME` hard error), `sourceRef` resolution under `config.sourceRoots` (resolve-or-warn → `PREDICATE_SOURCE_UNRESOLVED` warning).
- The **`verifiedPure` gate** (ADR-0006, build-spec §14 default): `verifiedPure` is a human-set boolean — the validator hard-errors on any contract reference to a predicate with `verifiedPure` missing or false.
- `sourceRef` recording: every entry's `source` field traces to a real function; `validate` resolves it on every run (ADR-0005 "nothing invented" via validate-time resolution).
- **No stored `sourceHash`** (ADR-0013) — predicate drift is not staleness-checked.
- **No registration CLI** (ADR-0013) — predicate registration is part of authoring.

## Domain model

**PredicateEntry** (entity) — one top-level `predicates` map entry: `source`, `params`, `paramTypes`, `returnType`, `verifiedPure`.

**PredicateMap** (aggregate root) — the top-level `predicates` map in `contracts.json`: keyed by predicate name.

**PurityGate** (concept) — the manual, human lint/review that sets `verifiedPure` as data; the tool never analyzes purity.

**DeclarationVerification** (process) — validate-time verification of every predicate declaration: name validity (IDENT), `sourceRef` resolution (resolve-or-warn).

## Ubiquitous language

Uses from [glossary](../glossary.md): *predicate, verifiedPure, sourceRef, declarative predicate, audit trail*. "The map of callable functions" is the *predicate map*; "marking pure" is *setting verifiedPure as data*; "verifying a declaration" is *validate-time resolution*.

## Domain events

- `predicateDeclarationVerified` — a predicate declaration was verified by `validate` (name valid, `sourceRef` resolved or warned).

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | The predicates map is loaded only as part of the joint workspace unit; predicate data is read through the shared loader. |
| Upstream of | contract-language | The semantic validator cross-references the predicates map (existence, arity, arg types, `verifiedPure === true`) — the registry provides the data, never the validation. |
| Upstream of | (CLI) | `validate` is the single gate that verifies predicate declarations (ADR-0013). |

## Business rules

- `verifiedPure` is a **human-only** flag: set by the author as data in `contracts.json` — never by automated analysis (ADR-0006).
- Every entry's `source` field is resolved by `validate` under `config.sourceRoots`; an unresolvable `source` produces a `PREDICATE_SOURCE_UNRESOLVED` warning (ADR-0005, ADR-0013).
- Predicate declarations are authored inline in `contracts.json` — no separate `predicates.json` file, no registration CLI (ADR-0013).
- The context never parses or semantically validates contract expressions — that is contract-language, reached through the workspace-context loader.

## Open questions

- Retention or cleanup policy for obsolete predicate entries — not specified; decide with the registry's usage over time.

## Source of authority

[build-spec.md §3.4, §13 milestone 8, §14](../build-spec.md) · [ADR-0003 git history as audit trail](../decisions/0003-git-history-as-audit-trail.md) · [ADR-0006 predicate purity gate](../decisions/0006-predicate-purity-registration-gate.md) · [ADR-0013 declarative predicates](../decisions/0013-declarative-predicates-remove-registration-cli.md) · [Spec: Predicate Registry](../specs/predicate-registry.md) · [Contract: predicate-registry](../contracts/predicate-registry.contract.yaml)
