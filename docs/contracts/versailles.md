# Contract Summary: Versailles CLI

**Machine contract:** [versailles.contract.yaml](versailles.contract.yaml)
**Spec:** [docs/specs/versailles.md](../specs/versailles.md)
**Status:** draft · **Validated:** pass

## What this context does

Versailles is the **deterministic, machine-readable CLI surface** of the tool. It exposes
five subcommands — `init`, `extract-manifests`, `validate`, `check`, `generate` — that parse
arguments, route to the owning context for each capability, and respond with stable JSON
plus a stable exit code. The root-level flags `versailles -v` / `versailles --version`
short-circuit before command dispatch — they print the tool version and exit `0` from any
directory, never loading the workspace (VERSAILLES-171). The tool never invokes an LLM
(ADR-0010). The authored file is the artifact; the git commit is the approval (ADR-0003,
ADR-0012). No in-tool review or approval ceremony exists.

## What it guarantees (must)

- Exactly the five commands above — **no `review`, `register-predicate`, `verify-purity`,
  `remind-unverified`, or `author` subcommand** exists (ADR-0010, ADR-0012, ADR-0013).
- Root-level `versailles -v` / `--version` print the tool version and exit `0` from any
  directory — a flag, not a command; subcommands reject `-v` / `--version` as usage errors,
  and `--verbose` stays the only `validate` flag (long-only) (VERSAILLES-171).
- `check`, `generate`, and `extract-manifests` share one workspace gate
  (`requireValidWorkspace`); every invalid-context failure path exits `1` with the
  standardized empty output envelope `{}` — no command re-implements the envelope
  (VERSAILLES-171).
- Every command answers with the stable shape `{ ok, errors, warnings, exitCode }` as
  deterministic JSON — same input, same output, byte for byte.
- Every failure — bad arguments, unknown commands, load errors, validation errors,
  staleness — is a **structured error, never an unstructured throw**.
- Exit codes: `0` clean / no staleness, `1` parse or validation errors present, `2` blocking
  staleness when `blockOnStale` is true (non-blocking staleness warns and exits `0`). The
  staleness math is computed by workspace-context and surfaced here.
- `generate` only runs against a valid context; an invalid context writes no test files.
- Workspace loading always goes through the workspace-context shared loader — nobody
  re-implements it.
- `validate --verbose` surfaces raw `expr` + parsed AST per clause as a parser-sanity check
  (ADR-0012).

## What it forbids (must not)

- No LLM invocation anywhere in the CLI — no client, no prompting, no retry loop.
- No unstructured throws on any path; no exit codes outside `{0, 1, 2}`.
- No nondeterministic output (no timestamps/randomness in machine output).
- No re-implementing loading, staleness, extraction, or generation mechanics — those are owned
  by their contexts; this one routes and surfaces.
- No non-JSON noise on stdout where CI parses machine output.
- No in-tool review or approval ceremony — the git commit is the approval (ADR-0012).

## Grounding

[build-spec §6, §8, §9, §10, §12](../build-spec.md) · ADR-0002 (deterministic generation) ·
ADR-0010 (CLI never drives an LLM) · ADR-0012 (git commit as approval) · ADR-0013
(declarative predicates). Staleness exit-code mechanics live in
[workspace-context](workspace-context.contract.yaml); this contract surfaces them.
