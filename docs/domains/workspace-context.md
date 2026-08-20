# Domain: Workspace Context

**Bounded context:** `workspace-context`

## Responsibility (what this context owns)

The `.versailles/` workspace as a **versioned, jointly-loaded unit** — the shared kernel every other context depends on (build-spec §2, §6):

- Loading and JSON-parsing all four top-level files (`config.json`, `contracts.json`, `manifests.json`, `predicates.json`) together — no file is valid to interpret in isolation.
- The **version gates**: `config.grammarVersion` / `config.schemaVersion` checked by every tool before processing; mismatch is a hard error with an upgrade-path message, never a silent best-effort parse.
- Producing a single `VersaillesContext` object: config, contracts, manifests, predicates, parsed ASTs, parse errors, validation errors/warnings, and an `isValid` flag.
- The **scoped extraction** helper: given a component/operation name, return just that sub-object plus its errors — what the human review UI shows.
- Orchestrating the CI-mode checks: `versailles check` runs the loader, fails on parse/validation errors, recomputes `sourceHash` for every manifest entry, predicate, and contract operation, and compares against stored hashes (blocking per `config.staleness.blockOnStale`, exit code `2`).

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

**Config** (value object) — `grammarVersion`, `schemaVersion`, `sourceRoots`, `language`, `testFramework`, `generatedDir`, `staleness.blockOnStale`, `rejection.idiom`.

**Workspace** (the `.versailles/` directory) — the file set treated as one unit.

**StalenessReport** (value object) — the `versailles check` outcome: list of stale IDs (or warning report). Distinct exit codes: `0` clean, `1` parse/validation error, `2` staleness violation when blocking.

## Ubiquitous language

Uses from [glossary](../glossary.md): *`.versailles/` workspace, VersaillesContext, version gate, scoped extraction, exit code, rejected command*. A "config file" is a *config* entry in the workspace; "loading" is *joint loading* of the unit.

## Domain events

- `contextLoaded` — a `VersaillesContext` was produced for the current workspace state.
- `contractInvalid` — surfaced to commands that must reject (validate/check/generate).

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Upstream of | contract-language | Provides the full context the semantic validator needs; also consumes its parser/validator to build `parsedContracts` and validation results. |
| Upstream of | deterministic-generation | Generation runs only against a context where `isValid: true`. |
| Upstream of | external agent (via CLI) | Supplies the manifest entry + predicate registry an external agent is grounded on through command output. |
| Upstream of | review | Scoped extraction gives the reviewer a scoped diff, never the whole file. |
| Downstream of | review | The reviewer's single-object merge writes back into `contracts.json` inside the workspace. |
| Downstream of | manifest-extraction | `manifestUpdated` writes `manifests.json` into the workspace. |
| Upstream of | (CLI) | `versailles init` scaffolds the workspace; `versailles check` uses the loader for CI-mode validation + staleness. |

## Business rules

- The four top-level files are versioned together and loaded as one unit — never interpret one file in isolation (build-spec §2).
- Grammar/schema version mismatch is a **hard error with an upgrade-path message** (build-spec §3.1).
- Scoped extraction returns one component/operation sub-object plus its errors — reviewers see a scoped diff, not the whole file (build-spec §6).
- `versailles check` fails on non-empty `parseErrors`/`validationErrors`; staleness blocks only when `staleness.blockOnStale` is true, else warns with exit `0` (build-spec §8).

## Open questions

- Whether `versailles init` also seeds a starter config or only scaffolds empty/default files (build-spec §12 lists empty/default).

## Source of authority

[build-spec.md §2, §3.1, §6, §8, §12](../build-spec.md) · [ADR-0008 language-agnostic core](../decisions/0008-language-agnostic-core-pluggable-plugins.md) · [Spec: Versailles contract pipeline](../specs/versailles.md)