# Domain: Authoring Loop

**Bounded context:** `authoring-loop`

## Responsibility (what this context owns)

The LLM-assisted **authoring** of contracts — the only place an LLM is allowed in the pipeline (ADR-0002):

- Prompting the LLM to emit a **single contract object** (one component or one operation — never a full-file rewrite) conforming to the `contracts.json` schema, grounded only in fields/predicates present in the provided context (the component's manifest entry + the predicate registry).
- Running parse + semantic validation against every LLM output.
- On failure: feeding the **structured error(s)** back to the LLM as a **correction prompt**, retrying with a cap (e.g. 3), then surfacing a **failed-generation case** to a human rather than looping indefinitely.
- On success: **staging** the validated contract object for human review — it is **never merged** into `contracts.json` automatically.

The context does not own test generation, does not own the grammar, and has no write access to approved contracts.

## Domain model

**AuthoredContract** (entity) — the draft contract object emitted by the LLM, conforming to the `contracts.json` schema (component or operation scope).

**StagedContract** (entity) — an `AuthoredContract` that passed parse + semantic validation and now awaits human review (`contractStaged`).

**CorrectionPrompt** (value object) — the re-prompt containing structured errors from the failed validation, asking the LLM to correct the single object.

**RetryCap** (value object / config) — maximum retries (e.g. 3) before surfacing a failed-generation case.

**FailedGenerationCase** (entity) — the surfaced outcome when the retry cap is exhausted; routed to a human, never merged.

## Ubiquitous language

Uses from [glossary](../glossary.md): *staged contract, correction prompt, failed-generation case, structured error, contract, clause, predicate, manifest / field manifest*. "LLM output" is an *authored contract*; "prompt again" is a *correction prompt*; "ready for review" is *staged*.

## Domain events

- `contractStaged` — a validated contract object entered the review queue.

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | Loads the component's manifest entry + predicate registry as the LLM's grounding context. |
| Downstream of | contract-language | Its parser + semantic validator gate every LLM output; structured errors drive correction prompts. |
| Upstream of | review | Emits `StagedContract` objects; the reviewer approves or declines. |
| Downstream of | manifest-extraction | Grounding context (manifests) — via workspace-context. |

## Business rules

- **No LLM output reaches a human before mechanical validation** (parse + semantic) — ADR-0002, build-spec §10.
- The LLM emits **one contract object**, never a full-file rewrite (build-spec §10).
- The LLM may use **only fields/predicates present in the provided context** — grounding prevents hallucinated references.
- Retry is **capped** (e.g. 3); persistent failure surfaces as a failed-generation case, never an infinite loop (build-spec §10).
- Success **stages**, never merges — merge happens only through human review (ADR-0002, ADR-0003).

## Open questions

- Exact retry cap value (build-spec §10 specifies "e.g. 3") and whether the cap is configurable.
- Prompt format and context-packaging details for each language pair — implementation concern, pinned when the authoring contract is authored.

## Source of authority

[build-spec.md §10](../build-spec.md) · [ADR-0002 deterministic generation; LLM confined to authoring](../decisions/0002-deterministic-generation-llm-authoring-only.md) · [ADR-0003 git history as audit trail](../decisions/0003-git-history-as-audit-trail.md) · [Spec: Versailles contract pipeline](../specs/versailles.md)