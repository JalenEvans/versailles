# Spec: Versailles contract pipeline

**ID:** SPEC-ver
**Lifecycle:** implemented
**Owner:** associate-head-coach
**Threshold:** public-api (the CLI surface, `.versailles/` file formats, generated test files), data (contracts/manifests/predicates are the tool's data layer)
**Linked contract:** `docs/contracts/versailles.contract.yaml`

---

## Behavioral Intent

Versailles turns Design-by-Contract specifications (invariants, preconditions, postconditions) written in a small expression language into deterministic test suites. Contracts are the single source of truth: a validated contract always produces the same tests. The CLI never drives an LLM — no LLM is invoked by the tool at any point (ADR-0010). Contracts are authored directly into `contracts.json` (with predicates declared inline in the top-level `predicates` map, ADR-0013); `validate` / `check` gate correctness; the git commit is the approval (ADR-0003, ADR-0012). The CLI exposes a deterministic, machine-readable surface (structured errors, stable JSON output, stable exit codes) that CI and external tooling can consume. The `.versailles/` directory is versioned and loaded as a single unit, and every contract clause and generated test traces back to a source hash.

## Scope

**In scope:**
- The `.versailles/` file set (`config.json`, `contracts.json` with its top-level `predicates` map, `manifests.json`) as a versioned, jointly-loaded unit.
- Contract expression grammar: parse, structural constraints, semantic validation, structured error reporting.
- Deterministic test generation: per-operation cases (boundary, partitions, precondition-violation, postcondition-satisfaction) and per-component invariant tests, with traceability comments and a coverage manifest.
- Machine-readable CLI surface: structured errors, stable JSON output, deterministic behavior CI and external tooling can consume.
- CI lint: validation + staleness detection with distinct exit codes.
- Declarative predicate verification: `validate` mechanically verifies each predicate declaration in `contracts.json` (ADR-0013).

**Out of scope:**
- SMT-based precise input synthesis (v2 stretch).
- Arbitrary executable code inside contract expressions (no unregistered calls, no loops, no side effects).
- Multi-language grammar variants — grammar/validator/generator stay language-agnostic; only extractor/emitter plug in per language/framework.
- Approval metadata (`approvedBy`/`approvedAt`) in the file schema — the audit trail is git history (ADR-0003).
- In-tool review or approval ceremony — retired by ADR-0012.

**Programmatic surface (v1): CLI only.** The CLI — `bin versailles` plus the deterministic `runCli` envelope (`{ ok, errors, warnings, exitCode }`, build-spec §10) — is v1's programmatic interface. CI and external tooling consume the CLI as a subprocess, never in-process imports (ADR-0010). There is no library API in v1: `src/index.ts` exports only `packageName`; parser/validator/loader/generator are internal implementation, not a public import surface. A programmatic library API is an explicit non-goal for v1, deferred to v2+ (VERSAILLES-19).

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

### The CLI is deterministic and never invokes an LLM

- **Given** any invocation of `versailles validate` / `versailles check`
- **When** the CLI runs
- **Then** it responds with deterministic structured errors (stable JSON, exit codes) — the CLI never prompts, calls, or retries an LLM; no LLM client, no prompting logic, no retry loop anywhere in the tool (ADR-0010)

### The git commit is the approval

- **Given** a validated `contracts.json` (with predicates declared inline in the top-level `predicates` map)
- **When** a user commits the file
- **Then** the git commit is the approval — no in-tool approval ceremony exists (ADR-0003, ADR-0012); `validate`/`check` + CI gate correctness

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
- Predicate calls resolve only to declared predicates with `verifiedPure: true`; unverified predicates are a hard error (ADR-0006).
- Generation is a pure function of validated contracts; regeneration is idempotent and full-file; `generated/` is tool-owned and never hand-edited. The tool never invokes an LLM — no LLM client, no prompting logic, no LLM retry loop anywhere in the tool (ADR-0010).
- `.versailles/` files are never interpreted in isolation; all tools load them as a unit.

## Non-Goals

- SMT-backed precise input synthesis (v2).
- Executable code in contract expressions.
- Grammar variants per programming language.
- In-band approval metadata in the schema (ADR-0003).
- In-tool review or approval ceremony (ADR-0012).

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
| 2026-08-20 | head-coach | Lifecycle flipped draft → implemented: context shipped and verified for beta |