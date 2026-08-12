# ADR: Permissive manifest typing; low-confidence warns, doesn't block

**ID:** ADR-0004
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

Manifests ground contracts: field types come from `manifests.json`. If the v1 language is dynamically typed (e.g. Python), many field types can only be *inferred*, not declared. A strict policy — unknown or inferred type = hard error — would make such artifacts unusable for contract authoring. We need a policy that keeps the pipeline usable without silently trusting uncertain type information.

## Decision Drivers

- Usability for dynamically-typed languages.
- Correctness signal: inference uncertainty must be visible, not silent.
- Scope control for v1: full type inference machinery is out of scope.

## Considered Options

- **Strict** — unknown/inferred type is a hard error; safest, but blocks dynamically-typed languages entirely.
- **Permissive with warnings (chosen)** — fields flagged as inferred/low-confidence produce non-blocking warnings; only high-confidence types participate in hard type-compatibility errors.

## Decision Outcome

Chosen option: **permissive with warnings**, **because** it keeps dynamically-typed languages usable while preserving a correctness signal — the validator's warning tier (build spec §5.1) surfaces low-confidence entries without blocking the pipeline.

### Consequences

- **Positive:** dynamic languages are first-class in v1; inference uncertainty is visible to reviewers.
- **Negative:** some type errors surface late — as warnings that reviewers must heed rather than hard failures.
- **Neutral:** adds a confidence concept to the manifest schema as an extension point (not required in v1, flagged in §5.1).

### Confirmation

- The validator has a warning code for inferred/low-confidence fields.
- No hard failure results purely from inference uncertainty (no unknown-type hard error for inferable-only fields).

## More Information / Links

- [Build spec §3.3 manifests.json](../build-spec.md#33-manifestsjson), [§5.1 validator checks](../build-spec.md#51-checks-performed), [§14 row: Type strictness](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |