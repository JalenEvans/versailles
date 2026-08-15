# Spec: Predicate Registry

**ID:** SPEC-pr
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** data (predicates.json is part of the tool's versioned data layer; registration mutates it), public-api (the registration CLI surface and the purity-check reminder are agent- and reviewer-facing)
**Linked contract:** `docs/contracts/predicate-registry.contract.yaml`
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

The predicate registry owns `predicates.json` — the named, registered, verified-pure functions
contract expressions are allowed to call (build-spec §3.4). Build-spec §13 milestone 8 adds the
tooling around this data file: a registration CLI that adds or updates exactly one predicate
entry per invocation, and a purity-check reminder workflow that surfaces unverified predicates
to reviewers. Purity is enforced at registration time only, per the build-spec §14 default and
ADR-0006: `verifiedPure` is asserted **manually** via lint/manual review — the tool never
performs automated purity or termination analysis. Every entry traces to a real function via
`sourceRef` and a mechanically verified `sourceHash`. The registry is data for the rest of the
pipeline: workspace-context loads it jointly, and contract-language's semantic validator
hard-errors on any predicate call resolving to a missing or unverified entry — that
cross-referencing boundary stays with contract-language. The tool never invokes an LLM
(ADR-0010).

## Scope

**In scope:**
- The `predicates.json` registry file (build-spec §3.4): `version` plus a `predicates` map, each entry `{ params, paramTypes, returnType, sourceRef, sourceHash, verifiedPure }`.
- The registration CLI behavior (build-spec §13 milestone 8, e.g. `versailles register-predicate`): adds or updates exactly one entry per invocation, keyed by predicate name.
- The registration-time purity gate: `verifiedPure` is manually asserted via lint/manual review at registration (build-spec §14 default, ADR-0006); the post-lint `verify_purity` path flips it to true after the purity-check reminder surfaces the predicate.
- The purity-check reminder workflow: surfaces every predicate with `verifiedPure` missing or false to reviewers, so `verifiedPure` can be set after manual lint (build-spec §13 milestone 8).
- `sourceRef` / `sourceHash` recording: every entry is mechanically verified against actual source before writing.
- Single-entry read-modify-write persistence of `predicates.json`, recorded in git — the audit trail for registrations (ADR-0003).

**Out of scope:**
- Expression parsing, AST construction, and semantic validation of `predicate_call`s — contract-language owns those; this context only stores and maintains the registry data.
- The hard cross-referencing check (a referenced predicate must exist with `verifiedPure === true`) — contract-language's semantic validator, operating on the registry data this context maintains.
- Joint loading of the `.versailles/` file set — workspace-context owns the loader; registry tooling reads through it.
- The review approval/reject/merge flow — review owns that; the purity reminder may surface through review's presentation only.
- Manifest derivation from source — manifest-extraction owns that.
- Any LLM involvement — the tool never invokes an LLM (ADR-0010).

## Behavior

### Registration adds or updates exactly one entry

- **Given** a predicate name and a schema-conformant entry whose `sourceRef` resolves and whose `sourceHash` matches the current function implementation
- **When** `register_predicate` runs
- **Then** `predicates.json` gains or updates exactly the entry keyed by that name — a single-entry read-modify-write, never a full-file rewrite (ADR-0003) — and `verifiedPure` is persisted exactly as the human asserted it at registration

### verifiedPure is set by a human, never by the tool

- **Given** a predicate being registered, or an unverified predicate surfaced by the purity-check reminder
- **When** the registration-time lint/review gate (or the post-lint `verify_purity` path) runs
- **Then** `verifiedPure` becomes true only through that human decision — no automated purity or termination analysis runs anywhere in the tool (ADR-0006, build-spec §14 default)

### The purity-check reminder surfaces unverified predicates

- **Given** a loaded workspace context where some predicates have `verifiedPure` missing or false
- **When** the purity-check reminder runs
- **Then** it reports exactly those entries (with their `sourceRef`) for reviewers to lint — and it never writes `verifiedPure` itself

### Entries trace to real source

- **Given** a registration request with a `sourceRef` / `sourceHash` pair
- **When** the registration executes
- **Then** the sourceRef is verified to resolve to a real function under `config.sourceRoots` and the sourceHash is verified against the current function implementation before anything is written

### Cross-referencing stays with contract-language

- **Given** a contract expression that calls a predicate
- **When** the semantic validator runs against the full workspace context
- **Then** predicate existence, arity, arg types, and `verifiedPure === true` are enforced by contract-language (build-spec §5.1) — the predicate registry provides the data, never the validation

## Constraints

- `must_not` perform automated purity or termination analysis — the `verifiedPure` flag is a manual registration-time gate (ADR-0006, build-spec §14 default).
- `must_not` default `verifiedPure` to true, or set it true without a human's manual lint/review through the registration gate or `verify_purity`.
- `must_not` rewrite `predicates.json` wholesale — writes are single-entry read-modify-writes.
- `must_not` remove a predicate entry as a side effect of registering or verifying another entry.
- `must_not` write an entry whose `sourceRef` / `sourceHash` are not mechanically verified against actual source.
- `must_not` parse or semantically validate contract expressions or predicate calls — that is contract-language, reached through the workspace-context loader.
- `must_not` implement the review approval/reject flow — the purity reminder only surfaces information.
- `must_not` invoke an LLM anywhere in the registry tooling (ADR-0010).

## Non-Goals

- No automated purity/termination analysis (ADR-0006, build-spec §14 default).
- No expression grammar, parser, AST, or semantic validator behavior (contract-language).
- No joint workspace loading (workspace-context).
- No review approval/reject/merge (review).
- No manifest extraction from source (manifest-extraction).
- No LLM client, prompt templates, or in-tool LLM invocation (ADR-0010).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-14 | associate-head-coach | Initial draft from build-spec §3.4, §13 milestone 8, §14; ADR-0003/0006/0010 |