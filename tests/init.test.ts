import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import configSchema from "../config.schema.json";
// initWorkspace scaffolds <targetDir>/.versailles/ with the three jointly-loaded
// workspace files (build-spec §2): a default config plus two empty stores.
// ADR-0013 (Phase 3): predicates.json is retired; predicates now live inline in
// contracts.json's top-level `predicates` map.
// ADR-0018 (VERSAILLES-170): no version fields are seeded — the config gets a
// `$schema` pointer and the stores are `{}` envelopes.
import { initWorkspace } from "../packages/cli/src/cli/init.js";

/**
 * Verifies `versailles init` seeds the .versailles/ workspace (build-spec §2,
 * §12): a default config plus the two empty schema stores, each as an empty
 * envelope (`{}`).
 *
 * Contract grounding:
 * - workspace-context.contract.yaml (load_workspace requires): the directory
 *   must contain all three jointly-loaded files — config.json,
 *   contracts.json, manifests.json (build-spec §2). ADR-0013 retired
 *   predicates.json; predicates are now declared inline in contracts.json.
 * - config.schema.json (draft-07, ADR-0009): required keys sourceRoots,
 *   language, testFramework, generatedDir, staleness.blockOnStale;
 *   rejection.idiom optional; additionalProperties false — so the seeded
 *   config must contain ONLY the allowed keys.
 * - ADR-0018 (VERSAILLES-170): init no longer seeds grammarVersion /
 *   schemaVersion (the version ceremony is removed) and instead seeds the
 *   `$schema` pointer; the empty stores are `{}` (no `{ "version": "1.0" }`
 *   envelope).
 */

const SEED_FILE_NAMES = ["config.json", "contracts.json", "manifests.json"];

const SEEDED_CONFIG = {
	$schema: "../../config.schema.json",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

const ajv = new Ajv({ allErrors: true });

// Compiles the schema once; ajv exposes the last run's errors on
// validateSeedConfig.errors after each call.
const validateSeedConfig = ajv.compile(configSchema);

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-init-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// Each test seeds into its own fresh subdir of the suite temp root so tests
// stay independent (no shared workspace state) and never touch the repo.
async function freshTargetDir(name: string): Promise<string> {
	const targetDir = join(tempRoot, name);
	await rm(targetDir, { recursive: true, force: true });
	return targetDir;
}

describe("initWorkspace — scaffolds .versailles/", () => {
	it("creates .versailles/ containing exactly the three jointly-loaded files", async () => {
		const targetDir = await freshTargetDir("a-three-files");

		await initWorkspace(targetDir);

		const entries = await readdir(join(targetDir, ".versailles"));
		expect(entries.sort()).toEqual(SEED_FILE_NAMES);
	});

	it("does NOT seed predicates.json (ADR-0013: predicates are inline in contracts.json)", async () => {
		const targetDir = await freshTargetDir("a-no-predicates-json");

		await initWorkspace(targetDir);

		const entries = await readdir(join(targetDir, ".versailles"));
		expect(entries).not.toContain("predicates.json");
	});

	it("seeds a config.json that is valid against config.schema.json with the pinned default", async () => {
		const targetDir = await freshTargetDir("b-config-valid");

		await initWorkspace(targetDir);

		const configText = await readFile(
			join(targetDir, ".versailles", "config.json"),
			"utf8",
		);
		const parsed = JSON.parse(configText) as Record<string, unknown>;

		expect(validateSeedConfig(parsed)).toBe(true);
		expect(validateSeedConfig.errors).toBeNull();
		expect(parsed).toEqual(SEEDED_CONFIG);
	});

	it.each(["contracts.json", "manifests.json"])(
		"seeds %s as the empty envelope {} (ADR-0018: no version field)",
		async (fileName) => {
			const targetDir = await freshTargetDir(`c-${fileName}`);

			await initWorkspace(targetDir);

			const content = await readFile(
				join(targetDir, ".versailles", fileName),
				"utf8",
			);
			expect(() => JSON.parse(content)).not.toThrow();
			const parsed = JSON.parse(content) as Record<string, unknown>;
			expect(parsed).toEqual({});
		},
	);

	it("is idempotent: a second run does not throw and preserves all three files", async () => {
		const targetDir = await freshTargetDir("d-idempotent");

		await initWorkspace(targetDir);
		await expect(initWorkspace(targetDir)).resolves.toBeUndefined();

		const entries = await readdir(join(targetDir, ".versailles"));
		expect(entries.sort()).toEqual(SEED_FILE_NAMES);
	});
});
