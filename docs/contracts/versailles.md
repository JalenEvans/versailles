# Contract Summary: Versailles CLI

**Machine contract:** [versailles.contract.yaml](versailles.contract.yaml)
**Spec:** [docs/specs/versailles.md](../specs/versailles.md)
**Status:** draft · **Validated:** pass

## What this context does

Versailles is the **machine-readable CLI surface** an external LLM/agent controls. It exposes
six deterministic subcommands — `init`, `extract-manifests`, `validate`, `check`, `generate`,
and `review <component> [operation]` — that parse arguments, route to the owning context for
each capability, and respond with stable JSON plus a stable exit code. The agent writes
contract objects, calls `validate`/`check`, reads the structured errors, fixes, and re-runs;
the CLI itself never prompts, calls, or retries an LLM.

## What it guarantees (must)

- Exactly the six commands above — **no `author` subcommand** exists (ADR-0010).
- Every command answers with the stable shape `{ ok, errors, warnings, exitCode }` as
  deterministic JSON — same input, same output, byte for byte.
- Every failure — bad arguments, unknown commands, load errors, validation errors, unknown
  review targets, staleness — is a **structured error, never an unstructured throw**.
- Exit codes: `0` clean / no staleness, `1` parse or validation errors present, `2` blocking
  staleness when `blockOnStale` is true (non-blocking staleness warns and exits `0`). The
  staleness math is computed by workspace-context and surfaced here.
- `generate` only runs against a valid context; an invalid context writes no test files.
- Workspace loading always goes through the workspace-context shared loader — nobody
  re-implements it.

## What it forbids (must not)

- No LLM invocation anywhere in the CLI — no client, no prompting, no retry loop.
- No unstructured throws on any path; no exit codes outside `{0, 1, 2}`.
- No nondeterministic output (no timestamps/randomness in machine output).
- No re-implementing loading, staleness, extraction, or generation mechanics — those are owned
  by their contexts; this one routes and surfaces.
- No non-JSON noise on stdout where an agent parses machine output.

## Grounding

[build-spec §6, §8, §9, §10, §12](../build-spec.md) · ADR-0002 (deterministic generation) ·
ADR-0010 (CLI never drives an LLM). Staleness exit-code mechanics live in
[workspace-context](workspace-context.contract.yaml); this contract surfaces them.