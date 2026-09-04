# ADR: npm publish pipeline — manual-only, owner-gated access control

**ID:** ADR-0022
**Date:** 2026-09-03
**Status:** accepted
**Owner:** maintainer
**Canonical source:** MADR-derived decision record template

---

**Status note (2026-09-04):** the auth mechanism is amended — from an `NPM_TOKEN` environment secret to **npm Trusted Publishing (OIDC)** (`id-token: write` + `--provenance`, no token, no OTP). The pipeline also now uses **staged publishing**: it stages the package via `npm stage publish`, and the maintainer approves with 2FA on npmjs.com (Staged Packages tab, or `npm stage approve <stage-id>`) before the version goes live — direct `npm publish` is forbidden by the stage-only trusted-publisher permission (403 "OIDC permission denied for this action"). See the changelog. The original decision body below remains the historical record.

## Context and Problem Statement

The npm beta (`0.1.0-beta.0`) was published by hand: a `chore(release)` commit (488c67f) bumped the version and the publish itself ran `npm publish` from a laptop. There was no repeatable pipeline — publishing knowledge lived only in the maintainer's head, and nothing validated the package before it reached the registry.

Publishing is a money/permission/state-touching action: it writes to the npm registry, minting versions that cannot be un-published cleanly and, under `latest`, installing on every consumer's next `npm install`. That authority must be (1) repeatable — one validated path to npm, no laptop-only knowledge — and (2) owner-only — only the repo owner may publish, consistent with the spec-threshold rule that permissions-touching changes get explicit control.

## Decision Drivers

- **Repeatability** — one validated path to npm; the publish must not depend on who is at the keyboard or what is on their laptop.
- **Access control** — only the repo owner may publish. Publishing crosses the spec threshold (permissions/state), so the authority must be explicit and gated.
- **Least privilege** — `NPM_TOKEN` lives as an environment secret, exposed only to the publish job; the workflow requests minimal permissions; the token is written to an ephemeral runner `.npmrc`, never committed.
- **Reuse** — reuse the existing code-validation gate (`code-validation.yml` via `workflow_call`, matching `validation.yml`) instead of inventing a second validation path; the git-commit-as-approval philosophy (ADR-0003, ADR-0012) means version bumps stay PR-driven `chore(release)` commits, and publish is a separate, explicit step after the bump lands.

## Considered Options

- **Option A — `workflow_dispatch`-only pipeline + GitHub environment approval gate + in-workflow actor guard (chosen)** — publish is manually dispatched from the `main` branch (no push/PR trigger), the publish job runs under the `npm-publish` GitHub environment whose required reviewers are the primary human approval gate, and a first-step actor guard fails unless `github.triggering_actor` is the repo owner — defense in depth.
- **Option B — publish on tag push (`v*` tags trigger publish)** — rejected: conflates CI automation with publish authority, has no explicit human approval gate, and requires a tag policy that does not exist today.
- **Option C — keep manual `npm publish` from a laptop** — rejected: no repeatability, no validation gate, and the publish key lives on a laptop rather than in an environment secret.
- **Option D — publish on every push to main** — rejected: no human gate, publishes without intent on every merge.

## Decision Outcome

Chosen option: **Option A, because it keeps publishing a deliberate, owner-only, manually-initiated action while making it repeatable and gated by the full existing validation suite.** The environment approval gate (`npm-publish` environment with required reviewers) is the primary control; the in-workflow actor guard is defense in depth against a misconfigured environment or an accidental dispatch. `workflow_dispatch` restricted to `main`, a concurrency group with `cancel-in-progress: false` (at most one publish at a time, never cancelled mid-flight), `NPM_TOKEN` as an environment secret, and a `validate` job that reuses `code-validation.yml` together give a single, auditable path to npm.

### Consequences

