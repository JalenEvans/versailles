# Feature: Human Review & Approval

**Command:** `versailles review <component> [operation] [--approve|--reject]`
**Primary context:** [review](../domains/review.md) (+ workspace-context, contract-language)
**Vocabulary:** [glossary](../glossary.md) — *staged contract, approved contract, scoped extraction, audit trail*

## Overview

The human gate between **staged** and **approved** contracts. A reviewer sees one component/operation at a time (never the whole file), checks raw expressions against their pretty-printed AST and any warnings, and approval is expressed as a **single-object merge commit** — git history is the audit trail (ADR-0003).

## User story

> As a reviewer, I want to approve one contract object at a time with full context (raw expression + AST + warnings), so each approval is a deliberate, auditable commit.

## Flow

1. Pick a staged contract; the workspace-context's **scoped extraction** returns just that component/operation sub-object plus its errors (never the whole file).
2. The review view shows (build-spec §11):
   - the scoped sub-object;
   - raw `expr` strings alongside parsed/normalized AST (pretty-printed) as a parser-sanity check;
   - any validator warnings (non-blocking) for awareness.
3. On approval, merge the **single contract object** into `contracts.json` via read-modify-write of just that key — never a full-file rewrite.
4. Git records the approval: the merge commit *is* the approval; no `approvedBy`/`approvedAt` fields exist anywhere.

## Domain events

- `contractApproved` — single-object merge recorded by git.
- `contractDeclined` — no merge commit; the staged object never enters the audit trail.

## Business rules

- Review is scoped — never a whole-file view (build-spec §11).
- Merge is read-modify-write of one key — never a full-file LLM rewrite (build-spec §11).
- No approval metadata in the schema; approve-by-merge only (ADR-0003).
- Staged vs. merged is distinguished via git state, not metadata (ADR-0003).

## Edge cases

- **Approval races another authoring change** → single-key read-modify-write must handle a concurrently-updated file (merge discipline; git conflict is the backstop).
- **Declined contract** → no git artifact; the reviewer's rationale lives in the review channel, not the schema.
- **Traversal-target refusal** → `review` refuses component/operation names containing `..`, `/`, or `\` with a structured `INVALID_TARGET` error before any staged read or merge — staged objects must stay inside `.versailles/staged/`.

## Source of authority

[build-spec §11](../build-spec.md) · [ADR-0003](../decisions/0003-git-history-as-audit-trail.md)