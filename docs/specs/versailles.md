# Spec: Versailles contract pipeline

**ID:** SPEC-ver
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** public-api (the CLI surface, `.versailles/` file formats, generated test files), data (contracts/manifests/predicates are the tool's data layer)
**Linked contract:** `docs/contracts/versailles.contract.yaml`

---

## Behavioral Intent

Versailles turns Design-by-Contract specifications (invariants, preconditions, postconditions) written in a small expression language into deterministic test suites. Contracts are the single source of truth: a validated contract always produces the same tests. LLMs (as external agents) may drive the CLI to author contracts from source, but the CLI never drives an LLM — no LLM is invoked by the tool at any point. The CLI exposes a deterministic, machine-readable surface (structured errors, stable JSON output, stable exit codes) that an external LLM/agent can consume and iterate against. The `.versailles/` directory is versioned and loaded as a single unit, and every contract clause and generated test traces back to a source hash.

## Scope

**In scope:**
- The `.versailles/` file set (`config.json`, `contracts.json`, `manifests.json`, `predicates.json`) as a versioned, jointly-loaded unit.
- Contract expression grammar: parse, structural constraints, semantic validation, structured error reporting.
- Deterministic test generation: per-operation cases (boundary, partitions, precondition-violation, postcondition-satisfaction) and per-component invariant tests, with traceability comments and a coverage manifest.
- Machine-readable CLI surface for agent control: structured errors, stable JSON output, deterministic behavior an external LLM/agent can consume and iterate against.
- CI lint: validation + staleness detection with distinct exit codes.

**Out of scope:**
- SMT-based precise input synthesis (v2 stretch).
- Arbitrary executable code inside contract expressions (no unregistered calls, no loops, no side effects).
- Multi-language grammar variants — grammar/validator/generator stay language-agnostic; only extractor/emitter plug in per language/framework.
- Approval metadata (`approvedBy`/`approvedAt`) in the file schema — the audit trail is git history.

**Programmatic surface (v1): CLI only.** The CLI — `bin versailles` plus the deterministic `runCli` envelope (`{ ok, errors, warnings, exitCode }`, build-spec §10) — is v1's programmatic interface. External agents, review UIs, and CI consume the CLI as a subprocess, never in-process imports (ADR-0010). There is no library API in v1: `src/index.ts` exports only `packageName`; parser/validator/loader/generator are internal implementation, not a public import surface. A programmatic library API is an explicit non-goal for v1, deferred to v2+ (VERSAILLES-19).

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

### The CLI is deterministic and never prompts an LLM; an external agent iterates against it

- **Given** an external LLM/agent that authors contract objects from source
- **When** it calls `versailles validate` / `versailles check` on its output
- **Then** the CLI responds with deterministic structured errors (stable JSON, exit codes) that the agent reads, fixes against, and re-runs — the CLI never prompts, calls, or retries an LLM itself

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
- Generation is a pure function of approved contracts; regeneration is idempotent and full-file; `generated/` is tool-owned and never hand-edited. The tool never invokes an LLM — no LLM client, no prompting logic, no LLM retry loop anywhere in the tool.
- `contracts.json` changes are single-object merges — never a full-file LLM rewrite.
- `.versailles/` files are never interpreted in isolation; all tools load them as a unit.

## Non-Goals

- SMT-backed precise input synthesis (v2).
- Executable code in contract expressions.
- Grammar variants per programming language.
- In-band approval metadata in the schema.

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build spec |
| 2026-08-11 | associate-head-coach | v1 scope pinned by ADR-0009: TS/C#/Python + vitest/xUnit/pytest, TS+vitest first |
| 2026-08-11 | associate-head-coach | Linked Plans section added pointing to the v1 pipeline implementation plan |
| 2026-08-11 | associate-head-coach | Removed Linked Plans section — execution plans are tracked outside the public repo |
| 2026-08-11 | associate-head-coach | Architecture correction: CLI never drives an LLM; LLMs drive the CLI (ADR-0010) |
| 2026-08-19 | general-manager | Programmatic surface pinned: CLI only, no library API in v1 (VERSAILLES-19) |