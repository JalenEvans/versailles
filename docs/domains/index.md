# Bounded Contexts — Versailles

The Versailles domain decomposed into bounded contexts (Domain-Driven Design). Each context owns a slice of the domain and speaks the shared [ubiquitous language](../glossary.md). The context set was derived from the [build spec](../build-spec.md) and the accepted ADRs; per-repo convention, no context is implemented until it has a registered [contract](../contracts/index.md) — all five bounded contexts plus the CLI surface now have draft contracts.

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
                 │          │            │        │ contract
      parses &  │          │          scoped     │ objects
      validates │          │        extraction   │
                 │          │            │        │
      ┌─────────┴───┐  ┌────┴────────┐
      │ contract-   │  │deterministic│
      │ language    │  │generation   │
      └─────────┬───┘  └────┬────────┘
                │           │
       structured      generated/
       errors          tests + coverage.json
```

Contract objects are authored directly into `contracts.json` (with predicates declared inline in the top-level `predicates` map); `validate`/`check` gate correctness; the git commit is the approval (ADR-0003, ADR-0012). The tool never invokes an LLM (ADR-0010).

## The bounded contexts

| # | Bounded context | Owns (responsibility) | Consumes from | Spec | Contract |
|---|---|---|---|---|---|
| 1 | [contract-language](contract-language.md) | The contract expression grammar, parser, AST, semantic validator, structured error contract, and the predicate-call cross-referencing check against the top-level `predicates` map in `contracts.json` (existence, arity, arg types, `verifiedPure`) | workspace-context (full context for semantic checks), manifest-extraction (field resolution), predicate-registry (predicate data) | [specs/versailles.md](../specs/versailles.md) | [draft](../contracts/contract-language.contract.yaml) |
| 2 | [manifest-extraction](manifest-extraction.md) | Source → `manifests.json`: field manifests, `typeRef` resolution, structural `sourceHash`, per-language extractor plugins, low-confidence typing policy | source code, config (`config.language`) | [specs/versailles.md](../specs/versailles.md) | [draft](../contracts/manifest-extraction.contract.yaml) |
| 3 | [workspace-context](workspace-context.md) | The `.versailles/` workspace as a versioned, jointly-loaded unit: version gates, `VersaillesContext` object, scoped extraction helper, staleness check orchestration | all three `.versailles/` data files (config.json, contracts.json, manifests.json) + generated/ | [specs/versailles.md](../specs/versailles.md) | [draft](../contracts/workspace-context.contract.yaml) |
| 4 | [deterministic-generation](deterministic-generation.md) | Deterministic test generation: test-case IR, boundary/partition/violation/satisfaction cases, invariant tests, traceability, `generated/coverage.json`, per-framework emitter plugins | workspace-context (`isValid` context), contract-language (validated AST) | [specs/versailles.md](../specs/versailles.md) | [draft](../contracts/deterministic-generation.contract.yaml) |
| 5 | [predicate-registry](predicate-registry.md) | Declarative predicate declarations in `contracts.json`: validator-time `sourceRef` resolution (resolve-or-warn), name validity, `verifiedPure` gate preserved (ADR-0006); `sourceHash` dropped (ADR-0013) | workspace-context (joint load), contract-language (cross-referencing enforcement) | [specs/predicate-registry.md](../specs/predicate-registry.md) | [draft](../contracts/predicate-registry.contract.yaml) |

## Relationship notes

- **workspace-context is the shared kernel.** Every other context reads from / writes into the `.versailles/` workspace; no context interprets a file in isolation (build-spec §2, §6).
- **contract-language is the validation gate.** It is *upstream* of anything that must not see invalid contracts: generation (only runs on `isValid: true`) and CI (`validate` / `check`). `validate --verbose` additionally surfaces raw `expr` strings alongside their parsed AST as a parser-sanity check.
- **manifest-extraction grounds everything downstream.** Hallucinated fields would silently poison validation, generation, and authoring — hence static-analysis-first (ADR-0005) and permissive-but-visible typing (ADR-0004).
- **predicate-registry is data + validator enforcement.** Predicates are declared inline in `contracts.json`; `validate` mechanically verifies each declaration (ADR-0013). The tool never invokes an LLM (ADR-0010).
- **ADRs 0008/0009 shape the edges.** Only manifest-extraction (per language) and deterministic-generation's emitters (per framework) vary; the core stays language-agnostic.

## Feature coverage

Each user-visible capability maps to one or more contexts — see [features](../features/index.md).

See also: [Architecture](../architecture/index.md) · [Glossary](../glossary.md) · [Specs](../specs/index.md) · [Decisions](../decisions/index.md) · [Build spec](../build-spec.md)