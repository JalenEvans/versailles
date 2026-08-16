# Spec: Deterministic Generation

**ID:** SPEC-dg
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** data (generated test files + `generated/coverage.json` are pipeline artifacts), public-api (the emitter plugin seam and the generated test surface), state (the `generated/` directory is tool-owned state, regenerated full-file; regeneration is an irreversible, idempotent transition)
**Linked contract:** `docs/contracts/deterministic-generation.contract.yaml`
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

The generator is the core value proposition of Versailles (ADR-0002): a pure, deterministic compiler from approved contracts to test files — same context in, byte-identical suite out, with no LLM invoked anywhere at generation time or anywhere in the tool (ADR-0010). It builds a framework-agnostic test-case IR covering boundary values, equivalence partitions, precondition-violation cases, postcondition-satisfaction cases, per-component invariant tests, and expected-rejection cases for the postcondition/invariant interaction bug class (build-spec §9.1–§9.2). Rejection assertions — on both §9.1 precondition-violation cases and §9.2 expected-rejection cases — use the rejection idiom configured in `config.json` (default `throws`) (ADR-0007). Every generated test carries a traceability comment, and `generated/coverage.json` maps clause IDs → test IDs so a clause with zero generated tests is detectable (build-spec §9.3). Output is rendered by per-framework emitter plugins (vitest, xUnit, pytest per ADR-0009) into the tool-owned `generated/` directory via idempotent, full-file regeneration (build-spec §9.4).

## Scope

**In scope:**
- Running only against a context where `isValid: true`; invalid contexts block generation (build-spec §9).
- Test-case IR production and case planning (build-spec §9.1–§9.2):
  - Boundary values: for every numeric comparison in preconditions, cases at the boundary, boundary−1, and boundary+1.
  - Equivalence partitions: for every `in` clause or enum-typed field, one case per partition member plus one case outside the set.
  - Precondition-violation cases: for each precondition clause individually, an input satisfying all *other* clauses but falsifying this one; assert rejection.
  - Postcondition-satisfaction cases: valid inputs asserted against every postcondition, with `old(field)` resolved against captured pre-call state.
  - Per-component invariant tests: valid pre-state satisfying all invariants, call with valid inputs, assert every invariant post-call.
  - Expected-rejection cases: inputs that satisfy the operation's postcondition but would violate a component invariant — the operation should refuse to complete.
- Rejection idiom from config (default `throws`) applied to **both** the §9.1 precondition-violation surface **and** the §9.2 expected-rejection surface (ADR-0007).
- Traceability: every generated test carries a traceability comment with the contract clause IDs it covers; `generated/coverage.json` maps clause ID → test IDs so zero-coverage clauses are detectable (build-spec §9.3).
- The emitter plugin seam selected by `config.testFramework` — vitest (`*.test.ts`), xUnit (`*.Tests.cs`), pytest (`test_*.py`), the full ADR-0009 matrix; emitters render the framework-agnostic IR (input values, expected outcome, assertions, traceability comment) to real test syntax (build-spec §9.4, ADR-0008).
- Full-file, idempotent regeneration: two runs on the same context produce byte-identical output; `generated/` is fully tool-owned and never hand-edited (build-spec §9.4).
- No LLM invocation at generation time or anywhere in the tool (ADR-0010).

**Out of scope:**
- SMT-backed precise input synthesis (v2 stretch, build-spec §9.5) — designed for via the frozen AST, deferred.
- Running/executing the generated tests — the generator writes files, it does not run them.
- Emitters beyond the ADR-0009 matrix — the seam dispatches the complete set (vitest, xUnit, pytest); additional frameworks are future work.
- Semantic validation of contracts (contract-language) and manifest derivation (manifest-extraction) — consumed via the context only.
- Any LLM involvement: no LLM client, no prompting logic, no retry loop (ADR-0010).

## Behavior

### Regeneration is deterministic, idempotent, and LLM-free

