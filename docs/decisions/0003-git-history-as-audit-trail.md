# ADR: Git history as audit trail (no approval fields in schema)

**ID:** ADR-0003
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Contracts are auditable by design: every clause traces to a source hash and every generated test traces to a clause. The remaining question is *who approved what, and when*. Earlier discussion established that in-band approval metadata (`approvedBy`/`approvedAt` fields) on contract objects is the wrong mechanism; this ADR records that decision and its reasoning.

## Decision Drivers

- Schema minimalism: keep `contracts.json` small and focused on contract semantics.
- Trust: in-file metadata can be forged or drift from reality; git history cannot.
- Existing tooling: the repo already runs a review-and-merge workflow through git.

## Considered Options

- **In-band fields (`approvedBy`/`approvedAt`) on contract objects** — self-contained, but bloats the schema, can be forged/stale, and duplicates what git already records.
- **Out-of-band: git blame + commit history (chosen)** — approval is expressed by a merge commit touching exactly that object; the audit trail is `git log` / `git blame`.

## Decision Outcome

Chosen option: **git history as the audit trail**, **because** git already records who merged what and when, in a way that cannot be silently edited (history rewrite is visible). Human approval is expressed by merging a single contract object via read-modify-write of that key — never a full-file rewrite — so each approval is a distinct, reviewable commit.

### Consequences

- **Positive:** schema stays minimal; audit trail is tamper-evident via git.
- **Negative:** requires git discipline — review merges must be single-object commits for the audit to be clean.
- **Neutral:** the review UI distinguishes staged vs. merged via git state rather than metadata.

### Confirmation

- `contracts.json` schema contains no `approvedBy`/`approvedAt` fields.
- Review merges appear in history as distinct per-object commits (read-modify-write of one key).

## More Information / Links

- [Build spec §11 Human review](../build-spec.md#11-human-review)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |