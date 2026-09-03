# ADR: Declarative predicates — remove the predicate registration CLI

**ID:** ADR-0013
**Date:** 2026-08-22
**Status:** accepted
**Owner:** maintainer
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Contract expressions may call named predicates (registered in `predicates.json`) — ADR-0006 established a manual `verifiedPure` gate enforced by the semantic validator: any contract reference to a missing or unverified predicate is a hard error. The tooling around this data file is a CLI trio (`register-predicate`, `verify-purity`, `remind-unverified`) that adds ceremony to the TDD loop:

1. **Two forget-able steps:** register the predicate AND remember `--verifiedPure` (or run `verify-purity` later) — both fail loudly in `validate`, but both are commands with flags in a flow that should have one gate.
2. **The stored `sourceHash` is unmaintainable by hand** — FNV-1a over function source text — and nothing reads it after registration (no command drift-checks predicate hashes).
3. **Generated tests never execute predicates at runtime** — a predicate-call precondition yields a falsifying input by type heuristics (e.g. `-1` for `isPositive(price)`) and asserts the rejection idiom; the predicate is a semantic annotation of the contract, not code the suite calls. So the load-bearing parts are the **anti-hallucination check** (a contract can only call a real, resolvable function) and the **purity judgment** (a human vouches the function is pure) — not the CLI ceremony around them.

ADR-0012 established the pattern this decision follows: the authored file is the artifact, `validate` is the single gate, git commit is the approval. Predicate registration should be data in that same authored file, not a command sequence.

## Decision Drivers

- Streamline: predicate registration should be a declaration in the file being authored, not a CLI step with flags.
- Single gate: `validate` must catch missing, unresolvable, and unverified predicates in one place — nothing to forget in sequence.
- Consistency with ADR-0012: authored files + git commit = approval; a human's purity judgment is recorded as data, not ceremony.
- Anti-hallucination preserved: a predicate declaration's `sourceRef` must still resolve to a real exported top-level function (ADR-0005 "nothing invented").

## Considered Options

- **Option A — Declarative predicates in `contracts.json`, verified by `validate` (chosen)** — a top-level `predicates` map in `contracts.json` declares each predicate (`{ "<name>": { "source": "<Module.functionName>", "verifiedPure": true } }`); `validate` mechanically verifies every declaration (name validity, `sourceRef` resolution under `config.sourceRoots`); the validator keeps hard-erroring on missing/unverified references (ADR-0006 preserved). The CLI trio is removed; the stored `sourceHash` is dropped.
- **Option B — Keep the registration CLI (status quo)** — register-predicate / verify-purity / remind-unverified remain; the TDD loop keeps a separate, forget-able step and a hash nobody can compute by hand.
- **Option C — Fully implicit resolution** — contract predicate names resolve by searching `sourceRoots`; zero declarations. Most streamlined, but introduces name-collision ambiguity and implicit coupling, and is off-brand for a tool whose promise is explicit traceability.

## Decision Outcome

Chosen option: **Option A**, **because** it makes predicate registration part of authoring — the declaration sits in `contracts.json` next to the contracts that use it — and `validate` becomes the single gate that catches everything at once: parse errors, semantic errors, missing declarations, unresolvable `sourceRef`s, and unverified predicates. `register-predicate`, `verify-purity`, and `remind-unverified` are removed; the CLI drops from eight commands to five (`init`, `extract-manifests`, `validate`, `check`, `generate`). `verifiedPure` remains a human-set boolean (ADR-0006 gate preserved, re-expressed as data); the stored `sourceHash` is dropped — ADR-0005's "nothing invented" is served by `validate` resolving every `sourceRef` against real source on every run.

### Consequences

- **Positive:** one gate, zero command steps to forget; predicates and their contracts live in one file; the purity judgment is recorded by the author in the same model as contracts (authored file → validate → git commit).
- **Negative:** the registration-time mechanical proof (a stored hash written when the entry was created) is replaced by validate-time resolution — an entry's `sourceRef` could resolve while its implementation has drifted since the purity judgment. Accepted: the stored hash was never drift-checked by any command, and `validate --verbose` can surface the derived hash for transparency.
- **Neutral:** `predicates.json` retires from the versioned file set; the predicate-registry bounded context shrinks from CLI tooling to data + validator enforcement; ADR-0006's gate is retained but its mechanism is re-expressed declaratively.

### Confirmation

- `register-predicate`, `verify-purity`, and `remind-unverified` are absent from the CLI surface (`src/cli/index.ts` COMMANDS, README, build-spec §12).
- `contracts.json` carries a top-level `predicates` map; `validate` resolves and verifies every declaration's `sourceRef` under `config.sourceRoots`.
- The semantic validator still hard-errors on any contract reference to a missing or unverified predicate (ADR-0006).
- The example workspace's predicate is declared declaratively, and the generated suite remains byte-identical for the same contract.
- `scripts/validate-docs.sh` and `scripts/validate-contracts.sh` pass after the CLI/spec/contract updates.

## More Information / Links

- Retains: [ADR-0006](0006-predicate-purity-registration-gate.md) (purity gate, mechanism re-expressed) · [ADR-0005](0005-static-analysis-first-manifest-extraction.md) ("nothing invented" via validate-time resolution)
- Related: [ADR-0012](0012-git-commit-as-approval-remove-review-gate.md) (same authoring-as-artifact wave)
- [Build spec §3.4 predicates.json](../build-spec.md#34-predicatesjson) · [Spec: Predicate Registry](../specs/predicate-registry.md) · [Contract: predicate-registry](../contracts/predicate-registry.contract.yaml) (updated)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-22 | maintainer | Initial proposal |
| 2026-08-22 | maintainer | Accepted |