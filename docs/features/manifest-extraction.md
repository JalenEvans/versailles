# Feature: Manifest Extraction

**Command:** `versailles extract-manifests`
**Primary context:** [manifest-extraction](../domains/manifest-extraction.md) (+ workspace-context)
**Vocabulary:** [glossary](../glossary.md) — *manifest / field manifest, typeRef, sourceHash, low-confidence field, extractor plugin*

## Overview

Grounds the whole pipeline: `extract-manifests` scans `config.sourceRoots` with the **extractor plugin** for `config.language` and derives `manifests.json` — field types resolved to the `typeRef` grammar, structural `sourceHash` values computed from sorted field name+type pairs, low-confidence inferences flagged. Manifests are derived artifacts: **never hand-authored, never LLM-authored blind** (ADR-0005).

## User story

> As a developer, I want the field structure of my components extracted from source automatically, so my contracts are grounded in what the code actually declares.

## Flow

1. Read config (`sourceRoots`, `language`) from the workspace.
2. Select the extractor plugin for `config.language` (TypeScript `ts.createProgram` + type checker; C# Roslyn; Python `ast` + typing introspection).
3. Walk class/interface/type declarations; resolve field types to `typeRef` (generics → `list<T>`, literal unions → `enum<...>`, nested/related types → transitive flat-map entries).
4. For each component, compute the **structural `sourceHash`** (sorted field name+type pairs — body edits don't count).
5. Write/update `manifests.json`, **preserving entries** for components not covered by the current scan. Never prune implicitly — `--prune` removes stale entries explicitly.

## Domain events

- `manifestUpdated` — per component whose entry was (re)written.

## Business rules

- Static analysis first; an external agent may update manifests via the CLI, but its output is mechanically checked against real source before writing — the tool never invokes an LLM (ADR-0005, ADR-0010).
- Inferred (low-confidence) fields are flagged, warn, and never silently trusted (ADR-0004).
- No implicit pruning: preserving entries for unscanned components is the default; `--prune` is explicit (build-spec §7).
- The extractor is a plugin: the core never contains per-language extraction code (ADR-0008).

## Edge cases

- **Dynamically-typed fields (Python)** → low-confidence flags + validator warnings; usable but visible uncertainty (ADR-0004).
- **Removed field** → next extract updates the entry; body-only changes do not change the structural `sourceHash`.
- **Field type not expressible in `typeRef`** → flagged, not silently approximated (v1 keeps the grammar closed; see build-spec §2 non-goals).

## Source of authority

[build-spec §3.3, §7](../build-spec.md) · [ADR-0004](../decisions/0004-permissive-manifest-typing.md) · [ADR-0005](../decisions/0005-static-analysis-first-manifest-extraction.md) · [ADR-0008](../decisions/0008-language-agnostic-core-pluggable-plugins.md) · [ADR-0009](../decisions/0009-v1-language-and-framework-matrix.md)