- **Positive:** repeatable publish — any future maintainer can ship from the Actions UI without laptop-only knowledge; owner-only guarantee enforced at the workflow level; full validation (lint, format, build, tests) runs before anything reaches the registry; least-privilege secret handling — the token is scoped to the publish job and written to an ephemeral `.npmrc`. **(amended 2026-09-04: now tokenless — Trusted Publishing (OIDC); and staged publishing — the stage-only trusted-publisher permission + maintainer 2FA on npmjs move the owner-only guarantee to the strongest form ("only the owner publishes"), see changelog)**
- **Negative:** the pipeline cannot self-bump versions — version bumps remain PR-driven `chore(release)` commits, by design, consistent with git-commit-as-approval (ADR-0003, ADR-0012); the actor guard is a software check, not a security boundary — a repo admin could edit the workflow, so the environment required-reviewer gate is the real boundary; external setup is required before first use (GitHub environment `npm-publish` with required reviewers plus an `NPM_TOKEN` environment secret). **(amended 2026-09-04: external setup is now the npmjs.com Trusted Publisher for `versailles-dbc` — owner JalenEvans, repo versailles, workflow source `npm-publish.yml`, environment `npm-publish`, with a stage-only permission (`Permissions: npm stage publish`); see changelog)**
- **Neutral:** publishing remains a two-step process (merge bump → dispatch publish); a misdispatched publish is rejected by the environment gate or actor guard rather than silently proceeding. **(amended 2026-09-04: now three-step — merge bump → dispatch stages the package → maintainer approves with 2FA on npmjs.com (or `npm stage approve <stage-id>`) before the version is installable; a wrong dist-tag cannot be fixed in place — reject and re-stage; see changelog)**

### Confirmation

- `.github/workflows/npm-publish.yml` exists: `workflow_dispatch`-only on `branches: [main]`, `dist_tag` (latest/beta/next) and `dry_run` inputs, `npm-publish` concurrency group with `cancel-in-progress: false`, `validate` job reusing `code-validation.yml` via `workflow_call`, `publish` job under `environment: npm-publish` with the owner-only actor guard, job-level `permissions: { id-token: write }` (Trusted Publishing / OIDC), and `npm stage publish --tag ${{ inputs.dist_tag }} --provenance` (adding `--dry-run` when the `dry_run` input is true) — direct `npm publish` is forbidden by the stage-only trusted-publisher permission, no `NPM_TOKEN`, no `.npmrc`.
- `tests/publish-workflow.test.ts` passes and pins the access-control surface (manual-only, branches [main], environment gate, actor guard, `id-token: write`, `--provenance`, `npm stage publish --tag` wired to `dist_tag`, and fail-closed: no direct `npm publish --tag` command line anywhere, no `NPM_TOKEN` / `.npmrc`).
- `scripts/validate-docs.sh` passes after this record is registered in `docs/decisions/index.md`.

## More Information / Links

- Related: [ADR-0001](0001-package-and-cli-naming.md) (package `versailles-dbc`), [ADR-0003](0003-git-history-as-audit-trail.md) and [ADR-0012](0012-git-commit-as-approval-remove-review-gate.md) (git commit as approval)
- [`.github/workflows/npm-publish.yml`](../../.github/workflows/npm-publish.yml) · [`.github/workflows/code-validation.yml`](../../.github/workflows/code-validation.yml) (reused validation gate)
- [`.github/workflows/validation.yml`](../../.github/workflows/validation.yml) (CI gates: code-validation.yml + docs-validation.yml)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-09-03 | maintainer | Initial proposal |
| 2026-09-03 | maintainer | Accepted |
| 2026-09-04 | maintainer | Amended: auth switched from NPM_TOKEN environment secret to Trusted Publishing (OIDC) — npm mandatory-2FA (classic tokens revoked 2025-12; bypass-2FA GATs deprecate 2027-01); publish job grants id-token: write, runs npm publish --tag ... --provenance, no token/.npmrc; pin test asserts fail-closed |
| 2026-09-04 | maintainer | Amended: staged publishing — pipeline runs npm stage publish (stage-only trusted-publisher permission; direct npm publish returns 403); maintainer approves with 2FA on npmjs.com (or npm stage approve <stage-id>) before the version is installable; dist-tag immutable on staged package |