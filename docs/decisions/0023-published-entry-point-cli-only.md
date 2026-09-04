# ADR: Published package entry point — CLI-only, no misleading library surface

**ID:** ADR-0023
**Date:** 2026-09-04
**Status:** accepted
**Owner:** maintainer
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

The published npm package `versailles-dbc` (`0.1.0-beta.x`) advertises a library entry point: `package.json:8-15` wires `main`, `types`, and `exports["."]` to `./dist/src/index.js`, but that module is a one-line stub exporting only `packageName` (`src/index.ts`). A consumer doing `import { ... } from "versailles-dbc"` gets nothing useful — the package metadata promises programmatic access that does not exist. The CLI (`bin/versailles` → `runCli` from `dist/packages/cli/src/cli/index.js`) is the real product (VERSAILLES-189).

The fix direction is constrained by two existing decisions:
- **ADR-0010 (accepted)** pins: "The package exposes no importable library surface: `package.json` `exports` exposes only `.` (no deep import paths); `src/index.ts` exports only `packageName`. Integration is via the CLI binary as a subprocess (structured JSON + exit codes), never in-process imports."
- **`docs/specs/versailles.md` § Programmatic surface (v1)** pins: "There is no library API in v1: `src/index.ts` exports only `packageName`; parser/validator/loader/generator are internal implementation, not a public import surface. A programmatic library API is an explicit non-goal for v1, deferred to v2+ (VERSAILLES-19)."

The beta finding is a metadata honesty bug: the package advertises a surface it does not have. Resolving it means either building the advertised surface (contradicting both decisions above) or making the metadata honest (consistent with both).

## Decision Drivers

- **Honesty of the advertised surface** — package metadata must not promise an import surface that does not exist; a stub entry is a silent dead end for programmatic consumers.
- **Consistency with accepted decisions** — ADR-0010 and SPEC-ver already decided the v1 integration model: subprocess CLI with structured JSON + exit codes, never in-process imports. A decision that contradicts them must be deliberate and supersede explicitly.
- **API commitment discipline** — a public library API is a semver contract. Exposing internals in beta locks a surface before v1 stabilization and before the API has been designed, documented, and tested as public.
- **Reuse intent is not an API promise** — ADR-0020 split the planner into responsibility-bounded modules for internal maintainability; the clean pure-function core (planTestCases/emitSuite/…) is raw material for a deliberate v2+ API, not a reason to rush one.

## Considered Options

- **Option A — Expose the real programmatic API** (`initWorkspace`, `loadWorkspace`, `planTestCases`, `planPropertyBlocks`, `emitSuite`, `coverageManifest` + types) — makes the advertised surface true, but contradicts ADR-0010 and SPEC-ver; requires superseding an accepted ADR and rewriting the spec's programmatic-surface paragraph; locks a public API in beta before stabilization.
- **Option B — Declare the package CLI-only (chosen)** — remove the misleading `main`/`types`/`exports` fields (primary) or keep them pointing at a documented no-op that throws a helpful "run the `versailles` binary" error (acceptable variant); document the package as CLI-only; consistent with ADR-0010 and SPEC-ver.
- **Option C — Do nothing** — leaves the misleading advertised surface in the published beta (rejected: a silent dead end for programmatic consumers).

## Decision Outcome

Chosen option: **Option B — CLI-only, because ADR-0010 and SPEC-ver already decided the v1 integration model (subprocess CLI, no importable library surface), and the beta finding is that the metadata advertises a surface that does not exist — the fix is to make the metadata honest, not to invent a premature public API.** The deterministic core kept clean by ADR-0020 remains the raw material for a deliberate v2+ library API (deferred by SPEC-ver, VERSAILLES-19); when that decision is actually made, a new ADR supersedes this one and updates the spec.

Note: the draft ticket recommendation for VERSAILLES-189 leaned Option A; that recommendation did not account for ADR-0010's accepted "no importable library surface" pin. This ADR supersedes that draft recommendation.

### Consequences

- **Positive:** the published package no longer promises a library surface it does not have; package metadata matches the product; ADR-0010's confirmation stays valid; no public API locked in during beta.
- **Negative:** programmatic consumers cannot import the tool in v1 — they must shell out to the `versailles` CLI subprocess (the decided integration model, ADR-0010).
- **Neutral:** `package.json` `main`/`types`/`exports` change shape; `tests/package.test.ts` is updated; README documents the package as CLI-only.

### Confirmation

- `package.json` no longer advertises `main`/`types`/`exports` to a library module — the fields are removed, or point only at a documented no-op; `exports` exposes no planner/emitter internals (no deep import paths).
- `bin/versailles` still imports `runCli` from `dist/packages/cli/src/cli/index.js` — the CLI path is untouched (ADR-0001).
- `tests/package.test.ts` passes and pins the CLI-only surface (no importable library surface; any named export of the package entry is at most `packageName`).
- README documents the package as CLI-only — integration via the `versailles` binary as a subprocess (structured JSON + exit codes), never in-process imports (ADR-0010).
- `scripts/validate-docs.sh` passes after this record is registered in `docs/decisions/index.md`.

## More Information / Links

- Ticket: VERSAILLES-189 (Define the published package entry point — stub today), epic VERSAILLES-183
- Related: [ADR-0001](0001-package-and-cli-naming.md) (package `versailles-dbc`, CLI `versailles`), [ADR-0010](0010-cli-never-drives-llm.md) (CLI never drives an LLM — no importable library surface), [ADR-0020](0020-split-generator-planner.md) (planner split for reuse)
- Spec: [`docs/specs/versailles.md`](../specs/versailles.md) § Programmatic surface (v1): CLI only (deferral VERSAILLES-19)
- Files: `src/index.ts`, `package.json:8-15`, `bin/versailles`

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-09-04 | maintainer | Initial proposal |
| 2026-09-04 | maintainer | Accepted by Head Coach (Option B — CLI-only; Option A deferred to v2+ as the deliberate library-API path) |