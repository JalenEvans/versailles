# Feature: Deterministic Generation

**Command:** `versailles generate`
**Primary context:** [deterministic-generation](../domains/deterministic-generation.md)
**Vocabulary:** [glossary](../glossary.md) — *approved contract, generated test, test-case IR, emitter plugin, coverage manifest, traceability comment, rejected command*

## Overview

The core value proposition: **same approved contract in, same test suite out — every time, no LLM.** `versailles generate` compiles `contracts.json` into test files under `generated/`, with per-operation cases and per-component invariant tests, targeting the framework selected by `config.testFramework`.

## User story

> As a developer, I want to regenerate my test suite from my approved contracts so my tests never drift from the contract and are reproducible in CI.

## Flow

1. Load the workspace via [workspace-context](../domains/workspace-context.md). If the context is **not** `isValid: true`, the command is a [rejected command](command-rejection.md) — generation does not run.
2. For each operation, generate **per-operation test cases** (build-spec §9.1):
   - **boundary values** at numeric comparison thresholds (threshold, threshold−1, threshold+1);
   - **equivalence partitions** for every `in` clause / enum-typed field (one case per member + one outside);
   - **precondition-violation cases** — inputs satisfying all *other* clauses but falsifying the one under test, asserting rejection per the configured rejection idiom;
   - **postcondition-satisfaction cases** — valid inputs asserting the simple field-compare postconditions (`field op expr`), resolving `old(...)` against captured pre-call state; non-computable clauses contribute no assertion (conservative skip, still traced).
3. For each component with invariants, generate **per-component invariant tests** (build-spec §9.2): build a valid pre-state, call the operation, assert every invariant still holds; flag postcondition/invariant interaction cases as *expected-rejection*.
4. Attach a **traceability comment** to every generated test (`// versailles: <clauseId> (case kind)`), refresh `generated/coverage.json`.
5. Render via the **emitter plugin** for `config.testFramework`, full-file and idempotent.

## Domain events

- `generationRun` — wired to the `generate` invocation; `generated/` and `coverage.json` updated.

## Business rules

- Runs only against a context where `isValid: true` (build-spec §9).
- Byte-identical output for identical approved contracts — regeneration is idempotent, full-file, and `generated/` is tool-owned (never hand-edited; ADR-0002, build-spec §9.4).
- Every generated test traces to a clause ID; a clause with zero generated tests is detectable via the coverage manifest (build-spec §9.3).
- Precondition-violation assertions use the configured rejection idiom, default `throws` (ADR-0007).

## Edge cases

- **Invalid contract in context** → command rejects with structured errors, exit `1`; no partial generation.
- **Empty selected component/operation** → emits no tests for that scope but does not fail the run.
- **Postcondition/invariant conflict** → expected-rejection case generated (the DbC bug class); not a generator failure.
- **Compound boolean preconditions** (v2) → heuristic partitions may miss interactions; SMT-backed synthesis is the designed, deferred successor (build-spec §9.5).

## Source of authority

[build-spec §9](../build-spec.md) · [ADR-0002](../decisions/0002-deterministic-generation-llm-authoring-only.md) · [ADR-0007](../decisions/0007-configurable-rejection-idiom.md) · [ADR-0009](../decisions/0009-v1-language-and-framework-matrix.md)