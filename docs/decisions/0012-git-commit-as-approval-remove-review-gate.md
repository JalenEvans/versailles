# ADR: Git commit as approval — remove the in-tool review gate

**ID:** ADR-0012
**Date:** 2026-08-22
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

The review bounded context is a human-in-the-loop CLI gate between **staged** contract objects (`.versailles/staged/<component>.json`, written by an external agent or by hand) and **approved** contracts in `contracts.json`: `versailles review <component> [operation] [--approve|--reject]` presents a scoped sub-object with raw `expr` + parsed AST, and `--approve` performs a single-object read-modify-write merge.

ADR-0003 already established the audit-trail principle: `contracts.json` carries no approval metadata, git history is the audit trail, and the merge commit *is* the approval. The review command was built to enforce that discipline mechanically — but it introduced ceremony that contradicts the tool's own philosophy:

1. **A staged object is a byte-for-byte duplicate** of the contract object awaiting merge — contracts live in two places (`.versailles/staged/` pending, `contracts.json` approved). A hand-authoring TDD user must write the contract into `staged/`, then run `review --approve` to copy the same content into `contracts.json`.
2. **Git + CI already provide everything the review gate provides:** pre-merge validation (`validate`/`check`, and CI on the commit), the approval record (the git commit itself), rejection (simply don't commit), and a scoped review view (`git diff` / PR review).
3. **Committing the code implicitly approves the contract** — the git commit of `contracts.json` *is* the approval. A separate in-tool approval command is redundant with the tool's own audit-trail decision.

## Decision Drivers

- Simplicity: the TDD loop should be author contract → `validate` → `generate` → commit; no staging, no review command.
- Single source of truth: contracts live only in `contracts.json`; no out-of-band staged copies.
- Git-native review: PRs and diffs are better human review tooling than a bespoke CLI view.
- Consistency with ADR-0003: approval is expressed by committing, never by an in-tool mechanism.

## Considered Options

- **Option A — Remove the review gate and staging (chosen)** — contract objects are authored directly into `contracts.json` (by hand or by any external tool); `validate`/`check` + CI gate correctness; the git commit is the approval. The parser-sanity expr + AST view moves into `validate --verbose`.
- **Option B — Keep review as read-only inspection** — drop `--approve`/`--reject` but keep a scoped view command. Preserves a debugging view without the gate, but adds CLI surface that `validate --verbose` already covers.
- **Option C — Status quo** — stage → review → approve. Retains mechanical single-object merge discipline but keeps the duplicate-contract confusion and the extra steps.

## Decision Outcome

Chosen option: **Option A**, **because** it restores `contracts.json` as the single source of truth, collapses the TDD loop to author → validate → generate → commit, and takes ADR-0003's audit-trail principle to its logical conclusion — the git commit is the approval, so no in-tool approval mechanism should exist. The `review` command, `src/review/`, and `.versailles/staged/` are removed; the scoped expr + AST parser-sanity view is folded into `validate --verbose`; validation is enforced by `validate`/`check` and CI.

This ADR **supersedes the tool-enforced single-object review-merge mechanism** from ADR-0003 (and its "requires git discipline" consequence); ADR-0003's core — git history is the audit trail, no `approvedBy`/`approvedAt` in the schema — remains in force. Commit granularity is left to the user.

### Consequences

- **Positive:** TDD loop drops two steps (staging + review) and a directory; `contracts.json` is again the single source of truth; the CLI drops from nine commands to eight; human review happens in the git layer (PR/diff) where the repo's own pipeline already gates.
- **Negative:** the mechanical per-object merge discipline is gone — multiple contract objects can land in one commit (git blame still records who/what/when); the dedicated scoped review presentation is gone (mitigated by `validate --verbose`).
- **Neutral:** the `review` bounded context is retired — its spec, contract, domain doc, and feature doc are removed; ADR-0010's "external agent stages for review" narrative is retired with it.

### Confirmation

- The `review` command is absent from the CLI surface (`src/cli/index.ts` COMMANDS, README, build-spec §12).
- No `.versailles/staged/` directory anywhere in the repo or the example workspace.
- `validate --verbose` emits raw `expr` strings alongside their parsed AST.
- `contracts.json` schema still contains no approval metadata; ADR-0003's core remains documented as accepted.
- `scripts/validate-docs.sh` and `scripts/validate-contracts.sh` pass after the docs/contract retirement.

## More Information / Links

- Supersedes (mechanism aspect): [ADR-0003](0003-git-history-as-audit-trail.md)
- Related: [ADR-0010](0010-cli-never-drives-llm.md) (agent-authored staging narrative retired), [ADR-0011](0011-contract-first-emission.md) (contract-first TDD loop)
- [Build spec §11 Human review](../build-spec.md#11-human-review) (retired), §12 CLI command table
- [Spec: Review](../specs/review.md) · [Contract: review](../contracts/review.contract.yaml) · [Domain: Review](../domains/review.md) · [Feature: Human Review](../features/human-review.md) (retired)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-22 | associate-head-coach | Initial proposal |
| 2026-08-22 | associate-head-coach | Accepted by Head Coach |