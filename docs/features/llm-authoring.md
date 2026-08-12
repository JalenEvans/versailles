# Feature: LLM Contract Authoring

**Command:** `versailles author <component> [operation]`
**Primary context:** [authoring-loop](../domains/authoring-loop.md) (+ contract-language, workspace-context)
**Vocabulary:** [glossary](../glossary.md) — *authored contract, staged contract, correction prompt, failed-generation case, structured error, verifiedPure*

## Overview

The **only** LLM path in the pipeline (ADR-0002): the LLM drafts contract objects from source-derived context, and every draft is mechanically validated before a human ever sees it. Authoring is deliberately *not* generation — the LLM never touches `generated/` and never merges anything.

## User story

> As a developer, I want an LLM to write my component contracts, so I don't hand-author expressions — with the guarantee that nothing unvalidated and nothing hallucinated reaches my `contracts.json`.

## Flow

1. Load the manifest entry for the target component (+ predicate registry) as the LLM's grounding context.
2. Prompt the LLM to emit **a single contract object** (component scope, or operation scope) conforming to the `contracts.json` schema, using only fields/predicates present in the provided context.
3. Run parse + semantic validation (contract-language) against the output.
4. On failure: feed the **structured errors** back as a **correction prompt**; retry up to the cap (e.g. 3).
5. On success: **stage** the validated contract object for review (`contractStaged`) — never merge automatically.
6. Retry cap exhausted: surface a **failed-generation case** to a human.

## Domain events

- `contractStaged` — validated object enters the review queue.
- `contractInvalid` — validation failures feed correction prompts.

## Business rules

- No LLM output reaches a human before mechanical validation (ADR-0002, build-spec §10).
- Output scope is one object — components or operations, never a full-file rewrite (build-spec §10).
- Grounding is strict: only fields/predicates present in the provided context may be referenced.
- Retry is capped; persistent failure surfaces to a human, never an infinite loop (build-spec §10).
- Predicates referenced by authored contracts must be registered with `verifiedPure: true` (ADR-0006).

## Edge cases

- **Persistent validation failure after cap** → failed-generation case reported; no staging, no merge.
- **LLM references an unknown field** → `UNKNOWN_FIELD` structured error → correction prompt; if it persists, the case surfaces to a human.
- **Predicate lacks `verifiedPure`** → hard validation error (ADR-0006) — the authored contract cannot reference it.

## Source of authority

[build-spec §10](../build-spec.md) · [ADR-0002](../decisions/0002-deterministic-generation-llm-authoring-only.md) · [ADR-0006](../decisions/0006-predicate-purity-registration-gate.md)