# Spec: Workspace Context

**ID:** SPEC-wc
**Lifecycle:** implemented
**Owner:** maintainer
**Threshold:** data (the `.versailles/` file set is the tool's data layer, identified by the `config.schema.json` pointer; `config.schema.json` gates it), public-api (the `VersaillesContext` object, scoped extraction helper, and `versailles check` exit codes are consumed by every other component and CI)
**Linked contract:** `docs/contracts/workspace-context.contract.yaml`
**Canonical source:** spec-builder template

---

## Behavioral Intent

The `.versailles/` workspace — `config.json`, `contracts.json` (with its top-level `predicates` map), `manifests.json` — is a file set loaded as a single unit; no file is valid to interpret in isolation because contracts reference manifests and predicates by name (build-spec §2, §6). The loader applies no version gates (ADR-0018): `grammarVersion`/`schemaVersion` and the per-file `version` fields are removed, `config.json` carries a `$schema` pointer to `config.schema.json`, the tool version lives in the binary (`versailles -v` / `--version`), and deprecated fields still load permissively until `migrate` rewrites them (build-spec §3.1). It parses and validates every `expr` against the full context and returns one `VersaillesContext` object with parsed ASTs, errors, warnings, and an aggregated `isValid` flag (build-spec §6). The config schema is machine-checkable against the ADR-0009 enum matrix (`language` = typescript|csharp|python, `testFramework` = vitest|xunit|pytest — `jest` is rejected, `vitest` accepted). The context owns the scoped extraction helper used by `validate --verbose` and orchestrates the CI staleness check (`versailles check`) with distinct exit codes `0`/`1`/`2` (build-spec §8). A single shared loader is used by every component — no component re-implements loading (build-spec §6), and the tool never invokes an LLM (ADR-0010). The loader also owns the manifests.json store entry shape: entries may carry `sourcePath` (never empty for covered entries; legacy entries lacking it preserved as-is) and per-component `methods` metadata (recorded where determinable under the permissive low-confidence policy), and it surfaces both on `ManifestsFile` entries so the generate handler and emitters can derive real module import paths and call shapes (build-spec §3.3, §7). A refreshed entry's `methods` key may be the empty map `{}` — the first-class signal that the extractor knows the component has zero methods — and the loader surfaces it exactly as stored, never stripping or inventing it (VERSAILLES-25 follow-up).

## Scope

**In scope:**
- Joint loading and JSON-parsing of all three top-level `.versailles/` data files together (build-spec §2, §6).
- The additive-only format policy (ADR-0018): no version gates — `grammarVersion`/`schemaVersion` and per-file `version` fields are removed; `config.json` carries a `$schema` pointer to `config.schema.json`; the tool version lives in the binary (`versailles -v` / `--version`); deprecated fields load permissively until `migrate` rewrites them.
- `config.schema.json` (machine-checkable config validation) against the ADR-0009 enum matrix — `language` accepts `typescript | csharp | python`; `testFramework` accepts `vitest | xunit | pytest`; `jest` (and any value outside the matrix) is rejected.
- Producing a single `VersaillesContext` object: `config, contracts, manifests, predicates, parsedContracts, parseErrors, validationErrors, validationWarnings, isValid` (build-spec §6.5).
- The scoped extraction helper: given a component/operation name, return just that sub-object plus its errors/warnings — what `validate --verbose` shows (build-spec §6.6).
- Staleness orchestration via `versailles check`: fail on non-empty `parseErrors`/`validationErrors`, recompute every stored `sourceHash` and compare, honor `config.staleness.blockOnStale` (block with exit code `2` vs. warn with exit code `0`; clean is `0`, parse/validation error is `1`) (build-spec §8).
- The shared-loader guarantee: every consuming component (CLI commands, CI lint, generator) uses this loader — none re-implements loading.
- The manifests.json store entry shape — `sourcePath` (string; never empty for covered entries; legacy entries lacking it preserved as-is) and `methods` (per-component map of method name → `{ static: boolean, params: string[], returnType?: string }`, recorded where determinable, permissive low-confidence policy) — and surfacing both on `ManifestsFile` entries so downstream consumers (generate handler → emitter modulePaths + call shape) can use them (build-spec §3.3, §7). A refreshed entry always carries the `methods` key — possibly `{}`, the first-class zero-methods signal — with only preserved legacy entries allowed to lack it; a present empty map is surfaced exactly as stored (VERSAILLES-25 follow-up).

**Out of scope:**
- The expression grammar, AST, and structured errors themselves (contract-language parses them; this context orchestrates).
- Semantic-rule decision making (contract-language); this context aggregates parse + validation results.
- Source-side manifest derivation (manifest-extraction).
- Recording or derivation of `sourcePath`/method metadata (manifest-extraction writes them; this context only loads and surfaces them).
- Test-case planning and emitter output (deterministic-generation).
- The review merge (approval write-back to `contracts.json`) — retired by ADR-0012; the git commit is the approval.
- Any LLM involvement in loading or checking — the CLI surfaces deterministic output for CI and external tooling; the tool never invokes an LLM (ADR-0010).

## Behavior

### Joint loading produces one VersaillesContext

- **Given** a `.versailles/` workspace with all three data files present
- **When** the loader runs
- **Then** it returns a single `VersaillesContext` with config, contracts, manifests, predicates, `parsedContracts` (contract ID → AST), `parseErrors`, `validationErrors`, `validationWarnings`, and an `isValid` flag that aggregates all hard errors — no file is interpreted on its own (build-spec §6)

### No version gates — a version-less config is the valid default

- **Given** a `config.json` without `grammarVersion`/`schemaVersion`, and workspace files without per-file `version` fields
- **When** any tool (parser, validator, generator) loads the workspace
- **Then** loading succeeds with no version error — the config's `$schema` pointer names `config.schema.json` as the machine-checkable format source, and the tool version lives in the binary (`versailles -v` / `--version`) (ADR-0018, build-spec §3.1)

### Deprecated version fields still load (deprecate-don't-remove)

- **Given** a pre-migration workspace file still carrying `grammarVersion`/`schemaVersion` or a `version` field
- **When** the loader runs
- **Then** the file loads permissively with no `VERSION_MISMATCH` — deprecated fields stay parseable until a tool-driven `migrate` rewrites them (ADR-0018, ADR-0004)

### The seeded config `$schema` pointer resolves to the project-root schema (VERSAILLES-187)

- **Given** a freshly initialized workspace (`versailles init` seeded `.versailles/config.json`)
- **When** the config's `$schema` pointer is resolved relative to `.versailles/config.json`
- **Then** it resolves to the real schema at the project root (`<project>/config.schema.json`) — editor/tooling JSON-schema validation is live, never dead; the pointer never resolves one level above the project root (ADR-0018, build-spec §3.1; VERSAILLES-187)

### Config is machine-checkable against the ADR-0009 matrix

- **Given** `config.json` with `testFramework: "jest"` (or any value outside `vitest | xunit | pytest`, or a `language` outside `typescript | csharp | python`)
- **When** `config.schema.json` validation runs
- **Then** configuration is rejected as invalid; `testFramework: "vitest"` / `language: "typescript"` is accepted (ADR-0009)

### Scoped extraction gives a sub-object view, never the whole file

- **Given** a component or component.operation name
- **When** the scoped extraction helper is called
- **Then** it returns just that sub-object plus its errors/warnings — the scoped view `validate --verbose` shows (build-spec §6.6)

### CI check exit codes distinguish clean, invalid, and stale

- **Given** a workspace with parse or validation errors, a workspace with stale hashes, and a clean workspace
- **When** `versailles check` runs against each
- **Then** parse/validation errors exit `1`; staleness exits `2` when `staleness.blockOnStale` is true and warns with exit `0` when it is false; a clean workspace exits `0` (build-spec §8)

### One shared loader, never re-implemented

- **Given** multiple consuming components (CLI commands, CI lint, generator) that need the workspace
- **When** each loads the context
- **Then** every component goes through this single loader module — no component re-implements loading or cross-referencing independently (build-spec §6)

### Loader surfaces store metadata for downstream consumers

- **Given** a `manifests.json` entry carrying `sourcePath` and `methods`
- **When** the loader runs
- **Then** both fields surface on the `ManifestsFile` entry in the loaded context — the generate handler and emitters can read module import paths and call shape directly; legacy entries lacking them load unchanged and are preserved as-is, and a present empty `methods` map (`{}` — the refreshed-entry zero-methods signal) is surfaced exactly as stored, never stripped and never flagged INVALID_SHAPE (build-spec §3.3, §7; VERSAILLES-25 follow-up)

## Constraints

- `must_not` interpret any of the three top-level data files in isolation — they are loaded as one unit (build-spec §2).
- `must_not` gate on versions — there are no `grammarVersion`/`schemaVersion` fields to check and no `VERSION_MISMATCH` path (ADR-0018); a version-less config is the valid default, and deprecated fields still load permissively.
- `must_not` accept `language`/`testFramework` values outside the ADR-0009 enum matrix — `jest` is rejected; `vitest` is accepted (ADR-0009).
- `must_not` let consumers re-implement loading — the shared loader is the only path into the context (build-spec §6).
- `must_not` return a whole file from scoped extraction — always the single sub-object plus its errors (build-spec §6.6).
- `must_not` fail `versailles check` on staleness when `staleness.blockOnStale` is false — it warns and exits `0` (build-spec §8).
- `must_not` require `sourcePath`/`methods` on any manifests entry — legacy entries lacking them load normally and are preserved as-is; recording them is manifest-extraction's job, not the loader's. The loader `must_not` strip or invent a `methods` key either — a present empty map (`{}` — the refreshed-entry zero-methods signal) is surfaced exactly as stored (VERSAILLES-25 follow-up).
- `must_not` invoke an LLM anywhere in loading or checking (ADR-0010).

## Non-Goals

- No implementation of the grammar/parser/validator rules themselves (contract-language).
- No manifest derivation from source (manifest-extraction).
- No recording or derivation of `sourcePath`/method metadata (manifest-extraction) — this context only loads and surfaces them.
- No test-case planning or test emission (deterministic-generation).
- No review UI or merge-on-approval implementation — retired by ADR-0012; the git commit is the approval.
- No LLM client, prompt templates, or in-tool LLM invocation (ADR-0010).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-09-04 | maintainer | Beta triage (VERSAILLES-187): the seeded `config.json` `$schema` pointer resolves to the project-root `config.schema.json` — editor validation is live, never dead |
| 2026-08-11 | maintainer | Initial draft from build-spec §2, §3.1, §6, §8; ADR-0009/0010 |
| 2026-08-13 | maintainer | Removed Linked Plans section — execution plans are tracked outside the public repo |
| 2026-08-17 | maintainer | Acknowledged the manifests.json store entry shape — `sourcePath` (never empty for covered entries; legacy entries lacking it preserved as-is) and per-component `methods` metadata — and that the loader surfaces both on `ManifestsFile` entries for downstream consumers (generate handler → emitter modulePaths + call shape). Aligns with the manifest-extraction/deterministic-generation extension (fix/generator-emitter-runnability) |
| 2026-08-18 | maintainer | Mirrored the review-warning contract follow-up (fix/generator-emitter-runnability): the store shape's `methods` key is always present on refreshed entries — possibly `{}`, the first-class zero-methods signal — with only preserved legacy entries allowed to lack it; the loader surfaces a present empty map exactly as stored, never stripping or inventing it (VERSAILLES-25 follow-up) |
| 2026-08-20 | maintainer | Lifecycle flipped draft → implemented: context shipped and verified for beta |
| 2026-08-30 | maintainer | Reconcile with ADR-0018 (VERSAILLES-168 Phase 2/3 follow-up): removed the version-gate behavior/constraint/scope coverage — no grammarVersion/schemaVersion checks, no VERSION_MISMATCH; version-less config is the valid default, `$schema` pointer names `config.schema.json`, deprecated fields load permissively (deprecate-don't-remove) |