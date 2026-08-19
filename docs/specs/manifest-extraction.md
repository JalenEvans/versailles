# Spec: Manifest Extraction

**ID:** SPEC-me
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** data (the field manifest is `manifests.json`, the grounding layer everything downstream reads), public-api (the extractor plugin seam and the `versailles extract-manifests` command surface)
**Linked contract:** `docs/contracts/manifest-extraction.contract.yaml`
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

Manifest extraction derives the grounding layer for the whole pipeline — `manifests.json` (build-spec §3.3) — from real source code via per-language extractor plugins (ADR-0008), with TypeScript first using `ts.createProgram` + the type checker (ADR-0005, ADR-0009). It applies the `typeRef` grammar (generics → `list<T>`, literal unions → `enum<...>`, nested/related types added transitively to the flat map) and computes structural `sourceHash` values from the sorted field name+type pairs plus sorted method-signature records — never method bodies — so body-only edits never trigger false staleness (build-spec §7). Each entry records per-component method metadata (method name, static/instance, ordered param names, return type where determinable) and the `sourcePath` of the file it was extracted from — project-root-relative with POSIX separators (e.g. `src/order.ts`), never source-root-relative and never absolute — so downstream emitters can render shape-aware calls against real modules and derive import specifiers that resolve to them (build-spec §3.3, §7; VERSAILLES-24). Every entry refreshed by an extract run always carries the `methods` key — possibly `{}`, the first-class zero-methods signal that keeps the planner's `UNPLANNABLE_OPERATION` guard firing — and only preserved legacy entries the extractor never touched may lack it (VERSAILLES-25 follow-up). When no project root is derivable (projectRoot omitted and the source roots share no common prefix), the `sourcePath` fallback is the file relative to `sourceRoots[0]` when that yields a relative path, or omission of the field — never the absolute file path (VERSAILLES-24 follow-up). Extraction is static-analysis-first and permissive: fields whose types can only be inferred are flagged low-confidence and warn rather than block (ADR-0004). Manifests are derived artifacts — an external agent may author or update manifests via the CLI, but the tool itself never invokes an LLM (ADR-0010, ADR-0005).

## Scope

**In scope:**
- The extractor plugin seam selected by `config.language`, with no language-specific code in the core (ADR-0008).
- The TypeScript extractor via the TypeScript compiler API (`ts.createProgram`, type checker) — the first target per ADR-0009, resolving field types to the `typeRef` grammar.
- `typeRef` grammar application (build-spec §3.3): `string | number | boolean | <ComponentName> | list<typeRef> | optional<typeRef> | enum<v1,v2,...>`; TS generics → `list<T>`; unions of literal types → `enum<...>`; nested/related types added to the flat manifest map transitively so `order.items[].sku` resolves via a `OrderItem` entry in the same map.
- Structural `sourceHash` computation: hash of the sorted field name+type pairs plus sorted method-signature records, never the full source file and never method bodies (build-spec §7, ADR-0005).
- Per-component method metadata recording: method name, static/instance, ordered param names, and return type where determinable, for every resolvable method (build-spec §7). A refreshed entry always persists the `methods` key — even `{}` when the component has zero methods, the first-class zero-methods signal that distinguishes it from a preserved legacy entry the extractor never touched (VERSAILLES-25 follow-up).
- `sourcePath` persistence through the `manifests.json` store: every covered entry carries the source path it was extracted from, expressed **project-root-relative with POSIX separators** (e.g. `src/order.ts` — never source-root-relative `order.ts` and never absolute), so the loader and generator can derive real module import paths that resolve against the workspace root (build-spec §3.3, §7; VERSAILLES-24). When no project root is derivable (projectRoot omitted and the source roots share no common prefix), the fallback is the file relative to `sourceRoots[0]` when that yields a relative path, or omission of the field — never the absolute file path (VERSAILLES-24 follow-up).
- Permissive typing policy: inferred/low-confidence fields emit a non-blocking warning and never produce a hard error (ADR-0004).
- `versailles extract-manifests` behavior: update entries for covered components, preserve entries for components not covered by the current scan, and remove only via the explicit `--prune` flag — never implicitly (build-spec §7).
- Scanning only within `config.sourceRoots`.
- External-agent authored/updated manifests, verified against real source before writing — the tool never invokes an LLM (ADR-0010, ADR-0005).

