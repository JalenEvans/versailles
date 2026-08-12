# Feature: Agent-Driven Contract Authoring

> Authoring is an **external** workflow: an LLM/agent authors contract objects and drives the CLI to validate them. Versailles itself never drives an LLM — there is no `versailles author` subcommand, no LLM client, no prompting logic, no retry-against-LLM loop inside the tool (ADR-0010).

**Command:** the machine-readable CLI surface — `validate` / `check` (no `author` subcommand)
**Primary context:** cross-cutting (CLI) + contract-language, workspace-context, manifest-extraction
**Vocabulary:** [glossary](../glossary.md) — *staged contract, agent iteration, structured error, exit code, config, source root, manifest / field manifest, verifiedPure*

## Overview

Contract **authoring is an external-agent workflow**: an external LLM/agent drafts contract objects from source-derived context and drives the CLI to check them. The tool's contribution is a deterministic, machine-readable CLI surface — structured errors, stable JSON output, exit codes `0`/`1`/`2` — that the agent consumes and iterates against. The iteration contract lives between the agent and the CLI's output, not inside the tool (build-spec §10). Authoring is deliberately *not* generation: the agent never touches `generated/`, and generated tests come only from approved contracts.

## User story

> As an LLM/agent, I want to author contract objects from source context and check them with a deterministic CLI, so mechanical validation catches my errors before a human reviews them — with the guarantee that nothing unvalidated reaches `contracts.json`.

## Flow

1. The external agent reads the manifest entry for the target component (+ predicate registry) as grounding context.
2. It authors **a single contract object** (component scope, or operation scope) conforming to the `contracts.json` schema, using only fields/predicates present in the provided context.
3. It calls `versailles validate` (or `check`); the CLI runs parse + semantic validation (contract-language) and responds with structured JSON output + exit codes — never prompting, never retrying, never invoking an LLM itself.
4. On failure: the agent reads the **structured errors**, fixes the object, and re-runs — the iteration contract is between the agent and the CLI's output, not a loop inside the tool (build-spec §10).
5. On success: the validated object proceeds to human review (`contractStaged`) — the CLI never merges automatically.

## Domain events

- `contractStaged` — validated object enters the review queue.
- `contractInvalid` — structured validation failures the agent must fix.

## Business rules

- The tool never invokes an LLM; authoring iteration happens at the integration boundary (ADR-0010, build-spec §10).
- Output scope is one object — components or operations, never a full-file rewrite (build-spec §10).
- Grounding is strict: only fields/predicates present in the provided context may be referenced.
- Predicates referenced by authored contracts must be registered with `verifiedPure: true` (ADR-0006).
- All CLI output is machine-readable: structured errors, stable JSON, deterministic exit codes (build-spec §4.4, §5.2, §8).

## Edge cases

- **Agent submits an invalid object repeatedly** → the CLI keeps returning deterministic structured errors; there is no in-tool retry cap because there is no in-tool loop — the agent decides when to stop or escalate.
- **Agent references an unknown field** → `UNKNOWN_FIELD` structured error; the agent fixes against it.
- **Predicate lacks `verifiedPure`** → hard validation error (ADR-0006) — the authored contract cannot reference it.

## Source of authority

[build-spec §10](../build-spec.md) · [ADR-0010](../decisions/0010-cli-never-drives-llm.md) · [ADR-0006](../decisions/0006-predicate-purity-registration-gate.md)
