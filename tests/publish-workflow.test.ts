import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * npm publish pipeline — access-control surface (feat/npm-publish-oidc):
 * a manually-triggered publish workflow whose whole point is WHO may publish
 * and to WHAT. This file pins the workflow file's access-control contract so
 * the pipeline can never drift into a wide-open state:
 *
 * 1. The workflow is manual-only: on.workflow_dispatch restricted to main —
 *    a push or pull_request can never trigger a publish.
 * 2. The publish job runs under the `npm-publish` GitHub environment (the
 *    environment approval gate is the primary access control) and its first
 *    step fails unless github.triggering_actor is JalenEvans (the repo
 *    owner) — a second, in-workflow actor guard.
 * 3. Publishing uses npm Trusted Publishing (OIDC), not a registry token:
 *    the publish job grants `id-token: write` and runs `npm publish --tag
 *    --provenance` wired to the dist_tag input — permission and command are
 *    pinned. The npmjs.com Trusted Publisher must be configured with the
 *    workflow source `npm-publish.yml` and environment `npm-publish` (that
 *    is exactly how npm matches the OIDC token to an account). No NPM_TOKEN
 *    secret and no .npmrc are written — credentials never appear in the
 *    workflow.
 * 4. Concurrency group `npm-publish` with cancel-in-progress: false — at most
 *    one publish runs at a time, and a slow publish is never cancelled.
 * 5. Reuse conventions: a `validate` job calls back into
 *    .github/workflows/code-validation.yml via workflow_call (matching
 *    validation.yml), and publish `needs: validate`.
 *
 * Contract grounding: design contract for the npm publish pipeline.
 * Written as a RED-phase pin — the workflow file currently uses the
 * NPM_TOKEN/.npmrc model; the implementing agent migrates it to Trusted
 * Publishing (OIDC) to make these pass. Pinned as plain text (no YAML
 * parser): the file is read as utf8 and asserted on its content, the same
 * read-from-disk style as tests/package.test.ts (REPO_ROOT convention).
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLISH_WORKFLOW_PATH = join(
	REPO_ROOT,
	".github",
	"workflows",
	"npm-publish.yml",
);

async function readPublishWorkflow(): Promise<string> {
	return readFile(PUBLISH_WORKFLOW_PATH, "utf8");
}

describe("npm-publish workflow — access-control surface (design contract pin)", () => {
	it("exists at .github/workflows/npm-publish.yml", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml.length).toBeGreaterThan(0);
	});

	it("names the workflow `npm-publish`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/name:\s*npm-publish/);
	});

	it("is manually triggered only — declares `workflow_dispatch` and no `push` / `pull_request` trigger", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toContain("workflow_dispatch");
		expect(yaml).not.toMatch(/^\s*push\s*:/m);
		expect(yaml).not.toMatch(/^\s*pull_request\s*:/m);
	});

	it("restricts `workflow_dispatch` to the `main` branch", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/branches:\s*\[\s*main\s*\]/);
	});

	it("declares the `dist_tag` input — type choice with latest/beta/next options, default latest", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toContain("dist_tag");
		expect(yaml).toMatch(/type:\s*choice/);
		expect(yaml).toMatch(/options:/);
		expect(yaml).toContain("latest");
		expect(yaml).toContain("beta");
		expect(yaml).toContain("next");
		expect(yaml).toMatch(/default:\s*latest/);
	});

	it("declares the `dry_run` input — type boolean, default false", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toContain("dry_run");
		expect(yaml).toMatch(/type:\s*boolean/);
		expect(yaml).toMatch(/default:\s*false/);
	});

	it("serializes publishes — concurrency group `npm-publish` with `cancel-in-progress: false`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/group:\s*npm-publish/);
		expect(yaml).toMatch(/cancel-in-progress:\s*false/);
	});

	it("reuses code validation — a `validate` job calls back into code-validation.yml via `workflow_call`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toContain("code-validation.yml");
		expect(yaml).toMatch(/workflow_call/);
	});

	it("gates publish on validation — the publish job declares `needs: validate`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/needs:\s*validate/);
	});

	it("runs the publish job under the `npm-publish` GitHub environment — the environment approval gate", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/environment:\s*npm-publish/);
	});

	it("guards the actor — the first publish step fails unless `github.triggering_actor` is `JalenEvans`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toContain("github.triggering_actor");
		expect(yaml).toContain("JalenEvans");
		// The guard must be a fail-closed step: an `if:` conditional on the
		// triggering actor (not a passive echo/comment).
		expect(yaml).toMatch(/if:.*github\.triggering_actor/);
	});

	// Trusted Publishing (OIDC): the OIDC token must be scoped to the publish
	// job via job-level `permissions: { id-token: write }` — never
	// workflow-wide, keeping least privilege. The pin asserts at file-content
	// level that `id-token: write` is present; exact job scoping is the
	// implementing agent's structural job, and the content assertion is the
	// contract clause npm requires.
	it("grants the OIDC publish permission — `id-token: write`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/id-token:\s*write/);
	});

	it("publishes with `--provenance` provenance attestation", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/npm publish --tag.*--provenance/);
	});

	it("publishes without a registry token — fail-closed: no `NPM_TOKEN`, no `.npmrc`", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).not.toContain("NPM_TOKEN");
		expect(yaml).not.toContain(".npmrc");
	});

	it("publishes with `npm publish --tag` wired to the `dist_tag` input", async () => {
		const yaml = await readPublishWorkflow();
		expect(yaml).toMatch(/npm publish --tag/);
		expect(yaml).toContain("inputs.dist_tag");
	});
});
