# ADR: Property-based test emission in the MIT core; determinism scoped to generation-time

**ID:** ADR-0017
**Date:** 2026-08-28
**Status:** accepted
**Owner:** maintainer
**Canonical source:** MADR-derived decision record template

---

## Context and Problem Statement

The v1 generator emits deterministic, example-based tests: boundary values, equivalence partitions, precondition-violation, postcondition-satisfaction, invariant, and expected-rejection cases (build-spec §9.1–§9.2). These cover single-clause conditions well, but compound boolean preconditions produce vacuous interaction cases — the roadmap's Phase 9b names this defect directly: "boundary-value analysis silently produces vacuous tests when clauses interact… At L1 the tool can silently lie; at L2 it cannot." SMT-backed witness synthesis is the sound fix, but it is sequenced after v1 and tied to the L3/L4 paid engine (ADR-0014).

Seeded property-based testing (PBT) emission is a cheap, statistical mitigation of the same defect: emit `fc.assert(prop, { seed })`-style blocks whose arbitraries derive from the contract's typeRefs and constraint bounds, with the contract clauses codegen'd into the test as the oracle. PBT libraries (fast-check, Hypothesis, jqwik, FsCheck, QuickCheck) all support a fixed seed, so an emitted test can be reproducible run-to-run while still exploring a wide input space.

Two things must be decided:

1. **The determinism contract's scope.** ADR-0002's "no randomness" language is ambiguous: it was written to keep the *generation pipeline* a pure function ("same contract in, same test suite out"), not to dictate the *runtime behavior of emitted tests*. Emitting a seed-pinned property block keeps generation pure — the seed is a literal derived at generation time — while the test itself uses randomness at run time. The ambiguity must be resolved so the contract and spec stop over-stating the ban.

2. **Licensing placement.** Should PBT emission live in the MIT core (free tier, L0–L2) or be gated behind the paid tier alongside SMT?

## Decision Drivers

- **ADR-0015 D2 published commitment** — the free tier is "contract grammar, parser, validator, IR, CLI, **emitters**" under MIT, permanently. PBT emission is a generator/emitter capability; gating it would be the "changing the deal" move ADR-0015 warns destroys open-core projects.
- **The silent-lie defect is a free-tier problem** — L1/L2 (free) is where vacuous interaction cases occur; the cheapest fix should not be parked behind a paywall the roadmap itself says not to build before product-market fit (§14.3).
- **Generation-time determinism must survive** — emitted files stay byte-identical on regeneration; run-time randomness must be seed-pinned so the test is reproducible and failures are re-runnable via the printed counterexample.
- **PBT is a commoditized technique** — 40 years old (QuickCheck lineage), free in every serious library; commercial test-gen tools monetize platform/delivery/evidence, not the generation technique.
- **PBT complements, not substitutes, SMT** — PBT is stochastic (finds bugs, can't prove); SMT is sound (zero vacuous cases, certificate-grade). The paid tier's moat is the L3/L4 analysis + evidence layer, which PBT structurally cannot threaten.

## Considered Options

- **Option A — PBT emission in the MIT core, opt-in, seed-derived (chosen)** — new generator/emitter capability behind `config.json` `propertyBased.enabled` (default false); seed derived from a stable hash of the context (clause IDs + grammar version) as a 32-bit int, with optional explicit override; emitted additive to the concrete cases; the expected-rejection bounded sweep is supplemented/replaced only when enabled. ADR-0002's determinism is re-scoped to generation-time only.
- **Option B — PBT free, but depth-gated** — basic seeded properties free; SMT-verified / evidence-traced properties paid. Cleaner revenue story, but splits one feature across the licensing boundary and adds surface complexity now.
- **Option C — PBT gated with SMT in the paid tier** — preserves a single "advanced generation" paywall, but contradicts ADR-0015's emitters-are-MIT commitment, delays the free tier's core quality fix behind the L3/L4 engine (months per language), and prices a commoditized technique.
- **Option D — do nothing** — keep the v1 heuristics only; the L1 silent-lie defect persists until SMT ships.

## Decision Outcome

Chosen option: **Option A — PBT emission in the MIT core (L0–L2), opt-in via config, seed derived from the context at generation time, additive to the concrete cases; determinism re-scoped to generation-time only**, **because** it honors ADR-0015's published free-tier commitment (emitters are MIT), fixes the L1 silent-lie defect now rather than after the paid engine ships, keeps ADR-0002's generation-time purity intact (byte-identical files out; seed is a derived literal), and keeps the honest two-tier story: *free tier finds bugs fast (deterministic cases + seeded PBT); paid tier proves coverage (L3/L4 classification + SMT-sound witnesses + signed certificates)*. The CLA preserves relicensing freedom — free-tier PBT codegen can still be reused in the pro tier later if that ever becomes valuable.

### Consequences

- **Positive:** the free tier's core output quality improves (interaction-case discovery) without waiting for SMT; the determinism contract becomes precise (generation-time only) instead of over-broad; PBT's stochasticity cannot cannibalize the paid tier's proof/evidence value; the AST→code codegen machinery built for PBT de-risks the later AST→SMT-LIB translation (§9.5).
- **Negative:** generated files with PBT enabled now require a PBT library (fast-check, then hypothesis, then FsCheck) as a dev dependency of the consuming project; the emitted surface grows; the deterministic-generation contract and spec must be re-worded ("no randomness" → "no randomness at generation time; run-time randomness seed-pinned").
- **Neutral:** a seed derived from the context means any contract edit reshuffles the exploration space (desirable), while a failure stays reproducible via fast-check's printed `{ seed, path }` — users can pin it explicitly in config for cross-edit reproduction; the concrete cases remain the audit spine for `coverage.json` traceability and the future evidence layer.

### Confirmation

- ADR-0002's generation-time requirement stays in force: running `versailles generate` twice on the same context produces byte-identical files, including the emitted seed literal.
- `config.schema.json` gains a `propertyBased` block (`enabled` default false, `numRuns` default 100, optional `seed` override); with `enabled: false` the v1 output is byte-identical to today's (backward-compat pin preserved).
- Emitted PBT blocks carry a traceability comment (§9.3) and `fc.assert(prop, { seed: <derived-or-override> })`; the seed is derived from a stable hash of the context (clause IDs + grammar version) when not overridden.
- The deterministic-generation spec and contract are updated to scope "no randomness" to generation-time and to require seed-pinning for run-time randomness.
- The expected-rejection bounded sweep (`EXPECTED_REJECTION_SWEEP_MAX`) is replaced by a property only when `propertyBased.enabled` is true; the sweep remains the non-PBT fallback.

## More Information / Links

- [ADR-0002](0002-deterministic-generation-llm-authoring-only.md) — determinism core, re-scoped here to generation-time
- [ADR-0015](0015-licensing-and-contribution-model.md) — free-tier commitment (D2: emitters MIT, L0–L2)
- [ADR-0014](0014-roadmap-reconciliation.md) — SMT as soundness requirement for the L3/L4 engine
- [Build spec §9.5 — SMT-backed generation](../build-spec.md#95-smt-backed-generation-soundness-requirement-roadmap-§16)
- Roadmap: Phase 9b (SMT Witness Synthesis) and Phases 11–13 (Code-Path Analysis, paid tier) — Llama plans
- Behavioral spec: [docs/specs/deterministic-generation.md](../specs/deterministic-generation.md)
- Contract: [docs/contracts/deterministic-generation.contract.yaml](../contracts/deterministic-generation.contract.yaml)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-28 | maintainer | Initial proposal |
| 2026-08-28 | maintainer | Accepted |