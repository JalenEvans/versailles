# Domain: Review

**Bounded context:** `review`

## Responsibility (what this context owns)

Human review and approval of **staged contracts** — the human-in-the-loop gate between external contract authoring and approved contracts:

- Presenting a **scoped** view of a staged contract (one component/operation sub-object via workspace-context's scoped extraction) — never the whole file.
- Showing raw `expr` strings alongside their pretty-printed AST (parser-sanity check) and any validator warnings (non-blocking, for reviewer awareness).
- On approval, **merging the single contract object** into `contracts.json` via read-modify-write of just that key — never a full-file rewrite.
- Expressing the **audit trail via git**: the merge commit *is* the approval; the schema contains **no** `approvedBy`/`approvedAt` fields (ADR-0003).
- Distinguishing staged vs. merged state via git state rather than metadata.

## Domain model

**StagedContract** (entity) — a validated contract object staged by the external agent flow, awaiting review. (Consumed here; the staging side lives outside the tool.)

**ScopedDiff** (value object) — the component/operation sub-object plus its errors/warnings, produced by workspace-context's scoped extraction.

**Approval** (value object / process) — the reviewer's decision, expressed as a single-object read-modify-write commit of one key of `contracts.json`. Not a field — a git commit.

**Reviewer** (actor, human) — the person who approves or declines.

**AuditTrail** (concept) — git blame/commit history; tamper-evident, never silently editable.

## Ubiquitous language

Uses from [glossary](../glossary.md): *staged contract, approved contract, scoped extraction, audit trail, contract, clause, expression, AST, structured error*. "Accept" is *approve*; "the who/when record" is the *audit trail (git history)*; the review target is *staged* until merged, then *approved*.

## Domain events

- `contractApproved` — the single object merged into `contracts.json`; recorded by git as a merge commit.
- `contractDeclined` — no merge commit created; the staged object never enters the audit trail.

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | external agent flow (via CLI) | Consumes validated contract objects staged for review. |
| Downstream of | workspace-context | Scoped extraction provides the per-object review view. |
| Upstream of | workspace-context | The merge writes back into `contracts.json` inside the workspace. |
| Downstream of | contract-language | Warnings + pretty-printed AST come from the validation pipeline. |

## Business rules

- Review shows a **scoped** sub-object, never the whole file (build-spec §11).
- Approval merges **one object** via read-modify-write of just that key — never a full-file rewrite (build-spec §11, ADR-0003).
- The schema contains **no approval metadata**; git blame/commit history is the audit trail (ADR-0003).
- Each approval is a distinct, reviewable merge commit — requires git discipline: review merges must be single-object commits (ADR-0003).

## Open questions

- Review UI form factor (CLI diff view vs. simple web UI) — build-spec §11 explicitly leaves the choice open.
- How long declined/abandoned staged contracts remain visible before cleanup — not specified; decide with the review UI.

## Source of authority

[build-spec.md §11](../build-spec.md) · [ADR-0003 git history as audit trail](../decisions/0003-git-history-as-audit-trail.md) · [Spec: Versailles contract pipeline](../specs/versailles.md)