# Architecture — Versailles

How the [bounded contexts](../domains/index.md) interact. The vocabulary is the shared [ubiquitous language](../glossary.md).

## The pipeline at a glance

```
 source code
      │  (manifest-extraction: extractor plugin per config.language — ADR-0008/0009)
      ▼
  manifests.json ──►  .versailles/ workspace (loaded as one unit)
                         │  (workspace-context: joint load, no version gates)
                         ▼
                   VersaillesContext (isValid?)
                         │
         ┌───────────────┼──────────────────────────────┐
         ▼               ▼                              ▼
  contract-language  deterministic-generation   validate / check
  (parse + validate)  (requires isValid: true)   (CLI surface — the
         │               │                        tool never invokes
  structured errors   generated/ tests +          an LLM — ADR-0010)
    block the          coverage.json                    │
    pipeline           (tool-owned, idempotent)         ▼
                                                git commit = approval
                                                (ADR-0003, ADR-0012)
```

## Context interaction model

| Context | Role in the pipeline | Key invariant it enforces |
|---|---|---|
| workspace-context | Shared kernel; provides the joint `VersaillesContext` to everyone | `.versailles/` files are never interpreted in isolation; no version gates — the format policy is additive-only (ADR-0018) |
| contract-language | Validation gate; structured error producer | Invalid contracts never reach generation |
| manifest-extraction | Grounding edge; source → `manifests.json` | Manifests are derived by static analysis, never hallucinated |
| deterministic-generation | The compiler; contracts → tests | Generation is a pure function; `generated/` is tool-owned |
| predicate-registry | Declarative predicate data + validate-time verification | Declarations are verified by `validate` (name validity, `sourceRef` resolution); no purity gate — the declaration is the attestation (ADR-0019) |

The shared kernel pattern is deliberate: **workspace-context is upstream of every other context** (each reads the joint context). manifest-extraction writes `manifests.json` into the kernel; deterministic-generation writes `generated/` into it.

## Dependency direction (what depends on what)

```
  contract-language ◄── manifest-extraction
         ▲                    │
         │                    │
         └────────────────────┘
         │
         ▼
   workspace-context               (writes into the kernel)
         │
         ├──► contract-language      (loader uses parser+validator to build context)
         └──► deterministic-generation   (needs isValid: true)
```

No bounded context depends on an LLM — the tool never drives one (ADR-0010). Generation never depends on authoring.

## The CLI as the application layer

The command surface binds contexts without owning domain logic (build-spec §12). The tool ships as npm package **`versailles-dbc`** with the CLI **`versailles`** (decoupled via the `bin` field — ADR-0001):

| Command | Binds | Exit codes / notes |
|---|---|---|
| `versailles init` | workspace-context | Scaffolds the workspace |
| `versailles extract-manifests` | manifest-extraction | Updates `manifests.json`; `--prune` only explicit |
| `versailles validate` | workspace-context → contract-language + predicate-registry | Structured report; rejection = exit `1`; `--verbose` shows raw `expr` + parsed AST |
| `versailles check` | workspace-context + contract-language + manifest-extraction | CI-mode; exit `2` = staleness (blocking) |
| `versailles generate` | deterministic-generation | Requires `isValid: true`; exit `1` if invalid |

**Rejected commands** are first-class behavior: an invalid context (parse/validation errors) or a stale context while blocking makes the command reject with structured errors and a distinct exit code — never a silent partial run (see [features/command-rejection.md](../features/command-rejection.md)). `check`, `generate`, and `extract-manifests` share one workspace gate and standardize every invalid-context failure path on exit `1` with the empty output envelope `{}` (VERSAILLES-171).

Root-level `versailles -v` / `versailles --version` print the tool version and exit `0` from any directory — a flag, not a command: it short-circuits before dispatch and never loads the workspace (VERSAILLES-171).

## Pluggable edges (ADR-0008) and the v1 matrix (ADR-0009)

The core — grammar, parser, semantic validator, loader, test-case IR, generator — is **language-agnostic and written once**. Only two seams vary per target:

```
                    language-agnostic core
   ┌───────────────────────────────────────────────────┐
   │ grammar · parser · validator · loader · generator   │
   └──────────┬──────────────────────────────┬──────────┘
              │                              │
   extractor plugin                     emitter plugin
   (config.language)                   (config.testFramework)
```

See [plugin-seams.md](plugin-seams.md) for the full seam specification and the v1 TS/C#/Python + vitest/xUnit/pytest matrix.

## Consistency rules

- All contexts share the [ubiquitous language](../glossary.md) — no competing definitions.
- Everything downstream reads `contracts.json`; nothing re-derives intent from source at generation time (contracts as single source of truth).
- The audit trail is git history (ADR-0003) — the git commit is the approval (ADR-0012).

See also: [Domains](../domains/index.md) · [Features](../features/index.md) · [Glossary](../glossary.md)
