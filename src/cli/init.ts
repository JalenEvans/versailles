import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE_DIR_NAME = ".versailles";

const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

const EMPTY_SCHEMA_FILE_NAMES = [
	"contracts.json",
	"manifests.json",
	"predicates.json",
];

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
 * Scaffolds `<targetDir>/.versailles/` with the four jointly-loaded workspace
 * files (build-spec §2): a seeded default config plus empty schema stores.
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
