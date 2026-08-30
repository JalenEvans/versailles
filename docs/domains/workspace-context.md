# Domain: Workspace Context

**Bounded context:** `workspace-context`

## Responsibility (what this context owns)

The `.versailles/` workspace as a **jointly-loaded unit** under the additive-only format policy (ADR-0018) — the shared kernel every other context depends on (build-spec §2, §6):

- Loading and JSON-parsing all three top-level data files (`config.json`, `contracts.json` with its top-level `predicates` map, `manifests.json`) together — no file is valid to interpret in isolation.
- The **`$schema` pointer / additive-only format policy**: no version gates — `grammarVersion`/`schemaVersion` and the per-file `version` fields are removed (ADR-0018); `config.json` carries a `$schema` pointer to `config.schema.json`; the tool version lives in the binary (`versailles -v` / `--version`).
- Producing a single `VersaillesContext` object: config, contracts, manifests, predicates, parsed ASTs, parse errors, validation errors/warnings, and an `isValid` flag.
- The **scoped extraction** helper: given a component/operation name, return just that sub-object plus its errors — what `validate --verbose` shows.
- Orchestrating the CI-mode checks: `versailles check` runs the loader, fails on parse/validation errors, recomputes `sourceHash` for every manifest entry and contract operation, and compares against stored hashes (blocking per `config.staleness.blockOnStale`, exit code `2`).

## Domain model

**VersaillesContext** (aggregate result object) — the merged view of the workspace:

```
{
  config, contracts, manifests, predicates,
  parsedContracts: { [contractId]: AST },
  parseErrors: [...],
  validationErrors: [...],
  validationWarnings: [...],
  isValid: boolean
}
```

**Config** (value object) — `$schema` pointer, `sourceRoots`, `language`, `testFramework`, `generatedDir`, `staleness.blockOnStale`, `rejection.idiom`.

**Workspace** (the `.versailles/` directory) — the file set treated as one unit.

**StalenessReport** (value object) — the `versailles check` outcome: list of stale IDs (or warning report). Distinct exit codes: `0` clean, `1` parse/validation error, `2` staleness violation when blocking.

## Ubiquitous language

Uses from [glossary](../glossary.md): *`.versailles/` workspace, VersaillesContext, scoped extraction, exit code, rejected command*. A "config file" is a *config* entry in the workspace; "loading" is *joint loading* of the unit.

## Domain events

- `contextLoaded` — a `VersaillesContext` was produced for the current workspace state.
- `contractInvalid` — surfaced to commands that must reject (validate/check/generate).

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Upstream of | contract-language | Provides the full context the semantic validator needs; also consumes its parser/validator to build `parsedContracts` and validation results. |
| Upstream of | deterministic-generation | Generation runs only against a context where `isValid: true`. |
| Upstream of | (CLI) | `versailles init` scaffolds the workspace; `versailles check` uses the loader for CI-mode validation + staleness. |
| Downstream of | manifest-extraction | `manifestUpdated` writes `manifests.json` into the workspace. |

## Business rules

- The three top-level data files are loaded as one unit — never interpret one file in isolation (build-spec §2).
- No version gates: `grammarVersion`/`schemaVersion` and the per-file `version` fields are **removed** (ADR-0018); `config.json` carries a `$schema` pointer to `config.schema.json`, the tool version lives in the binary (`versailles -v` / `--version`), and deprecated fields still load permissively until `migrate` rewrites them.
- Scoped extraction returns one component/operation sub-object plus its errors — `validate --verbose` shows a scoped view, not the whole file (build-spec §6).
- `versailles check` fails on non-empty `parseErrors`/`validationErrors`; staleness blocks only when `staleness.blockOnStale` is true, else warns with exit `0` (build-spec §8).

## Open questions

- Whether `versailles init` also seeds a starter config or only scaffolds empty/default files (build-spec §12 lists empty/default).

## Source of authority

[build-spec.md §2, §3.1, §6, §8, §12](../build-spec.md) · [ADR-0018 additive-only format versioning](../decisions/0018-additive-only-format-versioning.md) · [ADR-0008 language-agnostic core](../decisions/0008-language-agnostic-core-pluggable-plugins.md) · [Spec: Versailles contract pipeline](../specs/versailles.md)