import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE_DIR_NAME = ".versailles";

const SEEDED_CONFIG = {
	$schema: "../../config.schema.json",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

const EMPTY_SCHEMA_FILE_NAMES = ["contracts.json", "manifests.json"];

function writeJsonFile(
	dirPath: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	return writeFile(
		join(dirPath, fileName),
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

/**
 * Scaffolds `<targetDir>/.versailles/` with the three jointly-loaded workspace
 * files (build-spec §2): a seeded default config plus empty version-less
 * schema stores (ADR-0018 — no file-level version fields, no version gates).
 *
 * ADR-0013 (Phase 3): predicates.json is retired. Predicates are now declared
 * inline in contracts.json's top-level `predicates` map.
 *
 * Idempotent: re-running re-seeds the same files (mkdir is recursive and the
 * seeds are always rewritten).
 */
export async function initWorkspace(targetDir: string): Promise<void> {
	const workspaceDir = join(targetDir, WORKSPACE_DIR_NAME);
	await mkdir(workspaceDir, { recursive: true });

	await writeJsonFile(workspaceDir, "config.json", SEEDED_CONFIG);
	for (const fileName of EMPTY_SCHEMA_FILE_NAMES) {
		await writeJsonFile(workspaceDir, fileName, {});
	}
}
