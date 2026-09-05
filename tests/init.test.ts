import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import configSchema from "../config.schema.json";
// initWorkspace scaffolds <targetDir>/.versailles/ with the three jointly-loaded
// workspace files (build-spec §2): a default config plus two empty stores.
// ADR-0013 (Phase 3): predicates.json is retired; predicates now live inline in
// contracts.json's top-level `predicates` map.
// ADR-0018 (VERSAILLES-170): no version fields are seeded — the config gets a
// `$schema` pointer and the stores are `{}` envelopes.
// VERSAILLES-184: init scaffolds a FRESH workspace only; when .versailles/
// already exists with workspace files it REFUSES (rejects) instead of
// re-seeding — never a silent re-write over authored contracts/manifests.
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

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const SEED_FILE_NAMES = ["config.json", "contracts.json", "manifests.json"];

const SEEDED_CONFIG = {
	// VERSAILLES-187: `../config.schema.json` resolves from .versailles/ up one
	// level to the project-root schema. The old `../../config.schema.json`
	// resolved one level ABOVE the project root — a dead pointer.
	$schema: "../config.schema.json",
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
});

// VERSAILLES-187: the seeded config `$schema` pointer must resolve to the
// project-root schema (`<project>/config.schema.json`), never one level above
// the project root. The config lives at `<project>/.versailles/config.json`,
// so the old `../../config.schema.json` resolved to
// `<parent-of-project>/config.schema.json` — a dead pointer (editor/tooling
// JSON-schema validation silently off). The root package ships
// `config.schema.json` at the project root (package.json "files" includes
// "config.schema.json"), so the seeded pointer is `../config.schema.json` and
// validation stays live. Spec: docs/specs/workspace-context.md (VERSAILLES-187).
describe("initWorkspace — seeded config $schema resolves to the project-root schema (VERSAILLES-187)", () => {
	it("seeds $schema as ../config.schema.json (resolves from .versailles/ up one level to the project root)", async () => {
		const targetDir = await freshTargetDir("e-schema-pointer-value");

		await initWorkspace(targetDir);

		const parsed = JSON.parse(
			await readFile(join(targetDir, ".versailles", "config.json"), "utf8"),
		) as Record<string, unknown>;

		expect(parsed.$schema).toBe("../config.schema.json");
		expect(parsed.$schema).not.toBe("../../config.schema.json");
	});

	it("resolves the seeded $schema to the project-root config.schema.json — a live pointer, never dead", async () => {
		const targetDir = await freshTargetDir("e-schema-live");
		// A freshly initialized project root carries the schema the root
		// package ships (package.json "files" includes config.schema.json at the
		// repo root), so arrange it like a real project root.
		await mkdir(targetDir, { recursive: true });
		await copyFile(
			join(REPO_ROOT, "config.schema.json"),
			join(targetDir, "config.schema.json"),
		);

		await initWorkspace(targetDir);

		const configPath = join(targetDir, ".versailles", "config.json");
		const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
			$schema?: string;
		};
		const resolvedSchemaPath = resolve(
			dirname(configPath),
			parsed.$schema ?? "",
		);

		expect(resolvedSchemaPath).toBe(join(targetDir, "config.schema.json"));
		// Live: the file the pointer names actually exists at the project root.
		const schemaStats = await stat(resolvedSchemaPath);
		expect(schemaStats.isFile()).toBe(true);
	});

	it("never resolves the seeded $schema one level above the project root (no ../../ dead pointer)", async () => {
		const targetDir = await freshTargetDir("e-schema-not-above");

		await initWorkspace(targetDir);

		const configPath = join(targetDir, ".versailles", "config.json");
		const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
			$schema?: string;
		};
		const resolvedSchemaPath = resolve(
			dirname(configPath),
			parsed.$schema ?? "",
		);

		expect(resolvedSchemaPath).not.toBe(
			join(targetDir, "..", "config.schema.json"),
		);
		expect(resolvedSchemaPath).toBe(join(targetDir, "config.schema.json"));
	});
});

// VERSAILLES-184: the previous idempotency pin (a second run re-seeds and
// resolves) encoded the bug — init silently re-wrote the stores over any
// authored content. Fixed behavior: initWorkspace REFUSES (rejects) whenever
// .versailles/ already exists with workspace files, and leaves the existing
// files byte-unchanged.
describe("initWorkspace — refuses to overwrite an existing workspace (VERSAILLES-184)", () => {
	it("rejects on a second run over an already-seeded workspace — no silent re-seed", async () => {
		const targetDir = await freshTargetDir("d-refuses-seeded");

		await initWorkspace(targetDir);
		const before: Record<string, string> = {};
		for (const fileName of SEED_FILE_NAMES) {
			before[fileName] = await readFile(
				join(targetDir, ".versailles", fileName),
				"utf8",
			);
		}

		await expect(initWorkspace(targetDir)).rejects.toThrow();

		for (const fileName of SEED_FILE_NAMES) {
			const after = await readFile(
				join(targetDir, ".versailles", fileName),
				"utf8",
			);
			expect(after).toBe(before[fileName]);
		}
	});

	it("rejects when contracts.json holds authored content and leaves every workspace file byte-unchanged", async () => {
		const targetDir = await freshTargetDir("d-refuses-authored");
		await mkdir(join(targetDir, ".versailles"), { recursive: true });
		const authoredContracts = {
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						placeOrder: {
							id: "OrderService.placeOrder",
							params: [],
							preconditions: [],
							postconditions: [],
							effects: [],
							sourceHash: "authored-hash",
						},
					},
				},
			},
		};
		const authoredManifests = {
			manifests: {
				OrderService: { sourceHash: "man-os", fields: {} },
			},
		};
		await writeFile(
			join(targetDir, ".versailles", "config.json"),
			`${JSON.stringify(SEEDED_CONFIG, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			join(targetDir, ".versailles", "contracts.json"),
			`${JSON.stringify(authoredContracts, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			join(targetDir, ".versailles", "manifests.json"),
			`${JSON.stringify(authoredManifests, null, 2)}\n`,
			"utf8",
		);
		const before: Record<string, string> = {};
		for (const fileName of SEED_FILE_NAMES) {
			before[fileName] = await readFile(
				join(targetDir, ".versailles", fileName),
				"utf8",
			);
		}

		await expect(initWorkspace(targetDir)).rejects.toThrow();

		for (const fileName of SEED_FILE_NAMES) {
			const after = await readFile(
				join(targetDir, ".versailles", fileName),
				"utf8",
			);
			expect(after).toBe(before[fileName]);
		}
	});
});
