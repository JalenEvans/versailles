# ADR: Additive-only format versioning — remove per-file versions, collapse the version gates, tool version to the binary

**ID:** ADR-0018
**Date:** 2026-08-30
**Status:** accepted
**Owner:** associate-head-coach
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

The workspace format carries three version-ceremony mechanisms that never earned their keep:

1. **Per-file `version` fields.** Every workspace file (`config.json`, `contracts.json`, `manifests.json`, and the internal `PredicatesFile` shape) declares a top-level `version` string. No loader path branches on the stored value — the field can only equal the single supported constant or fail. It is hand-maintained, duplicated across every file, and provides no forward-compatibility information: a future format change is a coordinated breaking bump across the whole workspace, and the only way to discover "what format is this?" is to open a file. ADR-0013 already retired `predicates.json` from the versioned set, but left a `sourceHash: ""` vestige in the `PredicatesFile` shape "for backward compatibility with the validator" — a string that is always empty and never read.

2. **The `grammarVersion`/`schemaVersion` gates.** `config.json` carries both fields; the loader (packages/core/src/loader/workspace.ts) checks each against a supported constant and emits `VERSION_MISMATCH` on mismatch. Both fields have been `"1.0"` since `init` and have **never moved independently** — two gates pretending to be two knobs that are really one. They are the only version signal a user can see, and they say nothing about the workspace *format*.

3. **Tool version is undiscoverable.** The `versailles` binary has no `-v`/`--version` flag; the only version a user can inspect is the format version embedded in their config. Version identity and format identity are conflated.

The real question — *"what happens when the format evolves?"* — is unanswered by a field that must be bumped by hand across every file. The industry has converged elsewhere: Docker Compose dropped its `version` field (it was always optional and confusing), and the JSON ecosystem replaced version fields with `$schema` pointers that give editors and validators a single machine-checkable source of truth. Phase 1 of the Option 1 Wave (VERSAILLES-168/169) decides the policy; the mechanical removal of the fields is implementation follow-through.

## Decision Drivers

- **One source of version truth:** tool version lives in the binary; workspace format is derivable from a `$schema` pointer. No hand-maintained per-file version fields.
- **Additive-only evolution:** readers must never break; a file written against an older format stays loadable after a format change.
- **Deprecate-don't-remove:** deprecated fields stay parseable (the loader's permissive typing, ADR-0004, already tolerates unknown keys) until a tool-driven `migrate` rewrites old files.
- **Determinism preserved (ADR-0002):** the format policy must not change generation-time purity — same contract in, byte-identical suite out.
- **No LLM in the pipeline (ADR-0010):** a `--version` flag is a static print of a compile-time constant — trivially within the "CLI never drives an LLM" rule.
- **Frozen surface already assumed additive (build-spec §4.3, §5.2):** the expression grammar / AST node set is frozen and the structured error contract shape is stable — the policy formalizes what the build-spec already assumes rather than rewriting it.
- **Simplicity:** two gates that never moved independently collapse into one ceremony-free mechanism.

## Considered Options

- **Option A — Additive-only format policy; remove per-file versions; collapse the gates; `$schema` pointer; tool version via `-v`/`--version` (chosen)** — the workspace format evolves only by adding fields (never removing or changing meaning); config.json gains a `"$schema": "../../config.schema.json"` pointer (local relative path from `.versailles/config.json` to the repo-root schema) as the version ceremony replacement; `grammarVersion`/`schemaVersion` and the per-file `version` fields are removed; the `sourceHash: ""` vestige is deleted; a future `migrate` command rewrites old files and the loader tolerates deprecated fields until then.
- **Option B — Keep per-file `version` fields with strict equality (status quo)** — every future format change is a breaking change requiring coordinated bumps across all workspace files; the fields remain dormant, hand-maintained, and uninformative about forward compatibility.
- **Option C — Keep version gates but unify into a single `formatVersion`** — less ceremony than today (one knob instead of two), but still a hand-maintained, breaking-change cliff and no answer to "what happens when the format evolves?".
- **Option D — Semantic-version the whole workspace** — a single `workspaceVersion` with range matching against the tool. Elegant on paper, but over-engineered: nothing consumes ranges, and a single tool/format pair does not need a compatibility matrix.

