# ADR: Package `versailles-dbc`, CLI `versailles`

**ID:** ADR-0001
**Date:** 2026-08-11
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

The npm package name `versailles` is already registered by an unmaintained placeholder, so the package cannot be published under the bare name. The tool's identity as a CLI, however, is "versailles". We need a package name that is publishable on the registry while keeping a discoverable, stable CLI command that matches the product's identity.

## Decision Drivers

- npm registry name availability (the bare name is taken).
- CLI ergonomics: users should type a command that matches the tool's brand.
- Avoiding squatting risk and naming collisions.

## Considered Options

- **Bare `versailles`** — the obvious choice, but already registered by an unmaintained placeholder; not publishable.
- **`versailles-dbc`** — available, descriptive (Design-by-Contract), predictable.
- **Scoped `@<org>/versailles`** — available, but requires a scope and slightly worse install ergonomics for a CLI; acceptable fallback if no plain name works.

## Decision Outcome

Chosen option: **`versailles-dbc`** (with scoped `@<org>/versailles` as the fallback), **because** the plain name is unavailable and `versailles-dbc` is descriptive, publishable, and predictable. The CLI command is `versailles`, decoupled from the package name via the `bin` field:

```json
{
  "name": "versailles-dbc",
  "bin": { "versailles": "./dist/cli.js" }
}
```

### Consequences

- **Positive:** the CLI command matches the brand; the package name is unique on npm.
- **Negative:** two names to remember — install `versailles-dbc`, run `versailles`. The spec explicitly accepts this trade-off.
- **Neutral:** the scoped fallback remains available if the plain name becomes unavailable later.

### Confirmation

- `package.json` `name` is `versailles-dbc` and `bin` maps `versailles` → the CLI entry.
- The published package is not the placeholder occupying the bare `versailles` name.
- Implemented mapping (VERSAILLES-16): `bin` maps `versailles` → `./bin/versailles`, a thin shim importing the built `dist/cli/index.js` — the proposal-time `./dist/cli.js` example above is superseded (build-spec §2 documents the shim and its `prepare`/`prepublishOnly` hooks).

## More Information / Links

- [Build spec — Naming](../build-spec.md#naming), [§14 row: Package/CLI naming](../build-spec.md#14-open-decisions-to-pin-down-during-implementation)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial proposal |
| 2026-08-11 | associate-head-coach | Accepted by Head Coach |
| 2026-08-19 | general-manager | Confirmation updated: implemented bin mapping is the `./bin/versailles` shim importing `dist/cli/index.js` (VERSAILLES-16), superseding the proposal-time `./dist/cli.js` example |