# ADR: Drop the `verifiedPure` field — the predicate declaration is the attestation

**ID:** ADR-0019
**Date:** 2026-09-01
**Status:** accepted
**Owner:** associate-head-coach
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

Contract expressions may call named predicates declared in the top-level `predicates` map of `contracts.json` (ADR-0013). Each declaration carries `verifiedPure: true` — a human-set boolean asserting the predicate has no side effects and always terminates (ADR-0006). The semantic validator hard-errors (`UNVERIFIED_PREDICATE`) on any contract reference to a predicate whose `verifiedPure` is missing or false.

The field was designed for a registration/review era that no longer exists:

1. **ADR-0012 removed the in-tool review gate** — approval is now the git commit; meaning lives in authored data + PR review, not tool-enforced ceremony.
2. **ADR-0013 removed the registration CLI** and the stored `sourceHash` — the one mechanical anchor tying the purity judgment to actual source. What remains is a pure attestation with **zero mechanical teeth**: no analysis backs it, nothing drift-checks it, and any author can set `true` (or an agent can, on the author's behalf).
3. **The generator's failure mode is self-revealing.** In the concrete v1 path, generated tests never execute predicates — they synthesize violation inputs from `paramTypes` heuristics and assert the rejection idiom. In the PBT path (ADR-0017), predicate calls *do* execute at runtime as codegen'd oracles (imported from source). In both cases, an impure or non-terminating predicate surfaces immediately as a failing or hanging test on the first run of the suite. The boolean never prevented that — it only pre-committed a judgment the test run would discover empirically anyway.

The declaration itself is the load-bearing human act: `sourceRef` resolving against real source on every `validate` run (ADR-0005's "nothing invented") proves the predicate exists, has the declared shape, and points at a real function. That is the anti-hallucination attestation. Purity does not need a second, unenforceable ceremony field when the runtime consequence is self-detecting in the one path where it matters.

## Decision Drivers

- **Ceremony reduction:** a mandatory boolean with no enforcement invites the "set `true` and move on" reflex — ceremony that gates nothing.
- **Attestation redundancy:** existence + shape + resolvable `sourceRef` is the attestation that matters; purity is a second claim with no backing.
- **Self-detection:** impure/non-terminating predicates fail or hang the generated suite on first run — a real check beats a hand-waved flag.
- **Consistency with the authoring-as-artifact wave:** ADR-0012/0013 established that meaning lives in authored data + git review; per-field trust-me ceremony is off-brand.

## Considered Options

- **Option A — Drop `verifiedPure` entirely (chosen)** — remove the field from the predicate declaration schema, the loader shape check, the `PredicateEntry` type, and the validator's `UNVERIFIED_PREDICATE` gate. Any declared predicate is referenceable; anti-hallucination remains via `sourceRef` resolution; impurity/non-termination is caught by the generated suite at runtime.
- **Option B — Keep the field (status quo)** — retain the mandatory boolean as-is. Preserves a default-deny posture but keeps a trust-me field with no mechanical backing and no distinct job since ADR-0012/0013.
- **Option C — Keep the field, strengthen it with a `check`-time smoke test** — execute each `verifiedPure` predicate with deterministic args twice, assert same-result + a timeout. Gives the flag real teeth for executable predicates, but adds machinery the tool currently lacks, cannot catch all impurity (e.g. state-dependent predicates that happen to pass two calls), and predicates are not always executable in the check environment.
- **Option D — Re-anchor purity on a source-level annotation** — require a `pure`-style annotation in the target source, verified by `sourceRef` resolution. Stronger, but moves ceremony into user source code and adds extractor machinery — the opposite direction from this wave of simplification.

## Decision Outcome

Chosen option: **Option A, because the predicate declaration is the attestation.** A predicate cannot appear in a contract without being deliberately declared with a `sourceRef` that `validate` resolves against real source on every run — that is the human act that matters, and it is already enforced. The `verifiedPure` boolean adds a second, unenforceable claim whose failure mode is self-detecting at test runtime in the only path where purity is exercised. The field is a vestige of the registration/review era removed by ADR-0012 and ADR-0013. Existing workspaces that still carry the field continue to load (the loader validates required fields and does not reject unknown ones) — the field is silently ignored.

### Consequences

- **Positive:** authoring drops a mandatory ceremony field; the validator loses the `UNVERIFIED_PREDICATE` error tier and its gate logic; the `PredicateEntry` schema shrinks to what the generator actually consumes (`source`, `params`, `paramTypes`, `returnType`); the dead `sourceHash` FNV-1a code (leftover from ADR-0013) is removed with the same wave.
- **Negative:** the ADR-0006 default-deny posture is gone — any declared predicate is immediately referenceable, so an impure or non-terminating predicate is not caught until the first run of the generated suite (a hang in PBT mode is the worst case). Accepted: the boolean never prevented this.
- **Neutral:** ADR-0006's gate is superseded (its "future automated analysis can replace the manual flag without schema change" escape hatch is now moot — the schema change is this ADR); ADR-0013's "gate preserved" consequence is void; workspaces authored before this change are unaffected at load time.

### Confirmation

- `verifiedPure` is absent from: the predicate declaration schema (build-spec §3.4), `validatePredicatesShape` in the loader, the `PredicateEntry` type, the validator's `resolvePredicate`, and the predicate-registry contract. No `UNVERIFIED_PREDICATE` error code remains in the validator, contracts, or tests.
- `validate` still hard-errors on undeclared predicate references (`UNKNOWN_PREDICATE`) and still resolves every declared `sourceRef` under `config.sourceRoots`.
- The example workspace's `contracts.json` no longer carries `verifiedPure`.
- ADR-0006's status is flipped to `superseded` with a reference to this ADR.
- `scripts/validate-docs.sh` and `scripts/validate-contracts.sh` pass after the code, contract, and doc updates.

## More Information / Links

- Supersedes (gate aspect): [ADR-0006](0006-predicate-purity-registration-gate.md)
- Amends (consequence): [ADR-0013](0013-declarative-predicates-remove-registration-cli.md) · Related: [ADR-0012](0012-git-commit-as-approval-remove-review-gate.md) · [ADR-0017](0017-property-based-test-emission-mit-core.md)
- [Build spec §3.4 predicates.json](../build-spec.md#34-predicatesjson) · §5.1 validator checks · §14 open decisions
- [Contract: predicate-registry](../contracts/predicate-registry.contract.yaml) · [Spec: Predicate Registry](../specs/predicate-registry.md) · [Domain: Predicate Registry](../domains/predicate-registry.md)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-09-01 | associate-head-coach | Initial proposal |
| 2026-09-01 | associate-head-coach | Accepted by Head Coach |