## Decision Outcome

Chosen option: **Option A — additive-only format evolution, deprecate-don't-remove, tool-driven `migrate`, per-file versions removed, the two version gates collapsed into a `$schema` pointer, and the tool version moved to the binary (`versailles -v` / `--version`)** — **because** it makes readers unbreakable by policy (additive-only), removes the only hand-maintained version bookkeeping in the workspace, gives editors and the validator a single machine-checkable source of truth (`$schema`), makes tool version discoverable without reading a workspace file, and — critically — it is a formalization of the loader's existing permissive behavior (ADR-0004 unknown-key tolerance), not a rewrite. The `grammarVersion`/`schemaVersion` `VERSION_MISMATCH` branches are removed with the fields; the structured error contract shape (build-spec §5.2) is unchanged — no new fields, no reshaped errors. The `sourceHash: ""` vestige in the `PredicatesFile` shape is deleted along with the backward-compat comment that justified it. Until `migrate` ships, the loader keeps accepting files that still carry the removed fields — deprecated fields stay parseable.

### Consequences

- **Positive:** one source of version truth (binary for tool, schema pointer for format); future format changes are cheap — add fields, never remove, never break a reader; editors and validators get `$schema`-driven checking instead of a string comparison; the dormant `sourceHash: ""` vestige is deleted; the two never-independent gates stop pretending to be independent.
- **Negative:** format drift detection becomes schema-validation-based rather than a single hard equality error code — a schema error is more diffuse than one `VERSION_MISMATCH`; a truly old file (pre-removal) is loaded permissively rather than rewritten until `migrate` ships, so the cleanup of legacy files is deferred tool work rather than an immediate gate.
- **Neutral:** `config.schema.json` gains a stable home at the repo root and `init` writes the `$schema` pointer; the loader drops two error branches and three `version` fields; the workspace-context spec and contract need updating to reflect the removed fields and the additive policy; ADR-0013's backward-compat comment in the `PredicatesFile` shape is resolved.

### Confirmation

- The loader shapes in `packages/core/src/loader/workspace.ts` (`Config`, `ContractsFile`, `ManifestsFile`, `PredicatesFile`) carry no `version` field; `PredicatesFile` has no `sourceHash` field (the `""` vestige is gone).
- The loader has no `grammarVersion`/`schemaVersion` `VERSION_MISMATCH` branches; `SUPPORTED_GRAMMAR_VERSION` / `SUPPORTED_SCHEMA_VERSION` constants are removed; the structured error shape (build-spec §5.2) is otherwise unchanged.
- `config.schema.json` exists at the repo root; example `config.json` files and `versailles init` output carry `"$schema": "../../config.schema.json"`.
- `versailles -v` and `versailles --version` print the tool version and exit 0 — a static print with no LLM involvement (ADR-0010).
- A pre-migration workspace file (one still carrying `version` / `grammarVersion` / `schemaVersion`) loads without error — deprecate-don't-remove holds until `migrate` rewrites it.
- `scripts/validate-docs.sh` and `scripts/validate-contracts.sh` pass after the doc/contract/spec updates.

## More Information / Links

- Plan: VERSAILLES-168/169 (Option 1 Wave, Phase 1) — Llama
- Retains: [ADR-0002](0002-deterministic-generation-llm-authoring-only.md) (generation-time determinism) · [ADR-0010](0010-cli-never-drives-llm.md) (`--version` is a static print) · [ADR-0004](0004-permissive-manifest-typing.md) (unknown-key tolerance underpins deprecate-don't-remove)
- Related: [ADR-0013](0013-declarative-predicates-remove-registration-cli.md) (retired `predicates.json` from the versioned set; `sourceHash` vestige cleaned up here)
- [Build spec §3 workspace files](../build-spec.md#3-workspace-files) · [§4.3 AST node types (frozen)](../build-spec.md#43-ast-node-types-parser-output-contract) · [§5.2 Validator output contract](../build-spec.md#52-validator-output-contract)
- Research grounding: Docker Compose removed its `version` field; the JSON ecosystem converged on `$schema` pointers as the version ceremony replacement

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-30 | associate-head-coach | Initial proposal |
| 2026-08-30 | associate-head-coach | Accepted by Head Coach |