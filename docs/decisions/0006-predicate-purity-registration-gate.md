# ADR: Predicate purity enforced at registration

**ID:** ADR-0006
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Contract expressions may call named predicates (registered in `predicates.json`). If a predicate has side effects or does not terminate, generated tests built around it misbehave — assertions fire for the wrong reason, or the suite hangs. Determining purity automatically is complex and noisy. The spec's design: a `verifiedPure` flag on each predicate, checked once at registration. This ADR pins down how that flag is enforced.

## Decision Drivers

- Correctness: unverified predicates corrupt generation.
- Pragmatism: full automated purity/termination analysis is a research problem, not a v1 feature.
- Enforcement point: the flag is only useful if the validator *requires* it.

## Considered Options

- **Automated purity/termination analysis** — accurate in principle, but heavy machinery with false positives; out of scope for v1.
- **Manual `verifiedPure` flag checked at registration (chosen)** — set once via lint/manual review at registration time; the validator hard-errors on `verifiedPure: false` or missing, so unverified predicates cannot be referenced in contracts.

## Decision Outcome

Chosen option: **manual registration-time purity check, enforced by the validator**, **because** it is cheap, honest about the human review step, and gives the validator a hard gate: no verified flag, no contract reference.

### Consequences

- **Positive:** effective hard gate with minimal tooling.
- **Negative:** relies on human diligence at registration time.
- **Neutral:** a future automated analysis can replace the manual flag without schema change (the field already exists as `verifiedPure`).

### Confirmation

- `predicates.json` entries must have `verifiedPure: true` to be referenceable.
- The validator rejects any contract referencing a predicate with `verifiedPure !== true`.

## More Information / Links

- [Build spec §3.4 predicates.json](../build-spec.md#34-predicatesjson), [§5.1 validator checks](../build-spec.md#51-checks-performed), [§13 milestone 8 (predicate registry tooling)](../build-spec.md#13-build-milestones-recommended-order), [§14 row: Predicate purity enforcement](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |