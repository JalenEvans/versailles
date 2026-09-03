# ADR: Totality of emission — generated output type-checks or is refused

**ID:** ADR-0021
**Date:** 2026-09-01
**Status:** accepted
**Owner:** maintainer
**Canonical source:** MADR-derived decision record template

---

## Context and Problem Statement

The example workspace's generated test file (`examples/order-service/.versailles/generated/OrderService.test.ts`) does not type-check under a strict tsconfig. Two error classes:

1. **Private field access** (TS2341, five sites): the source declares `private balance: number`, and the generated test emits `instance.balance = 50` / `expect(instance.balance)...`. The manifest records `fields: { name → typeRef }` only — no visibility — so the emitter *cannot know* the field is private. This is an input-model gap, not emitter sloppiness: from `balance: number`, `instance.balance` is the only faithful emission.
2. **Implicit `any` in PBT oracle lambdas** (TS7006, seven sites): `(sku) => sku !== ""` etc. The emitter has the types (op params from the contract, field types from the manifest) and drops them at emission.

Neither is caught today: `vitest run` passes because esbuild transpiles without type-checking, and nothing in the tool's own flow type-checks its output. The planner already has a "never silently emit an unplannable shape" discipline (`UNPLANNABLE_OPERATION`, `PROPERTY_UNPLANNABLE` — VERSAILLES-25/165); emission soundness has no equivalent.

## Decision Drivers

- Correctness: generated tests are the tool's deliverable — type-broken output fails users' CI and erodes trust in the deterministic-generation promise.
- Honesty: a deliberate, documented cast is an honest escape; a silent type error is not.
- Consistency: extend the existing never-silent discipline from planning to emission — the emitter must be *total*.

## Considered Options

- **Option A — Complete the input model + principled emission + self-verification gate (chosen)** — (1) the manifest captures per-field access (`public`/`protected`/`private`) and `readonly`; (2) PBT oracle lambdas are emitted with explicit param types from the contract/manifest; (3) private/protected/readonly fields are reached through a deliberate, documented `(instance as any).<field>` cast decided from manifest data — the standard white-box testing idiom, since external code cannot touch private state type-safely by definition; (4) the tool's CI type-checks the generated example under a documented baseline strict tsconfig (`tsc --noEmit` + `vitest run`), the same self-gating philosophy as `validate-docs.sh` / `validate-contracts.sh`.
- **Option B — Skip private-field assertions** — conservative skip + non-silent warning (mirrors the uncomputable-clause skip). Loses coverage of exactly the assertions the example exists to demonstrate.
- **Option C — Always cast instance-field access** — no schema change, but loses type safety on public fields too.
- **Option D — Example-only gate, no input-model change** — treats the symptom; the emitter still cannot know about private fields, so the errors recur for every realistic private-field workspace.

## Decision Outcome

Chosen option: **Option A, because the root cause is an incomplete input model, not an emitter defect — the emitter can only decide correctly when the manifest carries the properties the emitted code must respect.** The guarantee: for every valid workspace, the emitter emits code that type-checks under the documented baseline strict tsconfig, or refuses loudly with a non-silent warning (same tier as `UNPLANNABLE_OPERATION` / `PROPERTY_UNPLANNABLE`). Never silently type-broken output. The cast for non-public fields is a deliberate, decision-point-controlled escape — it keeps coverage (the `balance` invariant is the point of the example) and is the standard white-box testing idiom. Legacy manifest entries without access data load permissively and default to accessible — consistent with the permissive policy (ADR-0004, ADR-0018).

### Consequences

- **Positive:** generated output is provably valid under strict; the example becomes a template users can copy with confidence; CI regresses emitter bugs at their source; the planner gains the "totality of emission" discipline alongside "totality of planning."
- **Negative:** the manifest schema grows (`access`, `readonly` per field); extractor, loader, planner, codegen, and emitters change; `(instance as any)` casts are an acknowledged escape, documented in the emitted output.
- **Neutral:** the guarantee is scoped to the **documented baseline strict tsconfig** — the tool cannot guarantee type-correctness under arbitrary consumer configs (e.g. `.ts` import specifiers require `allowImportingTsExtensions`). The baseline ships with the example.

### Confirmation

- The generated example passes `tsc --noEmit` under the baseline strict tsconfig and `vitest run`.
- PBT oracle lambdas carry explicit param types (`(sku: string) => ...`, `(price: number) => ...`, `(balance: number) => ...`).
- Manifest entries for non-public fields carry `access`/`readonly`; the emitter emits casts only for non-public fields, never for public ones.
- A non-silent warning path exists for shapes the emitter cannot render type-safely (mirrors the `UNPLANNABLE_OPERATION` tier).
- `scripts/validate-docs.sh` and `scripts/validate-contracts.sh` pass after the spec/contract updates.

## More Information / Links

- Related: [ADR-0020](0020-split-generator-planner.md) (the planner split that gives this work clean seams), [ADR-0002](0002-deterministic-generation-llm-authoring-only.md) (deterministic output), [ADR-0005](0005-static-analysis-first-manifest-extraction.md) (manifest grounding)
- [Build spec §3.3 manifests.json](../build-spec.md#33-manifestsjson) · §9.1 (planning discipline) · §9.6 (PBT emission)
- [Spec: Deterministic Generation](../specs/deterministic-generation.md) · [Spec: Manifest Extraction](../specs/manifest-extraction.md)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-09-01 | maintainer | Initial proposal |
| 2026-09-01 | maintainer | Accepted |