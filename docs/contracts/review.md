# Contract Summary: Review

**Machine contract:** [review.contract.yaml](review.contract.yaml)
**Spec:** [docs/specs/review.md](../specs/review.md)
**Status:** draft · **Validated:** pending

## What this context does

Review is the **human-in-the-loop approval gate** between staged contract objects and approved
contracts. A reviewer looks at a scoped view of one component/operation — never the whole
`contracts.json` — with raw `expr` strings shown next to their pretty-printed AST (a
parser-sanity check) and any non-blocking validator warnings. Approving merges exactly one
object into `contracts.json`; declining writes nothing at all.

## What it guarantees (must)

- The review view is always the scoped component/operation sub-object from workspace-context's
  extraction helper, plus its errors and warnings.
- Approval = **read-modify-write of just that one key**, recorded as a distinct, reviewable
  commit — each approval is a single-object commit.
- Rejection = nothing written, no merge commit; the staged object never enters the audit trail.
- Staged vs. merged state is determined by **git state** (commit history / `git blame`), never
  by in-band metadata.
- Agent-authored staged objects are consumed as-is on approval — the tool never re-authors them.

## What it forbids (must not)

- No showing the whole `contracts.json` file in review.
- No full-file rewrites on approval; no writes at all on rejection.
- No approval metadata (`approvedBy`, `approvedAt`, or equivalents) anywhere in the schema —
  git history is the audit trail.
- No LLM invocation of any kind in the review flow; no approval that touches more than one
  object.

## Grounding

[build-spec §11](../build-spec.md) · ADR-0003 (git history as audit trail) · ADR-0010 (no
in-tool LLM)