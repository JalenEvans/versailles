# ADR: Deterministic generation; LLM confined to authoring

**ID:** ADR-0002
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

The core value proposition of Versailles is reproducibility: same contract in, same test suite out. LLMs are nondeterministic, so if an LLM touched the generation path, output could change run-to-run and generated tests could not be trusted as a stable artifact. The question is where LLM involvement is allowed without undermining determinism.

## Decision Drivers

- Reproducibility: generated tests must be byte-stable for a given approved contract.
- Auditability: every generated test must trace to a contract clause and source hash.
- Cost: generation runs repeatedly (CI, local dev) — an LLM call per generate is expensive and slow.
- Authoring effort: writing contracts by hand is the bottleneck the LLM is meant to relieve.

## Considered Options

- **LLM generates tests directly** — fastest to stand up; nondeterministic output, no verifiable equivalence between runs.
- **Contracts as source of truth + deterministic compiler (chosen)** — contracts are authored (with LLM help), then a pure, deterministic generator compiles them to tests.
- **Hybrid: LLM suggests, deterministic codegen finalizes** — still risks a nondeterministic final step and blurs the boundary of what is trusted.

## Decision Outcome

Chosen option: **contracts as the single source of truth, with a deterministic compiler**, **because** it is the only option that delivers reproducible, auditable, cheap generation. LLM involvement is confined to the authoring loop, and every LLM output is mechanically validated (parse + semantic) before a human ever sees it.

### Consequences

- **Positive:** generated tests are reproducible and auditable; regeneration is cheap and CI-safe.
- **Negative:** contract authoring is the bottleneck — the LLM authoring loop (§10 of the build spec) must work well for the pipeline to be productive.
- **Neutral:** the generator is a compiler, not a thin wrapper — more code, but bounded and unit-testable.

### Confirmation

- Running `versailles generate` twice on the same context produces byte-identical output.
- The generator module has no LLM call sites.

## More Information / Links

- [Build spec §1 Goals](../build-spec.md#1-goals-and-non-goals), [§9 Deterministic test generator](../build-spec.md#9-deterministic-test-generator), [§10 LLM contract-authoring loop](../build-spec.md#10-llm-contract-authoring-loop)
- Behavioral spec: [docs/specs/versailles.md](../specs/versailles.md)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |