# Architecture — Versailles

How the [bounded contexts](../domains/index.md) interact. The vocabulary is the shared [ubiquitous language](../glossary.md).

## The pipeline at a glance

```
 source code
     │  (manifest-extraction: extractor plugin per config.language — ADR-0008/0009)
     ▼
 manifests.json ──►  .versailles/ workspace (versioned, loaded as one unit)
                        │  (workspace-context: version gates + joint load)
                        ▼
                  VersaillesContext (isValid?)
                        │
        ┌───────────────┼──────────────────────────────┐
        ▼               ▼                              ▼
 contract-language  deterministic-generation      authoring-loop
 (parse + validate)  (requires isValid: true)      (LLM + validation gate)
        │               │                              │
 structured errors   generated/ tests +            staged contracts
   block the          coverage.json                 (never auto-merged)
   pipeline           (tool-owned, idempotent)           │
                                                          ▼
                                                   review (human)
                                                         │
                                             single-object merge
                                                         ▼
                                              contracts.json (approved —
                                              git history is the audit trail)
```

## Context interaction model

| Context | Role in the pipeline | Key invariant it enforces |
|---|---|---|
| workspace-context | Shared kernel; provides the joint `VersaillesContext` to everyone | `.versailles/` files are never interpreted in isolation; version gates are hard |
| contract-language | Validation gate; structured error producer | Invalid contracts never reach review or generation |
| manifest-extraction | Grounding edge; source → `manifests.json` | Manifests are derived by static analysis, never hallucinated |
| deterministic-generation | The compiler; contracts → tests | Generation is a pure function; `generated/` is tool-owned |
| authoring-loop | The only LLM path | No LLM output reaches a human unvalidated; nothing auto-merges |
| review | The approval gate | Approval = single-object merge; git is the audit trail |

The shared kernel pattern is deliberate: **workspace-context is upstream of every other context** (each reads the joint context) and **downstream of review** (the merge writes `contracts.json` back). manifest-extraction writes `manifests.json` into the kernel; deterministic-generation writes `generated/` into it.

## Dependency direction (what depends on what)

```
authoring-loop ──► contract-language ◄── manifest-extraction
      │                   ▲                    │
      ▼                   │                    │
    review ◄──────────────┼────────────────────┘
      │                   │
      ▼                   │
 workspace-context ◄──────┘       (writes into the kernel)
      │
      ├──► contract-language      (loader uses parser+validator to build context)
      ├──► deterministic-generation   (needs isValid: true)
      ├──► authoring-loop             (grounding context)
      └──► review                     (scoped extraction)
```

No context depends on the LLM path; generation never depends on authoring; authoring never depends on generation. ADR-0002 keeps the two halves (authoring vs. generation) fully decoupled.

## The CLI as the application layer

The command surface binds contexts without owning domain logic (build-spec §12). The tool ships as npm package **`versailles-dbc`** with the CLI **`versailles`** (decoupled via the `bin` field — ADR-0001):

| Command | Binds | Exit codes / notes |
|---|---|---|
| `versailles init` | workspace-context | Scaffolds the workspace |
| `versailles extract-manifests` | manifest-extraction | Updates `manifests.json`; `--prune` only explicit |
| `versailles author <component> [operation]` | authoring-loop → contract-language | Stages, never merges |
| `versailles validate` | workspace-context → contract-language | Structured report; rejection = exit `1` |
| `versailles check` | workspace-context + contract-language + manifest-extraction | CI-mode; exit `2` = staleness (blocking) |
| `versailles generate` | deterministic-generation | Requires `isValid: true`; exit `1` if invalid |
| `versailles review <component> [operation]` | review → workspace-context | Merge = git commit; no auto-approve |

**Rejected commands** are first-class behavior: an invalid context (parse/validation errors), a stale context while blocking, or a version mismatch makes the command reject with structured errors and a distinct exit code — never a silent partial run (see [features/command-rejection.md](../features/command-rejection.md)).

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
- The audit trail is git history (ADR-0003) — no approval metadata is added to any schema to make review observable.

See also: [Domains](../domains/index.md) · [Features](../features/index.md) · [Glossary](../glossary.md)