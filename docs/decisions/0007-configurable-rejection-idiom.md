# ADR: Configurable rejection idiom, default `throws`

**ID:** ADR-0007
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Canonical source:** `~/.opencode/skills/adr-builder/references/adr.template.md`

---

## Context and Problem Statement

Precondition-violation test cases must assert that the operation *rejects* the input. The rejection idiom varies by language and runtime: `throws` (JS/TS/Python-family), error return values (Go, Elixir), `Result` types, etc. Hardcoding "throws" would make generated tests wrong for any language whose idiom is not exceptions.

## Decision Drivers

- Language portability: the grammar/validator/generator stay language-agnostic (ADR-0008), so the emitter must adapt.
- Clarity: generated tests must assert the project's actual rejection idiom.
- Default ergonomics: most v1 targets throw on invalid input.

## Considered Options

- **Hardcode "throws"** — simplest, but wrong for error-return languages.
- **Configurable, default `throws` (chosen)** — `config.json` carries the rejection idiom; the generator's violation-case emitter asserts per that idiom.

## Decision Outcome

Chosen option: **configurable rejection idiom, defaulting to `throws`**, **because** it keeps the core language-agnostic while producing correct assertions for the target framework and runtime.

### Consequences

- **Positive:** portability to non-throwing languages is preserved.
- **Negative:** one more config knob to document and validate.
- **Neutral:** the default covers the v1 target family (JS/TS, Python).

### Confirmation

- `config.json` has an explicit rejection-idiom setting (default `throws`).
- The generator reads it when emitting precondition-violation assertions.

## More Information / Links

- [Build spec §9.1 per-operation cases](../build-spec.md#91-per-operation-test-cases-from-preconditionspostconditions), [§14 row: Rejection idiom](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |