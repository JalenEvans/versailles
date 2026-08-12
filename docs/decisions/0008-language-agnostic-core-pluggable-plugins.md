# ADR: Language-agnostic core; pluggable extractor and emitter

**ID:** ADR-0008
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

Versailles targets a source language (manifest extraction) and a test framework (output emission), with more likely later. The core — grammar, parser, semantic validator, loader, generator — should not fork per language or framework. We need a boundary policy that keeps the core singular while allowing per-language/per-framework edges.

## Decision Drivers

- Scope control for v1: one language + one framework is the v1 target, but the seams must exist from the start.
- Determinism and future SMT translation: a single, restricted, language-agnostic grammar keeps AST→SMT-LIB translation mechanical (build spec §9.5).
- Avoiding forklift refactors when language #2 arrives.

## Considered Options

- **Per-language grammar variants** — maximum flexibility, but explodes core complexity and breaks the single-AST story that enables §9.5.
- **Agnostic core + pluggable plugins (chosen)** — the expression grammar, validator, loader, and generator are language-agnostic; only the manifest extractor (selected by `config.language`) and the output emitter (selected by `config.testFramework`) plug in per target.

## Decision Outcome

Chosen option: **language-agnostic core with pluggable extractor/emitter**, **because** it keeps v1 scoped to one language/framework while defining the extension seams up front — and it preserves the single-AST design that makes future SMT-backed generation mechanical.

### Consequences

- **Positive:** v1 delivers one language + one framework with a clean path to more.
- **Negative:** plugin interface contracts must be defined early (the extractor and emitter are public seams, not internal details).
- **Neutral:** the §9.5 SMT translation stays a pure function of the grammar, unaffected by target language.

### Confirmation

- `config.language` selects the manifest extractor plugin; `config.testFramework` selects the output emitter plugin.
- Core modules (parser, validator, loader, generator) contain no language- or framework-specific code.

## More Information / Links

- [Build spec §7 Manifest extractor](../build-spec.md#7-manifest-extractor-source--manifestsjson), [§9.4 Output emitters](../build-spec.md#94-output-emitters), [§9.5 v2 stretch: SMT-backed generation](../build-spec.md#95-v2-stretch-smt-backed-generation), [§14 row: Multi-language support](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |