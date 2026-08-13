import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import configSchema from "../config.schema.json";
// Assumption: the Power Forward will create src/cli/init.ts exporting
// initWorkspace(targetDir: string): Promise<void> — async, node:fs/promises,
// mkdir recursive, NodeNext .js import extension. Until that module exists,
// this import failure IS the Red.
import { initWorkspace } from "../src/cli/init.js";

/**
 * Red-phase gate for chunk 1.4: `versailles init` scaffolds the workspace
 * (build-spec §12 / CLI table: "Scaffold .versailles/ with empty/default
 * files"). The Head Coach pinned behavior: init SEEDS a default config plus
 * empty schema files — it is not a blank slate.
 *
 * Contract grounding:
 * - workspace-context.contract.yaml (load_workspace requires): the directory
 *   must contain all four versioned, jointly-loaded files — config.json,
 *   contracts.json, manifests.json, predicates.json (build-spec §2). The
 *   four-file set is never interpreted in isolation.
 * - config.schema.json (draft-07, ADR-0009): required keys grammarVersion,
 *   schemaVersion, sourceRoots, language, testFramework, generatedDir,
 *   staleness.blockOnStale; rejection.idiom optional; additionalProperties
 *   false — so the seeded config must contain ONLY the allowed keys.
 */

const SEED_FILE_NAMES = [
	"config.json",
	"contracts.json",
	"manifests.json",
	"predicates.json",
];

const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
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
	it("creates .versailles/ containing exactly the four jointly-loaded files", async () => {
		const targetDir = await freshTargetDir("a-four-files");

		await initWorkspace(targetDir);

		const entries = await readdir(join(targetDir, ".versailles"));
		expect(entries.sort()).toEqual(SEED_FILE_NAMES);
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

	it.each(["contracts.json", "manifests.json", "predicates.json"])(
		"seeds %s as a valid JSON object (empty initial state permitted)",
		async (fileName) => {
			const targetDir = await freshTargetDir(`c-${fileName}`);

			await initWorkspace(targetDir);

			const content = await readFile(
				join(targetDir, ".versailles", fileName),
				"utf8",
			);
			expect(() => JSON.parse(content)).not.toThrow();
			const parsed = JSON.parse(content) as unknown;
			expect(parsed).toBeTypeOf("object");
			expect(parsed).not.toBeNull();
		},
	);

	it("is idempotent: a second run does not throw and preserves all four files", async () => {
		const targetDir = await freshTargetDir("d-idempotent");

		await initWorkspace(targetDir);
		await expect(initWorkspace(targetDir)).resolves.toBeUndefined();

		const entries = await readdir(join(targetDir, ".versailles"));
		expect(entries.sort()).toEqual(SEED_FILE_NAMES);
	});
});