**Out of scope:**
- Semantic validation of contracts that consume manifests (contract-language).
- The staleness *check* flow that recomputes and compares hashes (`versailles check`, exit codes) — workspace-context orchestrates it; this context only computes hashes.
- Extractors for C# and Python within the first implementation milestone — the seam exists for all three (ADR-0009 matrix), but sequencing makes TypeScript first.
- Predicate registry tooling, even where it reuses static-analysis seams (build-spec §13 milestone 8 is a later step).
- Any LLM-driven extraction inside the tool — LLM assistance exists only as an external-agent loop, mechanically verified against source before `manifests.json` is written (ADR-0005 clarification, ADR-0010).
- No method-body analysis — only method signatures (name, static/instance, params, return type) are recorded; bodies never enter the manifest or the hash.

## Behavior

### TypeScript source produces a correct manifest

- **Given** a TypeScript class/interface with declared fields and `config.language: "typescript"`, `config.sourceRoots` covering it
- **When** `versailles extract-manifests` runs
- **Then** `manifests.json` gains/updates an entry for that component with fields mapped to `typeRef`s — TS generics as `list<T>`, literal unions as `enum<...>` — any nested/related types added to the flat manifest map transitively, and only files under `config.sourceRoots` are scanned (build-spec §3.3, glossary: source root)

### Body-only edits do not change the structural hash

- **Given** a manifest entry whose `sourceHash` was computed from a component's field set + method signatures
- **When** only method bodies change (the field set and method signatures are unchanged)
- **Then** recomputing the `sourceHash` yields the stored value — no false staleness (build-spec §7)

### Structural edits change the hash and are detectable

- **Given** a manifest entry with a stored `sourceHash`
- **When** a field is added, removed, or retyped, or a method signature changes (name, static/instance, params, return type)
- **Then** the recomputed `sourceHash` differs from the stored one, and the drift is detectable by `versailles check` (build-spec §8)

### Method metadata is recorded with call-shape fidelity

- **Given** a TypeScript component with instance and static methods (e.g. `placeOrder(x)` instance, `create(...)` static), covered by `config.sourceRoots`
- **When** `versailles extract-manifests` runs
- **Then** the manifest entry records each method's name, static/instance flag, ordered param names, and return type where determinable (build-spec §7) — so the generator can render shape-aware calls

### sourcePath persists through the store

- **Given** a component covered by the current scan
- **When** `versailles extract-manifests` writes/updates `manifests.json`
- **Then** the entry carries the `sourcePath` of the file it was extracted from, **project-root-relative with POSIX separators** (`src/order.ts`, never `order.ts` and never absolute) — never an empty string for covered entries; legacy entries lacking one are preserved as-is (build-spec §3.3; VERSAILLES-24)

### The disjoint-roots sourcePath fallback never emits an absolute path

- **Given** a scan where `projectRoot` is omitted and the source roots share no common directory prefix (disjoint roots), so no project root is inferable
- **When** `versailles extract-manifests` records a covered component's `sourcePath`
- **Then** the fallback is the file relative to `sourceRoots[0]` when that yields a relative path, or the `sourcePath` field is omitted — the absolute file path is never emitted (VERSAILLES-24 follow-up)

### Refreshed entries always carry the methods key, empty or not

- **Given** a covered component with zero methods (a freshly-extracted/refreshed entry), alongside preserved legacy entries the extractor never touched
- **When** `versailles extract-manifests` writes/updates `manifests.json`
- **Then** the refreshed entry persists `methods: {}` — the first-class "we know this component has zero methods" signal — so it is never indistinguishable from a preserved legacy entry; only preserved legacy entries may lack the `methods` key (VERSAILLES-25 follow-up)

### Inferred types warn, they never block

- **Given** a field whose type can only be inferred, not declared (dynamically-typed source)
- **When** extraction runs and the manifest is loaded/validated
- **Then** the field is flagged low-confidence, a non-blocking warning is surfaced, and there is no hard error purely from the inference uncertainty (ADR-0004)

