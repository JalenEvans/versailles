# Domain: Predicate Registry

**Bounded context:** `predicate-registry`

## Responsibility (what this context owns)

The declarative predicate declarations in `contracts.json` — the data that contract expressions
are allowed to call (build-spec §3.4, ADR-0013):

- The top-level `predicates` map in `contracts.json`: each entry `{ source, params, paramTypes, returnType }` — no purity gate (ADR-0019).
- Validator-time **predicate declaration verification** (ADR-0013): predicate name validity (IDENT grammar → `INVALID_PREDICATE_NAME` hard error), `sourceRef` resolution under `config.sourceRoots` (resolve-or-warn → `PREDICATE_SOURCE_UNRESOLVED` warning).
- **No purity gate** (ADR-0019): predicate declarations carry no purity metadata — the declaration (existence + shape + resolvable `sourceRef`) is the attestation.
- `sourceRef` recording: every entry's `source` field traces to a real function; `validate` resolves it on every run (ADR-0005 "nothing invented" via validate-time resolution).
- **No stored `sourceHash`** (ADR-0013) — predicate drift is not staleness-checked.
- **No registration CLI** (ADR-0013) — predicate registration is part of authoring.

## Domain model

**PredicateEntry** (entity) — one top-level `predicates` map entry: `source`, `params`, `paramTypes`, `returnType`.

**PredicateMap** (aggregate root) — the top-level `predicates` map in `contracts.json`: keyed by predicate name.

**DeclarationAttestation** (concept) — the author's declaration itself is the attestation: a predicate cannot be referenced without being deliberately declared with a `sourceRef` that `validate` resolves against real source (ADR-0019).

**DeclarationVerification** (process) — validate-time verification of every predicate declaration: name validity (IDENT), `sourceRef` resolution (resolve-or-warn).

**PredicateReferenceIndex** (artifact) — the reverse-reference index emitted under `validate --verbose` (`verbose.predicateReferences`): one entry per declared predicate mapping it to the sorted clause ids whose expressions call it, with `singleUse`; entries sorted by predicate name — deterministic (ADR-0002, VERSAILLES-173).

## Ubiquitous language

Uses from [glossary](../glossary.md): *predicate, sourceRef, declarative predicate, audit trail*. "The map of callable functions" is the *predicate map*; "declaring a predicate" is *authoring its entry in contracts.json*; "verifying a declaration" is *validate-time resolution*.

## Domain events

- `predicateDeclarationVerified` — a predicate declaration was verified by `validate` (name valid, `sourceRef` resolved or warned).

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | The predicates map is loaded only as part of the joint workspace unit; predicate data is read through the shared loader. |
| Upstream of | contract-language | The semantic validator cross-references the predicates map (existence, arity, arg types) — no purity gate; the registry provides the data, never the validation. |
| Upstream of | (CLI) | `validate` is the single gate that verifies predicate declarations (ADR-0013) and, under `--verbose`, emits the reverse-reference index for author discoverability (VERSAILLES-173). |

## Business rules

- Predicate declarations carry **no purity metadata** — no purity analysis, no gate; the declaration is the attestation (ADR-0019).
- Every entry's `source` field is resolved by `validate` under `config.sourceRoots`; an unresolvable `source` produces a `PREDICATE_SOURCE_UNRESOLVED` warning (ADR-0005, ADR-0013).
- Predicate declarations are authored inline in `contracts.json` — no separate `predicates.json` file, no registration CLI (ADR-0013).
- The context never parses or semantically validates contract expressions — that is contract-language, reached through the workspace-context loader.
- Every declared predicate is discoverable: `validate --verbose` emits the reverse-reference index (`verbose.predicateReferences`) — one deterministic entry per declared predicate, unused predicates included with `clauses: []`, entries sorted by predicate name and clauses by id, `singleUse` exactly `clauses.length === 1` (ADR-0002, VERSAILLES-173).

## Open questions

- Retention or cleanup policy for obsolete predicate entries — not specified; decide with the registry's usage over time.

## Source of authority

[build-spec.md §3.4, §13 milestone 8, §14](../build-spec.md) · [ADR-0003 git history as audit trail](../decisions/0003-git-history-as-audit-trail.md) · [ADR-0013 declarative predicates](../decisions/0013-declarative-predicates-remove-registration-cli.md) · [ADR-0019 no purity gate](../decisions/0019-drop-verified-pure-field.md) · [Spec: Predicate Registry](../specs/predicate-registry.md) · [Contract: predicate-registry](../contracts/predicate-registry.contract.yaml)
