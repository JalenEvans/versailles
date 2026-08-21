# ADR: Contract-first emission — generate from contracts.json; extract-manifests optional for brownfield

**ID:** ADR-0011
**Date:** 2026-08-21
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Versailles generates deterministic tests from Design-by-Contract specifications. Today, `versailles generate` is gated on a valid workspace that includes a populated `manifests.json` — the output of `versailles extract-manifests`. Contracts that reference fields or operations absent from the manifest fail semantic validation (`validator.ts` `getManifestEntry`), and the generator depends on manifests for three things: `deriveModulePaths` (import paths), `deriveMethods` (positional call metadata), and the V-25 method-map gating that skips operations missing from the method map (`src/generator/planner.ts` lines 193 and 240; `src/cli/handlers/generate.ts`).

This ordering contradicts canonical TDD. In the Kent Beck lineage (Clean Code Guy, LHTP, BrowserStack Red-Green-Refactor guides), the Red phase writes tests against code that does not yet exist — a compile or import error *counts* as the failed test. The class skeleton is created during Green ("just enough to exist"), never as a prerequisite to writing tests. Contract-first tooling across the ecosystem agrees: OpenAPI/Swagger generators, Dredd, Schemathesis, Postman's contract generator, and spec-driven test-gen skills (including Meta's 2026 spec-driven research) all generate tests from the spec/contract alone, "designed to fail initially," with implementation last.

The practical friction is concrete: a user starting a new component must fabricate a stub source file (`cart.ts`, etc.) purely so `extract-manifests` has something to parse, before any test exists. The observed user question — "why do we need a cart.ts? We shouldn't even need source to generate tests" — is the canonical TDD position, and Versailles currently argues with it.

## Decision Drivers

- **Greenfield TDD enablement** — tests must be writable before the module exists; Red via import error is a valid first phase.
- **Brownfield adoption on-ramp stays intact** — existing codebases still feed source through `extract-manifests`; that path is not weakened.
- **No new schema** — `contracts.json` already declares parameters with `name` + `type`; nothing needs to be added to the contract shape to support contract-first emission.
- **Determinism preserved** — contract-first emission is still fully deterministic; the same contract yields the same tests.
- **Backward compatibility** — the existing extract-first flow must remain byte-identical for workspaces that already have manifests.
- **V-25 distinction** — "no manifests at all" (greenfield) must not be conflated with "manifest present but op missing" (brownfield drift). V-25 method-map gating applies only when a manifest *is* present.

## Considered Options

- **Option A — Contract-first emission (chosen)** — `generate` works from `contracts.json` alone when no manifests exist; module paths are derived from the contract; V-25 method-map gating applies only when a manifest is present. `extract-manifests` remains the on-ramp for brownfield codebases. An explicit flag may be added later for mixed workspaces that have manifests for some modules but not others.
- **Option B — Require stubs (status quo)** — user writes a stub source file so `extract-manifests` has something to parse; the workflow is documented. Single code path, but forces an anti-TDD prerequisite and confuses new users who expect to write tests first.
- **Option C — Full contract-only mode, replacing extraction** — manifests become optional everywhere and lose their authority. Simpler surface, but loses `sourceHash` staleness detection and the semantic-validation ground truth that protects existing codebases; risks silently emitting dead or unrunnable tests when the contract drifts from reality, which is a regression against V-25's purpose.

## Decision Outcome

Chosen option: **Option A — contract-first emission, with extract-manifests remaining required for brownfield**, **because** it restores the canonical TDD loop (Red via import errors, Green after implementation), keeps the existing adoption path for brownfield codebases intact, adds no new schema (the contract already carries parameters with name and type), and preserves determinism. Manifests remain authoritative whenever they are present — so staleness detection and V-25 gating are untouched for existing codebases. The two code paths in `generate` (contract-first when manifests are absent, extract-first when they are present) are distinguished by manifest presence, not by a flag, for the common case; a flag may be introduced later for mixed workspaces.

### Consequences

- **Positive:** greenfield users can run TDD without fabricating stubs — `versailles generate` on a workspace with only `contracts.json` + config emits tests and `coverage.json`; the Red phase is a real import error, not a tooling error. The workflow now matches canonical TDD and the contract-first norms of OpenAPI/Swagger generators, Dredd, Schemathesis, and Postman. New-user friction ("why do we need a cart.ts?") is removed.
- **Negative:** `generate` now has two code paths (contract-first and extract-first) that must be kept consistent as the generator evolves. Contract-first emission cannot guarantee the emitted import path resolves until the module exists, so test output must distinguish Red-via-import-error from infrastructure error clearly — otherwise users will confuse a legitimate TDD Red with a broken generator.
- **Neutral:** build-spec §9 and §12 flow documentation is updated to describe both entry points (contract-first for greenfield, extract-first for brownfield). A workspace flag may be needed later for mixed workspaces where some modules have manifests and others do not.

### Confirmation

- A scratch workspace containing only `contracts.json` + config (no source, no `manifests.json`) runs `versailles generate` successfully and emits tests + `coverage.json`.
- Tests generated against no source fail with `MODULE_NOT_FOUND` / `TypeError` at run time (a legitimate TDD Red), and pass after the user implements matching signatures (Green).
- With `manifests.json` present (brownfield), `generate` output is byte-identical to today — `examples:generate` idempotency still holds; V-25 still warns and skips operations missing from an existing method map.
- `scripts/validate-docs.sh` passes with this ADR linked from the decisions index.

## More Information / Links

- Ticket: VERSAILLES-149
- [Build spec §9.1 — generate flow](../build-spec.md#91-generate-flow)
- [Build spec §12 — end-to-end flow](../build-spec.md#12-end-to-end-flow)
- Code under decision: `src/cli/handlers/generate.ts` (`deriveModulePaths`, `deriveMethods`), `src/generator/planner.ts` (V-25 gating at lines 193 and 240), `src/cli/context.ts`
- Contract shape (already carries params with name + type): `examples/order-service/.versailles/contracts.json`
- Supersedes nothing; complements [ADR-0010](0010-cli-never-drives-llm.md) (the CLI remains deterministic and agent-driven; this ADR only relaxes the *workspace* precondition for `generate`).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-21 | associate-head-coach | Initial proposal |
| 2026-08-21 | associate-head-coach | Accepted by Head Coach |
