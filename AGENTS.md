# Versailles

Deterministic test generation from Design-by-Contract specifications.

**Start at [`docs/index.md`](docs/index.md)** — the contributor map.

This repo follows the Code Squad repository convention. Every repo carries:

```
AGENTS.md                      ← this file, tiny, points to docs/index.md
docs/
  index.md                     ← contributor map
  contracts/                   ← machine-checkable DbC contracts (contract_gate)
  specs/                       ← behavioral specs (one per bounded context)
  decisions/                   ← architecture decision records (ADRs)
scripts/
  validate-docs.sh             ← docs drift gate (CI-gated)
  validate-contracts.sh        ← contract validity gate (CI-gated)
.github/
  pull_request_template.md     ← PR description template
```

- No implementation starts without a registered contract (`contract_gate`).
- `docs/` is the single knowledge source; never duplicate it into chat.
- Run `scripts/validate-docs.sh` before opening a PR.