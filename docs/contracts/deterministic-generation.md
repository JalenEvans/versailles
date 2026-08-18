# Contract Summary: Deterministic Generation

**Machine contract:** [deterministic-generation.contract.yaml](deterministic-generation.contract.yaml)
**Spec:** [docs/specs/deterministic-generation.md](../specs/deterministic-generation.md)
**Status:** draft · **Validated:** pass

## What this context does

Deterministic generation is the **core value proposition** of Versailles: a pure, deterministic
compiler from approved contracts to test files. Same context in → byte-identical test suite
out, every run — no randomness, no timestamps, no LLM. It plans a framework-agnostic test-case
IR and lets per-framework emitters (vitest, xUnit, pytest) render it into real test syntax inside the
  tool-owned `generated/` directory.

## What it guarantees (must)

- Case planning covers: boundaries (`x >= 0` → test at `0`, `-1`, `+1`), equivalence
  partitions (every `in`/enum member + one outside), a violation case per precondition clause,
  postcondition-satisfaction cases (with `old(field)` resolved against pre-call state),
  per-component invariant tests, and **expected-rejection** cases for the
  postcondition/invariant interaction bug class.
- Rejection assertions on both the violation and expected-rejection surfaces use the
  rejection idiom from `config.json` — **default `throws`, never hardcoded**.
- Every generated test carries a traceability comment; `generated/coverage.json` maps clause
  IDs → test IDs so a clause with **zero generated tests is detectable**.
- Emitters render shape-aware calls from method metadata: instance → `new <Component>().<op>(...)`,
  static → `<Component>.<op>(...)`, and void-return accept/invariant cases bind the component
  **instance** — assertions target instance state, never the void return value (VERSAILLES-26).
- Import specifiers derive from project-root-relative `sourcePath` and **resolve to the real
  source file** from the generated file's directory (VERSAILLES-24).
- A planned operation with no matching source method surfaces a non-silent, non-blocking
  `UNPLANNABLE_OPERATION` warning (exit 0, `CliResult.warnings`) and is **never emitted as an
  unrunnable static call** (VERSAILLES-25).
- Regeneration is idempotent and full-file; generation only runs when `context.isValid` is
  true — invalid contexts are rejected with structured errors and **no test files written**.

## What it forbids (must not)

- No generation on invalid contexts; no LLM at generation time or anywhere in the tool.
- No hardcoded `throws`; no framework-specific rendering in the core.
- No preserving hand-edited `generated/` content; no coverage manifest that hides gaps.
- No nondeterminism of any kind (no randomness, no timestamps, no LLM).

## Grounding

[build-spec §9](../build-spec.md) · ADR-0002 (deterministic generation) · ADR-0007
(configurable rejection idiom) · ADR-0008 (emitter seam) · ADR-0009 (framework matrix) ·
ADR-0010 (no in-tool LLM)