### Uncovered entries are preserved; removal is explicit only

- **Given** `manifests.json` with an entry for a component not covered by the current scan
- **When** `versailles extract-manifests` runs without `--prune`
- **Then** the entry is preserved; with `--prune` the stale entry is removed explicitly — never implicitly (build-spec §7)

### The tool never invokes an LLM to produce manifests

- **Given** an extractor run
- **When** it scans source and writes `manifests.json`
- **Then** it uses static analysis APIs only — there are no LLM call sites in the tool; an external agent may author/update manifests via the CLI, mechanically verified against actual source (ADR-0005 clarification, ADR-0010)

## Constraints

- `must_not` treat manifests as a hand-authored source of truth — they are derived artifacts produced by static analysis (build-spec §3.3, ADR-0005).
- `must_not` compute `sourceHash` over the full source file or method bodies — structural shape only (sorted field name+type pairs + sorted method-signature records) so unrelated body edits don't trigger false staleness (build-spec §7, ADR-0005).
- `must_not` prune manifest entries implicitly — removal happens only via the explicit `--prune` flag (build-spec §7).
- `must_not` scan outside `config.sourceRoots` (glossary: source root).
- `must_not` invoke an LLM anywhere in extraction — no LLM client, no prompting logic, no retry loop (ADR-0010); any LLM-assisted path must include a mechanical verification gate against real source before writing (ADR-0005).
- `must_not` let a low-confidence/inferred field cause a hard type-compatibility error — that tier warns but never blocks (ADR-0004).
- `must_not` write a covered manifest entry with an empty `sourcePath` — a missing path is a legacy-entry condition, never a silent empty string (build-spec §3.3).
- `must_not` record `sourcePath` relative to a source root (`order.ts` for `src/order.ts`) or as an absolute path — the canonical semantic is project-root-relative with POSIX separators (`src/order.ts`) (VERSAILLES-24). The no-project-root/disjoint-roots fallback is `relative(sourceRoots[0], file)` when derivable, or omission of the field — the absolute file path is never emitted (VERSAILLES-24 follow-up).
- `must_not` omit the `methods` key from a refreshed covered entry with zero methods — an empty map `{}` must be persisted as the first-class zero-methods signal; omitting the key is reserved for preserved legacy entries the extractor never touched (VERSAILLES-25 follow-up).
- `must_not` silently drop unresolvable method signatures — they follow the permissive policy and surface a warning (ADR-0004).
- `must_not` place language-specific extraction code in the core — all extraction lives behind the `ExtractorPlugin` seam (ADR-0008).

## Non-Goals

- No C# (Roslyn) or Python (`ast`) extractor implementations in the first milestone — TypeScript + vitest is sequenced first per ADR-0009; the seam exists for all three from day one.
- No automated purity/termination analysis for predicates (that is the registration-time `verifiedPure` gate, contract-language / ADR-0006).
- No SMT-backed generation or witness synthesis (v2, build-spec §9.5).
- No LLM client, prompt templates, or in-tool LLM extraction (ADR-0010).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build-spec §3.3, §7; ADR-0004/0005/0008/0009/0010 |
| 2026-08-13 | associate-head-coach | Removed Linked Plans section — execution plans are tracked outside the public repo |
| 2026-08-17 | general-manager | Mirrored contract changes (PR fix/generator-emitter-runnability): method metadata recording, sourcePath persistence, sourceHash covers sorted field pairs + sorted method-signature records (method bodies still excluded) — backs VERSAILLES-20/21 |
| 2026-08-18 | general-manager | Pinned the canonical sourcePath semantic (VERSAILLES-24): covered entries store project-root-relative POSIX paths (src/order.ts), never source-root-relative and never absolute — so the generator's join(cwd, sourcePath) resolves to the real source file |
| 2026-08-18 | general-manager | Mirrored the review-warning contract follow-ups (fix/generator-emitter-runnability): (W3/VERSAILLES-25) refreshed entries always persist the methods key — possibly {} — as the first-class zero-methods signal, only preserved legacy entries may lack it; (W2/VERSAILLES-24) the disjoint-roots sourcePath fallback is relative(sourceRoots[0], file) or omission of the field — never the absolute file path |