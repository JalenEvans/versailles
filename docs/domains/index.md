# Bounded Contexts — Versailles

The Versailles domain decomposed into bounded contexts (Domain-Driven Design). Each context owns a slice of the domain and speaks the shared [ubiquitous language](../glossary.md). The context set was derived from the [build spec](../build-spec.md) and the accepted ADRs; per-repo convention, no context is implemented until it has a registered [contract](../contracts/index.md) (all pending — contract authoring is a later step).

## Context map

```
                      ┌──────────────────────────┐
 source code ───────▶ │      manifest-extraction │  per-language extractor
                      └───────────┬──────────────┘    plugins (ADR-0008/0009)
                                  │ manifests.json
                                  ▼
             ┌────────────────────────────────────────┐
             │         workspace-context              │  shared kernel: the
             │         (the .versailles/ workspace)   │  versioned, jointly-
             │                                        │  loaded file set
             └───▲──────────┬────────────┬────────↑───┘
                 │          │            │        │
                 │          │            │        │ merge
      parses &  │          │          scoped     │ contract
      validates │          │        extraction   │ objects
                 │          │            │        │
      ┌─────────┴───┐  ┌────┴────────┐  ┌─────────┴──────┐
      │ contract-   │  │deterministic│  │ authoring-loop  │──staged──▶ review
      │ language    │  │generation   │  │                 │
      └─────────┬───┘  └────┬────────┘  └─────────────────┘
                │           │
       structured      generated/
       errors          tests + coverage.json
```

## The bounded contexts

| # | Bounded context | Owns (responsibility) | Consumes from | Spec | Contract |
|---|---|---|---|---|---|
| 1 | [contract-language](contract-language.md) | The contract expression grammar, parser, AST, semantic validator, structured error contract, and the predicate registry (`predicates.json`) | workspace-context (full context for semantic checks), manifest-extraction (field resolution) | [specs/versailles.md](../specs/versailles.md) | pending |
| 2 | [manifest-extraction](manifest-extraction.md) | Source → `manifests.json`: field manifests, `typeRef` resolution, structural `sourceHash`, per-language extractor plugins, low-confidence typing policy | source code, config (`config.language`) | [specs/versailles.md](../specs/versailles.md) | pending |
| 3 | [workspace-context](workspace-context.md) | The `.versailles/` workspace as a versioned, jointly-loaded unit: version gates, `VersaillesContext` object, scoped extraction helper, staleness check orchestration | all four `.versailles/` files | [specs/versailles.md](../specs/versailles.md) | pending |
| 4 | [deterministic-generation](deterministic-generation.md) | Deterministic test generation: test-case IR, boundary/partition/violation/satisfaction cases, invariant tests, traceability, `generated/coverage.json`, per-framework emitter plugins | workspace-context (`isValid` context), contract-language (validated AST) | [specs/versailles.md](../specs/versailles.md) | pending |
| 5 | [authoring-loop](authoring-loop.md) | LLM contract authoring: prompt with manifest+predicate context, mechanical validation, capped structured-error retry, staging for review | workspace-context, contract-language | [specs/versailles.md](../specs/versailles.md) | pending |
| 6 | [review](review.md) | Human review and approval: scoped diff of staged contracts, single-object merge into `contracts.json`, git history as the audit trail | authoring-loop (staged contracts), workspace-context (scoped extraction) | [specs/versailles.md](../specs/versailles.md) | pending |

## Relationship notes

- **workspace-context is the shared kernel.** Every other context reads from / writes into the `.versailles/` workspace; no context interprets a file in isolation (build-spec §2, §6).
- **contract-language is the validation gate.** It is *upstream* of anything that must not see invalid contracts: the authoring loop (validation before staging), review (warnings + pretty-printed AST), generation (only runs on `isValid: true`), and CI (`validate` / `check`).
- **manifest-extraction grounds everything downstream.** Hallucinated fields would silently poison validation, generation, and authoring — hence static-analysis-first (ADR-0005) and permissive-but-visible typing (ADR-0004).
- **authoring-loop and review are the human-in-the-loop edge.** The LLM never touches generated tests (ADR-0002) and never merges into `contracts.json`; the reviewer's single-object merge is the only write to contracts (ADR-0003).
- **ADRs 0008/0009 shape the edges.** Only manifest-extraction (per language) and deterministic-generation's emitters (per framework) vary; the core stays language-agnostic.

## Feature coverage

Each user-visible capability maps to one or more contexts — see [features](../features/index.md).

See also: [Architecture](../architecture/index.md) · [Glossary](../glossary.md) · [Specs](../specs/index.md) · [Decisions](../decisions/index.md) · [Build spec](../build-spec.md)