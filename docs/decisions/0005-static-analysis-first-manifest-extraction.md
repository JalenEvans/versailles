# ADR: Static analysis first for manifest extraction

**ID:** ADR-0005
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Manifests are the grounding for contracts — if a manifest invents fields or types, everything downstream (validation, generation, LLM authoring) is poisoned. The spec requires manifests to be "never hand-authored, never LLM-authored blind," but the LLM-assisted authoring loop (§10) could tempt an LLM-driven extraction path. We need a policy for how `manifests.json` is produced.

## Decision Drivers

- Correctness of grounding: hallucinated fields would invalidate contracts silently.
- Cost: static analysis is cheaper per-run than an LLM call.
- Coverage: static analysis is authoritative for what it can see; LLMs can help with what it can't.

## Considered Options

- **LLM-only extraction** — fast and broad, but risks phantom fields/types that poison downstream contracts.
- **Static analysis first (chosen)** — use the language's compiler API / AST (TypeScript compiler API, Python `ast` + typing introspection or mypy's AST); authoritative, defensive. LLM-assisted extraction only as a *fallback*, and its output must be mechanically verified against actual source before `manifests.json` is written.

## Decision Outcome

Chosen option: **static analysis first**, **because** it is the only option that makes manifests defensible at the source of truth. LLM assistance is allowed only as a verified fallback — output checked against real source before it touches the manifest.

### Consequences

- **Positive:** manifests are defensible; no hallucination path into the grounding layer.
- **Negative:** per-language extractor cost — one extractor per supported language (v1 targets one).
- **Neutral:** `sourceHash` covers structural shape only (sorted field name+type pairs), so unrelated method-body changes don't trigger false staleness.

### Confirmation

- `versailles extract-manifests` uses the language's static analysis APIs, not an LLM.
- Any LLM-assisted path includes a mechanical verification gate before writing `manifests.json`.

> **Clarification (2026-08-11, ADR-0010):** "LLM assistance" in this ADR refers to an *external* agent that may author/update manifests via the CLI — the tool itself never invokes an LLM. The static-analysis-first decision is unchanged.

## More Information / Links

- [Build spec §7 Manifest extractor](../build-spec.md#7-manifest-extractor-source--manifestsjson), [§14 row: Manifest extraction method](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |
| 2026-08-11 | general-manager | Added ADR-0010 clarification note (external-agent framing); decision body unchanged |