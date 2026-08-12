# Domain: Deterministic Generation

**Bounded context:** `deterministic-generation`

## Responsibility (what this context owns)

Compiling **approved contracts into deterministic test suites** — the core value proposition of Versailles (ADR-0002):

- The test-case compiler: per-operation cases (boundary values, equivalence partitions, precondition-violation cases, postcondition-satisfaction cases) and per-component invariant tests (build-spec §9.1–§9.2).
- The framework-agnostic **test-case IR** that emitters render into real test syntax.
- Traceability: every generated test carries a traceability comment with the clause IDs it covers; the coverage manifest (`generated/coverage.json`) maps clause IDs → test IDs (build-spec §9.3).
- The output **emitter plugin seam** selected by `config.testFramework` — the second pluggable edge (ADR-0008).
- Full ownership of `generated/`: regeneration is idempotent and full-file; the directory is tool-owned and never hand-edited.
- The configurable **rejection idiom** for precondition-violation assertions (default `throws`) (ADR-0007).

This context is **language-agnostic** — the test-case IR and case-generation logic never fork per language or framework; only emitters vary.

## Domain model

**TestCase** (entity) — one generated test: input values, expected outcome, assertion list, traceability comment, and the framework-agnostic IR form.

**TestCaseKind** (value object / enum) — `boundary`, `partition, `precondition-violation`, `postcondition-satisfaction`, `invariant-preservation`, `expected-rejection` (postcondition/invariant interaction).

**CoverageManifest** (entity) — `generated/coverage.json`: clause ID → generated test IDs; zero-test clauses detectable.

**EmitterPlugin** (interface) — the per-framework seam: test-case IR → `*.test.ts` / `*.Tests.cs` / `test_*.py`.

**RejectionIdiom** (value object) — from config; `throws` default, error-return/Result alternatives per language.

## Ubiquitous language

Uses from [glossary](../glossary.md): *generated test, test-case IR, emitter plugin, boundary value, equivalence partition, precondition-violation case, postcondition-satisfaction case, invariant test, rejection idiom, coverage manifest, traceability comment, approved contract*. "A test checker" is an *emitter*; "case categories" are the *TestCaseKind* values; "drift in coverage" is a *clause with zero generated tests*.

## Domain events

- `generationRun` — full-file regeneration completed, `generated/` and `coverage.json` refreshed.

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | Runs only against a context where `isValid: true`; writes `generated/` inside the workspace. |
| Downstream of | contract-language | Needs the validated AST/contract clauses; its structured errors block generation. |
| Downstream of | manifest-extraction | Manifests (via context) drive valid-state builders for invariant tests. |
| Upstream of | (CLI) | `versailles generate` is the command surface. |
| Future upstream | SMT-backed generation (v2) | The single, restricted AST keeps AST → SMT-LIB translation mechanical (build-spec §9.5, ADR-0008). |

## Business rules

- Generation is a pure function of approved contracts: same context in, **byte-identical** test suite out; no LLM is invoked at generation time (ADR-0002).
- Only runs where `isValid: true` — invalid contracts block generation (build-spec §9).
- Regeneration is idempotent and full-file; `generated/` is fully tool-owned — never hand-edited (build-spec §9.4).
- Precondition-violation cases assert rejection per the configured idiom (default `throws`) (ADR-0007, build-spec §9.1).
- postcondition-satisfaction cases resolve `old(...)` against captured pre-call state (build-spec §9.1).
- Postcondition/invariant interaction cases flag *expected-rejection* — the operation should refuse — the specific bug class DbC is designed to catch (build-spec §9.2).
- The core contains no framework-specific code; emitters are plugins chosen by `config.testFramework` (ADR-0008).

## v1 emitter matrix (ADR-0009)

| Test framework | Emitter output | Sequencing |
|---|---|---|
| vitest | `*.test.ts` | **First** (with TypeScript) |
| xUnit | `*.Tests.cs` | Second (with C#) |
| pytest | `test_*.py` | Third (with Python) |

## Open questions

- v2 stretch: SMT-backed precise input synthesis replacing heuristic boundary values for compound boolean preconditions (build-spec §9.5) — designed for, deferred.

## Source of authority

[build-spec.md §9](../build-spec.md) · [ADR-0002 deterministic generation](../decisions/0002-deterministic-generation-llm-authoring-only.md) · [ADR-0007 rejection idiom](../decisions/0007-configurable-rejection-idiom.md) · [ADR-0008 pluggable edges](../decisions/0008-language-agnostic-core-pluggable-plugins.md) · [ADR-0009 v1 matrix](../decisions/0009-v1-language-and-framework-matrix.md) · [Spec: Versailles contract pipeline](../specs/versailles.md)