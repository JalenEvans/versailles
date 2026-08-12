# Spec: Versailles contract pipeline

**ID:** SPEC-ver
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** public-api (the CLI surface, `.versailles/` file formats, generated test files), data (contracts/manifests/predicates are the tool's data layer)
**Linked contract:** `docs/contracts/versailles.contract.yaml` *(pending — contract-builder)*
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

Versailles turns Design-by-Contract specifications (invariants, preconditions, postconditions) written in a small expression language into deterministic test suites. Contracts are the single source of truth: a validated contract always produces the same tests — no LLM at generation time. LLMs may help *author* contracts from source code, but every LLM output is mechanically validated (parse + semantic) before a human approves it. The `.versailles/` directory is versioned and loaded as a single unit, and every contract clause and generated test traces back to a source hash.

## Scope

**In scope:**
- The `.versailles/` file set (`config.json`, `contracts.json`, `manifests.json`, `predicates.json`) as a versioned, jointly-loaded unit.
- Contract expression grammar: parse, structural constraints, semantic validation, structured error reporting.
- Deterministic test generation: per-operation cases (boundary, partitions, precondition-violation, postcondition-satisfaction) and per-component invariant tests, with traceability comments and a coverage manifest.
- LLM authoring loop: prompt → parse+validate → structured-error retry (capped) → stage for human review.
- CI lint: validation + staleness detection with distinct exit codes.

**Out of scope:**
- SMT-based precise input synthesis (v2 stretch).
- Arbitrary executable code inside contract expressions (no unregistered calls, no loops, no side effects).
- Multi-language grammar variants — grammar/validator/generator stay language-agnostic; only extractor/emitter plug in per language/framework.
- Approval metadata (`approvedBy`/`approvedAt`) in the file schema — the audit trail is git history.

## Behavior

### Deterministic generation

- **Given** a `.versailles/` context where `isValid: true`
- **When** `versailles generate` runs twice on the same context
- **Then** the output under `generated/` is identical (full-file, idempotent regeneration), and no LLM is invoked during generation

### Invalid contracts block the pipeline

- **Given** a contract with a parse or semantic error
- **When** `versailles validate` / `versailles check` / `versailles generate` runs
- **Then** the command fails with structured errors (never an unstructured throw), and generation does not run

### Staleness is detected, and blocking is configurable

- **Given** source changed such that a stored `sourceHash` no longer matches (structural shape only — unrelated body edits don't count)
- **When** `versailles check` runs in CI
- **Then** exit code `2` with a list of stale IDs if `staleness.blockOnStale` is true, else a warning report and exit `0`

### LLM output is validated before a human sees it

- **Given** an LLM-authored contract object in the authoring loop
- **When** it fails parse or semantic validation
- **Then** the structured error is fed back as a correction prompt, retried (capped, e.g. 3), and on persistent failure surfaced to a human — never merged automatically

### Human approval merges one object, not the file

- **Given** a staged, validated contract object in the review flow
- **When** a reviewer approves
- **Then** the single object is merged into `contracts.json` via read-modify-write of just that key — git records the approval; no approval fields exist in the schema

### Traceability is machine-checkable

- **Given** a generated test suite and `generated/coverage.json`
- **When** any contract clause ID is queried
- **Then** it maps to the generated test ID(s) covering it, and a clause with zero generated tests is detectable

### Precondition-violation tests assert rejection per configured idiom

- **Given** an operation with one ore more precondition clauses
- **When** the generator emits violation cases
- **Then** for each clause there is an input satisfying all *other* clauses but falsifying this one, and the test asserts rejection using the configured idiom (`config.json`, default `throws`)

## Constraints

- The expression grammar is boolean-valued only: no assignment, no loops, no statements; anything outside the grammar is a parse error.
- `old(field)` is valid only in `postconditions[]` — a parse error (not semantic) elsewhere.
- Predicate calls resolve only to registered predicates with `verifiedPure: true`; unverified predicates are a hard error.
- Generation is a pure function of approved contracts; regeneration is idempotent and full-file; `generated/` is tool-owned and never hand-edited.
- `contracts.json` changes are single-object merges — never a full-file LLM rewrite.
- `.versailles/` files are never interpreted in isolation; all tools load them as a unit.

## Non-Goals

- SMT-backed precise input synthesis (v2).
- Executable code in contract expressions.
- Grammar variants per programming language.
- In-band approval metadata in the schema.

## Linked Plans

- *(to be filled when the execution plan is created in llama_plans via plan-builder)*

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build spec |
| 2026-08-11 | associate-head-coach | v1 scope pinned by ADR-0009: TS/C#/Python + vitest/xUnit/pytest, TS+vitest first |