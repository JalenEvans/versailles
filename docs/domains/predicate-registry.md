# Domain: Predicate Registry

**Bounded context:** `predicate-registry`

## Responsibility (what this context owns)

The named predicate registry and the tooling around it — the data that contract expressions are allowed to call (build-spec §3.4):

- The `predicates.json` registry file: `version` plus a `predicates` map, each entry `{ params, paramTypes, returnType, sourceRef, sourceHash, verifiedPure }`.
- The registration CLI (`versailles register-predicate`): adds or updates **exactly one** entry per invocation, keyed by predicate name (build-spec §13 milestone 8).
- The registration-time **purity gate**: `verifiedPure` is asserted manually via lint/manual review — never by automated purity or termination analysis (ADR-0006, build-spec §14 default).
- The post-lint purity flip (`versailles verify-purity`): turns `verifiedPure` true after a human's lint, without recomputing `sourceRef`/`sourceHash`.
- The purity-check reminder (`versailles remind-unverified`): surfaces every predicate with `verifiedPure` missing/false (with its `sourceRef`) to reviewers — it never writes.
- `sourceRef`/`sourceHash` recording: every entry is mechanically verified against real source before anything is written (nothing invented — ADR-0005 discipline applied to predicates).
- Single-entry read-modify-write persistence of `predicates.json`, recorded in git — the audit trail for registrations (ADR-0003).

## Domain model

**PredicateEntry** (entity) — one `predicates.json` entry: `params`, `paramTypes`, `returnType`, `sourceRef`, `sourceHash`, `verifiedPure`.

**PredicateRegistry** (aggregate root) — the `predicates.json` file: `version` + the `predicates` map keyed by predicate name.

**PurityGate** (concept) — the manual, registration-time lint/review that sets `verifiedPure`; the tool never analyzes purity.

**Registration** (process) — a single-entry read-modify-write of one predicate key, mechanically verified against source first (ADR-0003).

## Ubiquitous language

Uses from [glossary](../glossary.md): *predicate, verifiedPure, sourceHash, sourceRef, staged contract, audit trail*. "The whitelist of callable functions" is the *predicate registry*; "marking pure" is *verifying purity (verify-purity)*; "flagging unverified functions" is the *purity-check reminder (remind-unverified)*.

## Domain events

- `predicateRegistered` — a named predicate was added to `predicates.json` with `verifiedPure` set at registration-time purity review.

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | `predicates.json` is loaded only as part of the joint workspace unit; registry tooling reads through the shared loader. |
| Upstream of | contract-language | The semantic validator cross-references `predicates.json` (existence, arity, arg types, `verifiedPure === true`) — the registry provides the data, never the validation. |
| Upstream of | workspace-context | Staleness check consumes the stored predicate `sourceHash`; this context only records it at registration. |
| Upstream of | (CLI) | `versailles register-predicate` / `verify-purity` / `remind-unverified` are the command surface. |
| Adjacent to | review | The purity reminder may surface through review's presentation; approval/reject stays with review. |

## Business rules

- `verifiedPure` is a **human-only** flag: set at registration (`--verifiedPure`) or by `verify-purity` after manual lint — never by automated analysis (ADR-0006).
- Every entry traces to a real function: `sourceRef` resolves under `config.sourceRoots` and `sourceHash` matches the current implementation before writing.
- Writes are **single-entry read-modify-writes** — never a full-file rewrite; git history records each registration and verification (ADR-0003).
- Registration never removes or rewrites another predicate entry as a side effect.
- The context never parses or semantically validates contract expressions — that is contract-language, reached through the workspace-context loader.

## Open questions

- Retention or cleanup policy for obsolete predicate entries — not specified; decide with the registry's usage over time.

## Source of authority

[build-spec.md §3.4, §13 milestone 8, §14](../build-spec.md) · [ADR-0003 git history as audit trail](../decisions/0003-git-history-as-audit-trail.md) · [ADR-0006 predicate purity gate](../decisions/0006-predicate-purity-registration-gate.md) · [Spec: Predicate Registry](../specs/predicate-registry.md) · [Contract: predicate-registry](../contracts/predicate-registry.contract.yaml)