# Spec: Review

**ID:** SPEC-rv
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** data (approval mutates `contracts.json`, the tool's data layer), state (staged → approved is an irreversible state transition; rejection must write nothing)
**Linked contract:** `docs/contracts/review.contract.yaml`
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

Human review is the human-in-the-loop gate between staged contract objects and approved contracts (build-spec §11). A reviewer sees a **scoped** diff of one component/operation sub-object — produced by workspace-context's scoped extraction, never the whole file — with raw `expr` strings alongside their pretty-printed AST (a parser-sanity check) and any non-blocking validator warnings. On approval, the single contract object is merged into `contracts.json` via read-modify-write of just that key; on rejection, nothing is written. The schema contains **no** approval metadata — git history is the audit trail, and the merge commit *is* the approval (ADR-0003). Staged objects arrive from the external-agent flow: an agent authors and validates contract objects through the CLI, and the tool itself never invokes an LLM (ADR-0010).

## Scope

**In scope:**
- Presenting a scoped review view: one component/operation sub-object via scoped extraction, never the whole file (build-spec §11).
- Showing raw `expr` strings alongside their parsed/normalized AST (pretty-printed) as a parser-sanity check, plus any validator warnings for reviewer awareness (build-spec §11).
- Approve: merge the single contract object into `contracts.json` programmatically — read-modify-write of just that key, never a full-file rewrite (build-spec §11, ADR-0003).
- Reject: write nothing to `contracts.json`; no merge commit, so the staged object never enters the audit trail (glossary: `contractDeclined`).
- The audit trail via git: no `approvedBy`/`approvedAt` (or similar) fields in the schema; the per-object merge commit and `git blame`/`git log` are the record (ADR-0003).
- Distinguishing staged vs. merged state via git state rather than in-band metadata (ADR-0003).
- Working with agent-authored staged objects: an external agent authors and validates contract objects via the CLI; the tool never invokes an LLM (ADR-0010).

**Out of scope:**
- Deciding the review UI form factor (CLI diff view vs. simple web UI) — build-spec §11 explicitly leaves this open.
- Contract authoring or validation inside the tool — staged objects come from the external-agent flow; validation internals belong to contract-language (ADR-0010).
- Merging more than one object per approval — approval is a single-object read-modify-write.
- Retention/cleanup policy for declined staged contracts — an open question in the domain doc, to be decided with the review UI.
- Any LLM involvement: the tool never prompts, calls, or retries an LLM (ADR-0010).

## Behavior

### The review view is scoped to one sub-object

- **Given** a staged contract object in the review flow
- **When** `versailles review <component> [operation]` launches
- **Then** the reviewer sees only the scoped component/operation sub-object (via scoped extraction) plus its errors/warnings — never the whole `contracts.json` file (build-spec §11)

### The review view is a parser-sanity check

- **Given** a staged contract object
- **When** it is displayed to the reviewer
- **Then** each raw `expr` string is shown alongside its pretty-printed AST and any validator warnings, so the reviewer can sanity-check what the parser understood (build-spec §11)

### Approval merges exactly one object

- **Given** a reviewer approves a staged, validated contract object
- **When** the approval executes
- **Then** `contracts.json` is updated by read-modify-write of just that key — a single-object merge — recorded as a distinct, reviewable commit; no approval metadata is written (ADR-0003, build-spec §11)

### Rejection writes nothing

- **Given** a reviewer declines a staged contract object
- **When** the rejection path executes
- **Then** nothing is written to `contracts.json` and no merge commit is created — the staged object never enters the audit trail (glossary: `contractDeclined`)

### Review targets are confined to `.versailles/staged/`

- **Given** a `versailles review` invocation whose component/operation argument contains `..`, `/`, or `\`
- **When** the review flow starts
- **Then** the target is refused with a structured `INVALID_TARGET` error before any staged read or merge — staged objects must stay inside `.versailles/staged/`, and a traversal target can never be viewed, approved, or merged

### The audit trail is git, and git state distinguishes staged vs. merged

- **Given** an approved contract or a contract object present in the workspace
- **When** anyone asks who approved it and when, or whether it is staged or merged
- **Then** the answer comes from git commit history / `git blame` and git state — the `contracts.json` schema contains no `approvedBy`/`approvedAt` fields, and staged (not yet merged) vs. approved (merged via a single-object commit) is determined by git state, not in-band metadata (ADR-0003)

### Review consumes agent-authored staged objects without an LLM

- **Given** an external agent that authored and validated a contract object via the CLI (`validate`/`check`) and staged it for review
- **When** the review flow consumes it
- **Then** the staged object is presented and merged as-is on approval — and the tool itself never invoked an LLM anywhere in the flow (ADR-0010)

## Constraints

- `must_not` show the whole `contracts.json` file in review — the view is always the scoped component/operation sub-object (build-spec §11).
- `must_not` rewrite the whole file on approval — read-modify-write of one key only (build-spec §11, ADR-0003).
- `must_not` write anything to `contracts.json` on rejection (glossary: `contractDeclined`).
- `must_not` add approval metadata (`approvedBy`, `approvedAt`, or equivalents) to the schema — git history is the audit trail (ADR-0003).
- `must_not` invoke an LLM anywhere in the review flow — staged objects come from an external agent, and the tool never prompts, calls, or retries an LLM (ADR-0010).
- Each approval `must_not` touch more than one object — review merges must be single-object commits for a clean audit trail (ADR-0003).

## Non-Goals

- No decision on the review UI form factor (CLI diff view vs. web UI) — left open by build-spec §11.
- No in-tool contract authoring, prompting, or LLM retry loop (ADR-0010).
- No approval metadata of any kind in the schema (ADR-0003).
- No retention policy for declined staged objects (open question in the review domain doc).
- No batch/multi-object approval flow.

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build-spec §11; ADR-0003/0010 |
| 2026-08-13 | associate-head-coach | Removed Linked Plans section — execution plans are tracked outside the public repo |
| 2026-08-16 | associate-head-coach | Added traversal-target confinement behavior (INVALID_TARGET guard) — shipped with the review flow (PR feat/review-ecosystem) |