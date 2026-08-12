# Architecture — Pluggable Edges (ADR-0008) and the v1 Matrix (ADR-0009)

How Versailles stays language-agnostic at its core while shipping three language/framework pairs in v1.

## The seam policy (ADR-0008)

**Rule:** the grammar, parser, semantic validator, loader, and generator **never fork** per language or framework. Only two seams are pluggable:

| Seam | Selected by | Purpose | Context |
|---|---|---|---|
| Manifest extractor | `config.language` | source → `manifests.json` (per-language static analysis) | manifest-extraction |
| Output emitter | `config.testFramework` | test-case IR → real test-file syntax | deterministic-generation |

**Why this shape:**

- A single, restricted, language-agnostic grammar keeps the AST canonical — which is what makes future AST → SMT-LIB translation mechanical (build-spec §9.5, v2).
- The seams exist from day one even though v1 could have shipped one pair; adding language #2 is a new plugin, not a forklift refactor.
- Consequence: the **plugin interfaces are public seams** — they must be defined early and treated as contracts (registered via the contract pipeline), not internal details.

## v1 matrix (ADR-0009)

| # | Source language | Manifest extractor | Test framework | Output emitter | Sequencing |
|---|---|---|---|---|---|
| 1 | TypeScript | `ts.createProgram` + type checker | vitest | `*.test.ts` | **First** |
| 2 | C# | Roslyn / source shape analysis | xUnit | `*.Tests.cs` | Second |
| 3 | Python | `ast` + typing introspection | pytest | `test_*.py` | Third |

The matrix supersedes the single-language/framework assumptions of build-spec §7, §9.4, and the §14 "single framework" row.

## Sequencing rationale

Each language pair adds **one extractor + one emitter**; the core (grammar, parser, validator, loader, generator IR) is written once and never forks. Sequencing is deliberate risk-ordering: TypeScript + vitest first proves the core pipeline (build-spec milestones 1–3) before multiplying per-language work. Implementation history must show TS+vitest landed before C#+xUnit, which landed before Python+pytest.

## What each pair must prove

Per pair, independently testable:

- **Extractor correctness**: the plugin resolves field types to the `typeRef` grammar (generics → `list<T>`, literal unions → `enum<...>`, nested types → transitive flat-map entries); dynamically-typed inference is flagged low-confidence, never silently trusted (ADR-0004).
- **Emitter correctness**: the plugin renders the framework-agnostic test-case IR into idiomatic test syntax for its framework, including the configurable rejection idiom (ADR-0007) and traceability comments.
- **Core purity**: no language- or framework-specific code anywhere in the core modules (ADR-0008 confirmation).

## Boundary guarantees (ADR-0009 confirmations)

- `config.language` accepts `typescript | csharp | python`; `config.testFramework` accepts `vitest | xunit | pytest`.
- The repo ships three extractor plugins and three emitter plugins, each registered behind the same interface.
- Determinism does not depend on the pair: `versailles generate` is byte-stable for a given approved context regardless of extractor/emitter (ADR-0002).

## Future surface

- **SMT-backed generation (v2, build-spec §9.5)**: stays a pure function of the grammar — unaffected by target language, because the AST is canonical and target-agnostic.

See also: [Architecture index](index.md) · [Domains](../domains/index.md) · [ADR-0008](../decisions/0008-language-agnostic-core-pluggable-plugins.md) · [ADR-0009](../decisions/0009-v1-language-and-framework-matrix.md)