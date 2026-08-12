# Contract Summary: Workspace Context

**Machine contract:** [workspace-context.contract.yaml](workspace-context.contract.yaml)
**Spec:** [docs/specs/workspace-context.md](../specs/workspace-context.md)
**Status:** draft · **Validated:** pending

## What this context does

Workspace context owns the `.versailles/` directory — `config.json`, `contracts.json`,
`manifests.json`, `predicates.json` — as a **versioned, jointly-loaded unit**. Because
contracts reference manifests and predicates by name, no file is ever valid to interpret on
its own. The loader is the single shared entry point every component uses; nobody re-implements
loading.

## What it guarantees (must)

- All four files are read and parsed together; one `VersaillesContext` object comes out with
  parsed ASTs, errors, warnings, and an aggregated `isValid` flag.
- Version gates: `grammarVersion` / `schemaVersion` mismatches are **hard errors with an
  upgrade-path message** — never a silent best-effort parse.
- Config is machine-checkable against the ADR-0009 matrix: `language` accepts
  `typescript | csharp | python`, `testFramework` accepts `vitest | xunit | pytest`.
  **`jest` is rejected; `vitest` is accepted.**
- The scoped extraction helper returns just one component/operation sub-object plus its
  errors — what the human review UI shows, never a whole file.
- `versailles check` distinguishes clean (`0`), parse/validation error (`1`), and blocking
  staleness (`2`); non-blocking staleness warns and still exits `0`.

## What it forbids (must not)

- No interpreting any file in isolation; no silent version-mismatch parsing.
- No accepting config values outside the ADR-0009 matrix.
- No consumer re-implementing loading; no whole-file returns from scoped extraction.
- No failing `check` on staleness when `blockOnStale` is false; no LLM anywhere in loading
  or checking.

## Grounding

[build-spec §2, §3.1, §6, §8](../build-spec.md) · ADR-0009 (language/framework matrix) ·
ADR-0010 (no in-tool LLM)