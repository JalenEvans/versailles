# Decision Records

Architecture decision records (ADRs). Immutable once accepted — a new decision supersedes, never edits, an old one.

| ID | Title | Status | Supersedes |
|---|---|---|---|
| [0001](0001-package-and-cli-naming.md) | Package `versailles-dbc`, CLI `versailles` | accepted | — |
| [0002](0002-deterministic-generation-llm-authoring-only.md) | Deterministic generation; LLM confined to authoring | superseded | — |
| [0003](0003-git-history-as-audit-trail.md) | Git history as audit trail (no approval fields in schema) | accepted | — |
| [0004](0004-permissive-manifest-typing.md) | Permissive manifest typing; low-confidence warns | accepted | — |
| [0005](0005-static-analysis-first-manifest-extraction.md) | Static analysis first for manifest extraction | accepted | — |
| [0006](0006-predicate-purity-registration-gate.md) | Predicate purity enforced at registration | accepted | — |
| [0007](0007-configurable-rejection-idiom.md) | Configurable rejection idiom, default `throws` | accepted | — |
| [0008](0008-language-agnostic-core-pluggable-plugins.md) | Language-agnostic core; pluggable extractor/emitter | accepted | — |
| [0009](0009-v1-language-and-framework-matrix.md) | v1 targets TS/C#/Python + vitest/xUnit/pytest, TS first | accepted | build-spec §7/§9.4/§14 single-language assumptions |
| [0010](0010-cli-never-drives-llm.md) | The CLI never drives an LLM; LLMs drive the CLI | accepted | ADR-0002 (authoring-loop aspect) |
| [0011](0011-contract-first-emission.md) | Contract-first emission: generate from contracts.json; extract-manifests optional for brownfield | proposed | — |

See also: [Contracts](../contracts/index.md) · [Specs](../specs/index.md) · [Build spec](../build-spec.md)