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
 contract-language  deterministic-generation   external agent (LLM): authors
 (parse + validate)  (requires isValid: true)   contract objects, drives the
        │               │                       CLI (validate / check) — the
 structured errors   generated/ tests +         tool never drives an LLM
   block the          coverage.json             (no in-tool loop — ADR-0010)
   pipeline           (tool-owned, idempotent)         │
                                                       ▼
                                               review (human) ◄── validated
                                                          │      contract objects
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
| review | The approval gate | Approval = single-object merge; git is the audit trail |
| predicate-registry | Registry tooling; maintains `predicates.json` | Registrations are single-entry writes; purity is a human gate |

The external LLM/agent that authors contracts and drives the CLI is **not** a bounded context — it sits outside the tool (ADR-0010).

The shared kernel pattern is deliberate: **workspace-context is upstream of every other context** (each reads the joint context) and **downstream of review** (the merge writes `contracts.json` back). manifest-extraction writes `manifests.json` into the kernel; deterministic-generation writes `generated/` into it.

## Dependency direction (what depends on what)

```
 contract-language ◄── manifest-extraction
        ▲                    │
        │                    │
      review ◄───────────────┘
        │
        ▼
  workspace-context               (writes into the kernel)
        │
        ├──► contract-language      (loader uses parser+validator to build context)
        ├──► deterministic-generation   (needs isValid: true)
        └──► review                     (scoped extraction)
```

No bounded context depends on an LLM — the tool never drives one (ADR-0010). Generation never depends on authoring, and external authoring never depends on generation: ADR-0002 keeps generation a pure function of approved contracts, decoupled from any LLM involvement.

## The CLI as the application layer

The command surface binds contexts without owning domain logic (build-spec §12). The tool ships as npm package **`versailles-dbc`** with the CLI **`versailles`** (decoupled via the `bin` field — ADR-0001):

| Command | Binds | Exit codes / notes |
|---|---|---|
| `versailles init` | workspace-context | Scaffolds the workspace |
| `versailles extract-manifests` | manifest-extraction | Updates `manifests.json`; `--prune` only explicit |
| `versailles validate` | workspace-context → contract-language | Structured report; rejection = exit `1` |
| `versailles check` | workspace-context + contract-language + manifest-extraction | CI-mode; exit `2` = staleness (blocking) |
| `versailles generate` | deterministic-generation | Requires `isValid: true`; exit `1` if invalid |
| `versailles review <component> [operation]` | review → workspace-context | Merge = git commit; no auto-approve |
| `versailles register-predicate <name> --source <Module.functionName>` | predicate-registry | Single-entry write; `sourceRef`/`sourceHash` verified |
| `versailles verify-purity <name>` | predicate-registry | Human-only purity flip; never recomputes hashes |
| `versailles remind-unverified` | predicate-registry | Reports unverified predicates; never writes |

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