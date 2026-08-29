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
| [0011](0011-contract-first-emission.md) | Contract-first emission: generate from contracts.json; extract-manifests optional for brownfield | accepted | — |
| [0012](0012-git-commit-as-approval-remove-review-gate.md) | Git commit as approval — no in-tool review gate | accepted | ADR-0003 (single-object review-merge mechanism) |
| [0013](0013-declarative-predicates-remove-registration-cli.md) | Declarative predicates — no registration CLI | accepted | — |
| [0014](0014-roadmap-reconciliation.md) | Roadmap reconciliation — SMT as soundness requirement; roadmap supersedes BS§9.5/BS§13 | accepted | — |
| [0015](0015-licensing-and-contribution-model.md) | Licensing and contribution model — MIT core, EasyCLA, open-core commitment | accepted | — |
| [0016](0016-cla-assistant-derived-templates.md) | CLA Assistant with derived Apache templates (supersedes ADR-0015's EasyCLA choice) | accepted | ADR-0015 (CLA mechanism only) |
| [0017](0017-property-based-test-emission-mit-core.md) | PBT emission in the MIT core; determinism scoped to generation-time | accepted | — |

See also: [Contracts](../contracts/index.md) · [Specs](../specs/index.md) · [Build spec](../build-spec.md)