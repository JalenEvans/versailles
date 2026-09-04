import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE_DIR_NAME = ".versailles";

// The three jointly-loaded workspace files (build-spec §2): a seeded default
// config plus the two empty schema stores.
const WORKSPACE_FILE_NAMES = [
	"config.json",
	"contracts.json",
	"manifests.json",
];

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
 * VERSAILLES-184: init scaffolds a FRESH workspace only. When `.versailles/`
 * already exists with workspace files (config.json / contracts.json /
 * manifests.json), initWorkspace REJECTS — never a silent re-write over
 * authored contracts/manifests. A `.versailles/` that exists but contains NO
 * workspace files (e.g. an empty directory) has no authored content to
 * destroy and may be re-scaffolded.
 */
export async function initWorkspace(targetDir: string): Promise<void> {
	const workspaceDir = join(targetDir, WORKSPACE_DIR_NAME);

	await refuseExistingWorkspace(workspaceDir);

	await mkdir(workspaceDir, { recursive: true });

	await writeJsonFile(workspaceDir, "config.json", SEEDED_CONFIG);
	for (const fileName of EMPTY_SCHEMA_FILE_NAMES) {
		await writeJsonFile(workspaceDir, fileName, {});
	}
}

/**
 * VERSAILLES-184: refuses to re-seed an existing workspace. "Exists with
 * content" means the `.versailles/` directory exists AND holds at least one
 * workspace file (config.json / contracts.json / manifests.json) — an empty
 * directory is re-scaffoldable. When the directory is absent (or holds no
 * workspace files) this resolves without refusing so the scaffold proceeds.
 */
async function refuseExistingWorkspace(workspaceDir: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(workspaceDir);
	} catch {
		// Directory does not exist: nothing to refuse.
		return;
	}
	const present = WORKSPACE_FILE_NAMES.filter((name) => entries.includes(name));
	if (present.length === 0) {
		return;
	}
	throw new Error(
		`Refusing to re-seed ${workspaceDir}: an existing workspace is present (${present.join(", ")}). Run "versailles init" only on a fresh project — init never overwrites authored workspace files.`,
	);
}
