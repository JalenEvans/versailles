# Contract Summary: Workspace Context

**Machine contract:** [workspace-context.contract.yaml](workspace-context.contract.yaml)
**Spec:** [docs/specs/workspace-context.md](../specs/workspace-context.md)
**Status:** draft · **Validated:** pass

## What this context does

Workspace context owns the `.versailles/` directory — `config.json`, `contracts.json`
(with its top-level `predicates` map), `manifests.json` — as a **jointly-loaded
unit**. Because contracts reference manifests and predicates by name, no file is ever valid
to interpret on its own. The loader is the single shared entry point every component uses;
nobody re-implements loading.

## What it guarantees (must)

- All three data files are read and parsed together; one `VersaillesContext` object comes out with
  parsed ASTs, errors, warnings, and an aggregated `isValid` flag.
- Format policy (ADR-0018): **no version gates** — `grammarVersion` / `schemaVersion` and the
  per-file `version` fields are removed; `config.json` carries a `$schema` pointer to
  `config.schema.json`; the tool version lives in the binary (`versailles -v` / `--version`);
  deprecated fields still load permissively until `migrate` rewrites them.
- Config is machine-checkable against the ADR-0009 matrix: `language` accepts
  `typescript | csharp | python`, `testFramework` accepts `vitest | xunit | pytest`.
  **`jest` is rejected; `vitest` is accepted.**
- The scoped extraction helper returns just one component/operation sub-object plus its
  errors — what `validate --verbose` shows, never a whole file.
- `versailles check` distinguishes clean (`0`), parse/validation error (`1`), and blocking
  staleness (`2`); non-blocking staleness warns and still exits `0`.
- The store shape's `methods` key is always present on **refreshed** entries — possibly
  `{}`, the first-class zero-methods signal — with only preserved legacy entries allowed to
  lack it; a present empty map is surfaced exactly as stored, never stripped or flagged
  INVALID_SHAPE (VERSAILLES-25 follow-up).

## What it forbids (must not)

- No interpreting any file in isolation; no version-gate enforcement — deprecated
  `grammarVersion` / `schemaVersion` / `version` fields load permissively until `migrate`
  rewrites them (deprecate-don't-remove).
- No accepting config values outside the ADR-0009 matrix.
- No consumer re-implementing loading; no whole-file returns from scoped extraction.
- No failing `check` on staleness when `blockOnStale` is false; no LLM anywhere in loading
  or checking.

## Grounding

[build-spec §2, §3.1, §6, §8](../build-spec.md) · ADR-0009 (language/framework matrix) ·
ADR-0010 (no in-tool LLM) · ADR-0018 (additive-only format policy)