# ADR: Split the deterministic generator planner into responsibility-bounded modules

**ID:** ADR-0020
**Date:** 2026-09-01
**Status:** accepted
**Owner:** associate-head-coach
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

`packages/engine/src/generator/planner.ts` has grown to ~3050 lines, 58 functions, and 3 public exports (`planTestCases`, `coverageManifest`, `planPropertyBlocks`). It is a monolith of six accidentally-cohesive clusters: orchestration, concrete-case planning (§9.1), input synthesis, a mini expression evaluator, clause analysis, and the PBT machinery (ADR-0017). A file this size defeats review — every diff conflates unrelated responsibilities — and makes behavioral changes hard to attribute to a single decision point. The emission-soundness work (ADR-0021) must land in exactly these seams, and doing so inside a 3000-line file would make it unreviewable.

## Decision Drivers

- Maintainability: a 3000-line file defeats review; diffs conflate intent and navigation is costly.
- Cohesion: the clusters have clean, named responsibilities — the seams already exist.
- Safety: the repo pins byte-identical generated output (`tests/example.test.ts` regenerates and asserts a clean `git diff`; determinism pins across `generator.test.ts` / `emitters.test.ts`), so a behavior-preserving split has a mechanical success criterion.

## Considered Options

- **Option A — 6-module split by responsibility (chosen)** — `planner.ts` becomes a thin orchestrator (`planTestCases`, `coverageManifest`, `allCases`, identifier guards); the concrete §9.1 planners move to `concrete-cases.ts`; pre-state/valid-params/assertion descriptors move to `input-synthesis.ts`; AST classification helpers move to `clause-analysis.ts`; the mini grammar evaluator moves to `evaluator.ts`; the PBT machinery (bounds, arbitrary specs, joint-sampling, `planPropertyBlocks`) moves to `property-planning.ts`.
- **Option B — 8-module split now** — additionally split `property-planning.ts` into `arbitrary-specs.ts` and `joint-sampling.ts`. More granular, but puts two refactors in one wave.
- **Option C — Status quo** — keep the monolith; land ADR-0021's behavior changes inside it.

## Decision Outcome

Chosen option: **Option A, because the responsibility clusters are already coherent, the split is provably behavior-preserving via the byte-identical output pins, and each ADR-0021 behavior change then lands in a named, ~450-line module instead of a 3000-line file.** The split is a pure structural refactor: no behavior change, no IR change, no emitted-output change. The generator's public surface is unchanged — `packages/engine/src/generator/index.ts` re-exports the same `planTestCases` / `coverageManifest` / `planPropertyBlocks` from the new modules. The duplicated `oracleParamsOf` (present in both `planner.ts` and `emitters/vitest.ts`) is consolidated into one shared location as part of the split.

### Consequences

- **Positive:** files under ~500 lines except `property-planning.ts` (~1050); reviewable, attributable diffs; ADR-0021's field-access and emission decisions land in `input-synthesis.ts` / `property-planning.ts` with clear homes; the duplicate `oracleParamsOf` copy is eliminated.
- **Negative:** cross-module imports add some indirection; the refactor touches a hot, heavily-tested file (mitigated by the byte-identical pins and the full suite).
- **Neutral:** no behavior or output change; `property-planning.ts` may be split further (Option B) in a later, separate wave.

### Confirmation

- The public module surface (`packages/engine/src/generator/index.ts`) still exports exactly `planTestCases`, `coverageManifest`, `planPropertyBlocks`, `derivePropertySeed`, `renderClausePredicate`, `selectStrategy`, `emitSuite`.
- `bun test` passes; regenerating the example workspace is byte-identical (`git diff` clean on `.versailles/generated/`).
- `oracleParamsOf` exists in exactly one module.

## More Information / Links

- Related: [ADR-0002](0002-deterministic-generation-llm-authoring-only.md) (determinism — the byte-identical pin), [ADR-0017](0017-property-based-test-emission-mit-core.md) (PBT machinery), [ADR-0021](0021-totality-of-emission.md) (the emission-soundness work that motivated the split)
- [Build spec §9.1–§9.2](../build-spec.md) (concrete case planning), §9.6 (seeded PBT emission)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-09-01 | associate-head-coach | Initial proposal |
| 2026-09-01 | associate-head-coach | Accepted by Head Coach |