- **Given** a `.versailles/` context where `isValid: true` and existing output under `generated/` from a prior run
- **When** `versailles generate` runs twice on the same context
- **Then** the output under `generated/` is byte-identical across runs, no LLM is invoked during generation, and the directory is regenerated full-file from `contracts.json` — tool-owned state, never hand-edited, never treated as an input (ADR-0002, ADR-0010, build-spec §9.4)

### Invalid contexts block generation

- **Given** a workspace with parse or semantic validation errors (`isValid: false`)
- **When** `versailles generate` runs
- **Then** the command is rejected, no test files are written, and the failure surfaces the structured errors (build-spec §9)

### Case planning covers boundaries and partitions

- **Given** an operation with a numeric precondition comparison (e.g. `x >= 0`) and an `in` clause or enum-typed field
- **When** the generator plans operation cases
- **Then** boundary cases exist at the boundary, boundary−1, and boundary+1, and equivalence partitions exist as one case per member plus one case outside the set (build-spec §9.1)

### Precondition-violation and expected-rejection cases assert the configured rejection idiom

- **Given** an operation with precondition clauses, and `config.json` rejection idiom defaulting to `throws`
- **When** the generator emits §9.1 violation cases and §9.2 postcondition/invariant interaction (expected-rejection) cases
- **Then** for each precondition clause there is an input satisfying all other clauses but falsifying this one, and both violation and expected-rejection tests assert rejection using the configured rejection idiom — configurable, default `throws` (ADR-0007, build-spec §9.1–§9.2)

### Postcondition-satisfaction resolves `old(...)`; invariants are preserved

- **Given** an operation with postconditions (possibly referencing `old(field)`) and a component with invariants
- **When** the generator emits satisfaction and invariant-preservation cases
- **Then** satisfaction cases assert every postcondition on the result with `old(field)` resolved against captured pre-call state, and invariant tests build a valid pre-state, call with valid inputs, and assert every invariant still holds post-call (build-spec §9.1–§9.2)

### Traceability and coverage are machine-checkable

- **Given** a generated test suite and `generated/coverage.json`
- **When** any contract clause ID is queried
- **Then** the generated tests covering it are identifiable via traceability comments and the coverage manifest maps clause ID → test IDs, so a clause with zero generated tests is detectable (build-spec §9.3)

## Constraints

- `must_not` run generation against a context where `isValid: false` — invalid contracts block generation (build-spec §9).
- `must_not` invoke an LLM at generation time or anywhere in the tool — no LLM client, no prompting logic, no retry loop (ADR-0010, ADR-0002).
- `must_not` hardcode "throws" in rejection assertions — rejection assertions read the configured idiom from `config.json` and apply it to both §9.1 violation and §9.2 expected-rejection surfaces (ADR-0007).
- `must_not` place framework-specific rendering logic in the core — all rendering lives behind the emitter plugin seam (ADR-0008).
- `must_not` treat hand-edited `generated/` content as source or preserve it — the directory is fully tool-owned and full-file regenerated (build-spec §9.4).
- `must_not` emit a coverage manifest that hides gaps — every clause maps to its generated test IDs; zero-coverage clauses remain detectable (build-spec §9.3).
- The generator `must_not` be nondeterministic — same context in, byte-identical suite out, no randomness, no timestamps, no LLM (ADR-0002).

## Non-Goals

- No SMT-backed witness synthesis for compound boolean preconditions (v2, build-spec §9.5).
- No test execution or CI running of generated tests — generation writes files only.
- No framework-specific emitters in the core — all rendering lives behind the emitter seam (ADR-0008), and no emitters beyond the ADR-0009 matrix (vitest, xUnit, pytest).
- No LLM involvement of any kind inside the tool (ADR-0010).
- No hand-editing of `generated/` as a supported workflow (build-spec §9.4).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build-spec §9, §2; ADR-0002/0007/0008/0009/0010 |
| 2026-08-13 | associate-head-coach | Removed Linked Plans section — execution plans are tracked outside the public repo |
| 2026-08-16 | associate-head-coach | Superseded "vitest first / no xUnit-pytest in the first milestone" scope — the full ADR-0009 emitter matrix (vitest, xUnit, pytest) is shipped (PR feat/review-ecosystem) |