# ADR: v1 targets TypeScript, C#, and Python with vitest, xUnit, and pytest

**ID:** ADR-0009
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

The build spec (§7, §9.4, §14) assumed v1 targets **one** language and **one** test framework ("pick based on your primary repo"). The Head Coach has decided v1 instead spans three source languages and three test frameworks, with TypeScript + vitest first. This changes the v1 scope and the build milestone ordering.

## Decision Drivers

- Reach: a single-language v1 would force users on other ecosystems to wait for v2.
- Sequencing: implementation still starts with one language pair to prove the pipeline before multiplying extractor/emitter work.
- ADR-0008 (language-agnostic core, pluggable edges) is now load-bearing: three languages and three frameworks are only feasible because the core stays agnostic.

## Considered Options

- **Single language/framework (spec default)** — smallest v1, but abandons two of the three requested ecosystems until v2.
- **Three languages + three frameworks in v1 (chosen)** — larger v1, but the pluggable seam (ADR-0008) makes each additional pair a plugin, not a fork.
- **All three immediately in parallel** — maximizes speed-to-coverage, but risks building three extractors/emitters before the generator is proven; rejected as too much unproven surface.

## Decision Outcome

Chosen option: **three languages and three frameworks in v1, implemented sequentially with TypeScript + vitest first**, **because** it honors the requested scope while preserving the spec's own risk-ordering advice — prove the core pipeline on one language pair (milestones 1–3) before multiplying per-language work.

v1 matrix:

| Source language | Manifest extractor | Test framework | Output emitter |
|---|---|---|---|
| TypeScript | `ts.createProgram` + type checker | vitest | `*.test.ts` |
| C# | Roslyn / source shape analysis | xUnit | `*.Tests.cs` |
| Python | `ast` + typing introspection | pytest | `test_*.py` |

Sequencing: **TypeScript + vitest first**, then C# + xUnit, then Python + pytest. Each language pair adds an extractor and an emitter; the core (grammar, parser, validator, loader, generator IR) is written once and never forks.

### Consequences

- **Positive:** v1 covers the three requested ecosystems; the pluggable seam from ADR-0008 is exercised from day one rather than being speculative.
- **Negative:** v1 is bigger than the spec's original one-language target — three extractors and three emitters to maintain; more fixture surface to validate.
- **Neutral:** milestones 4 and 9.4 of the build spec effectively become "one extractor + one emitter per language pair," each independently testable.

### Confirmation

- `config.json` `language` accepts `typescript | csharp | python`; `testFramework` accepts `vitest | xunit | pytest`.
- Repo ships three extractor plugins and three emitter plugins, each registered behind the same interface (no language-specific code in the core).
- Implementation history shows TS+vitest landed before C#+xUnit, which landed before Python+pytest.

## More Information / Links

- Supersedes the single-language assumptions in [build spec §7](../build-spec.md#7-manifest-extractor-source--manifestsjson) and [§9.4](../build-spec.md#94-output-emitters), and the "single framework" row of [§14](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)
- Complements [ADR-0008](0008-language-agnostic-core-pluggable-plugins.md) (language-agnostic core, pluggable edges)
- Behavioral spec: [docs/specs/versailles.md](../specs/versailles.md)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal, accepted by Head Coach |