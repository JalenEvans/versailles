# ADR: The CLI never drives an LLM; LLMs drive the CLI

**ID:** ADR-0010
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Versailles is a tool an LLM/agent is meant to *control*: the LLM is an external actor that calls the CLI (`validate`, `check`, `generate`, …), reads structured errors, and iterates. The prior architecture (ADR-0002, build-spec §10, SPEC-ver scenarios) inverted this: it put an LLM authoring loop *inside* the tool — a `versailles author` subcommand that prompted an LLM to write contracts, parsed and validated the output, retried on structured errors (capped), and staged results for human review. That direction is wrong for a tool whose core promise is reproducibility: an in-tool LLM loop drags in an LLM client, prompting logic, retry machinery, API keys, and network access, all inside a deterministic, certifiable pipeline. The tool should never manipulate an LLM; an LLM should manipulate the tool.

## Decision Drivers

- Control direction: the tool is meant to be controlled by an LLM agent, not to manipulate one.
- Determinism: CLI behavior must be identical for every caller — human or agent — so agents can rely on stable output.
- Testability: no LLM call sites means the entire tool is unit-testable offline, with no mocking of LLM services.
- Dependency-free: no LLM client, no API keys, no network — cheap to run in CI and easy to certify.
- Cost: no per-invocation LLM fees anywhere in the validation/generation path.

## Considered Options

- **In-tool LLM authoring loop (ADR-0002, superseded)** — `versailles author` prompts, validates, retries (capped), stages. Keeps authoring close, but injects nondeterminism, network/API-key dependency, and untestable call sites into the tool.
- **External agent drives the CLI (chosen)** — the CLI exposes deterministic commands with structured JSON output and stable exit codes; an external LLM/agent writes contract objects, calls `validate`/`check`, reads structured errors, fixes, and re-runs. The tool never invokes an LLM.
- **Do nothing (keep ADR-0002 as-is)** — retains a nondeterministic, network-dependent authoring path inside a tool whose entire value proposition is reproducibility.

## Decision Outcome

Chosen option: **external agent drives the CLI**, **because** it keeps Versailles deterministic, testable, dependency-free (no API keys, no network), and cheap to certify, while still allowing LLM-assisted contract authoring as an *external* workflow. Versailles contains no LLM client, no prompting logic, and no retry loop that calls an LLM. LLM/agent integration is external: an agent invokes the CLI's deterministic commands, parses structured JSON output + exit codes, and iterates. `versailles author` is dropped from the CLI surface. This supersedes the authoring-loop aspect of ADR-0002; the deterministic-generation core of ADR-0002 remains in force.

### Consequences

- **Positive:** the CLI is fully deterministic and offline-testable; no LLM dependency, API keys, or network in the tool; agent iteration happens at the integration boundary, where it is cheap to test with a stubbed external agent.
- **Negative:** contract-authoring productivity now depends on the quality of the external agent workflow and on the CLI's structured-error surface — the CLI must make errors precise enough for an agent to fix in one or two iterations.
- **Neutral:** build-spec §10 and §13 milestone 6 are rewritten to describe the machine-readable CLI surface instead of an in-tool authoring loop; tests for agent iteration patterns live at the integration boundary, not inside the tool.

### Confirmation

- The repository contains no LLM client dependency, no prompt templates, and no code path that calls an LLM (no LLM HTTP call sites).
- The CLI command surface has no `author` subcommand.
- Every CLI command emits structured JSON output and deterministic exit codes (`0`/`1`/`2`).
- The package exposes no importable library surface: `package.json` `exports` exposes only `.` (no deep import paths); `src/index.ts` exports only `packageName`. Integration is via the CLI binary as a subprocess (structured JSON + exit codes), never in-process imports.
- Agent-iteration scenarios (write → validate → structured error → fix → re-run) are covered by integration tests that drive the CLI as an external agent would — not by in-tool LLM mocking.

## More Information / Links

- Supersedes (authoring-loop aspect): [ADR-0002: Deterministic generation; LLM confined to authoring](0002-deterministic-generation-llm-authoring-only.md)
- [Build spec §10 Machine-readable CLI surface for agent control](../build-spec.md#10-machine-readable-cli-surface-for-agent-control)
- Behavioral spec: [docs/specs/versailles.md](../specs/versailles.md)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |
| 2026-08-19 | general-manager | Confirmation added: no importable library surface — integration via CLI subprocess + structured JSON, never in-process imports |
