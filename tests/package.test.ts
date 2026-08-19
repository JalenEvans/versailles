import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractManifests } from "../src/extractors/index.js";

/**
 * Packaging lifecycle (VERSAILLES-16, "Get Ready For Beta" sprint Phase 2):
 * bin/versailles imports ../dist/cli/index.js, but dist/ is gitignored, so
 * package.json ships the prepare and prepublishOnly hooks that make a clean
 * install/link/publish self-sufficient. These tests pin that behavior:
 *
 * 1. scripts.prepare runs the tsc build (src → dist per tsconfig outDir), so
 *    dist/cli/index.js exists on install/link/publish — no manual build step.
 * 2. scripts.prepublishOnly is a non-empty guard so a broken package (missing
 *    dist/) can never be published.
 * 3. The stable machine-readable envelope + exit codes that bin/versailles
 *    serializes — { ok, errors, warnings, exitCode }; 0 clean · 1 parse/usage ·
 *    2 blocking staleness — are unchanged through runCli. The bin shim itself
 *    is verified separately by the E2E walk; these tests pin the surface the
 *    shim depends on so the packaging change cannot silently break it.
 *
 * Contract grounding:
 * - docs/contracts/versailles.contract.yaml: every command answers with the
 *   stable shape { ok, errors, warnings, exitCode } and exit codes are exactly
 *   {0, 1, 2} — 2 is reserved for blocking staleness (build-spec §8, §10).
 * - tsconfig.json: outDir "dist", rootDir "src" — `tsc -p tsconfig.json` is
 *   the build that materializes dist/cli/index.js for bin/versailles.
 *
 * ── Green ──────────────────────────────────────────────────────────────────
 * package.json ships both hooks; the prepare/prepublishOnly assertions pin
 * the implemented behavior and the envelope/exit-code regressions guard the
 * surface bin/versailles depends on.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");

type PackageJson = {
	name?: string;
	scripts?: Record<string, string>;
};

async function readPackageJson(): Promise<PackageJson> {
	return JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

// The exact SEEDED_CONFIG written by initWorkspace (src/cli/init.ts); kept
// local so fixtures pin the loader's happy path against the seed.
const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeWorkspaceFile(
	cwd: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	await writeJsonFile(join(cwd, ".versailles", fileName), value);
}

async function writeSource(
	cwd: string,
	fileName: string,
	content: string,
): Promise<void> {
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "src", fileName), content, "utf8");
}

/**
 * Scaffolds a fresh workspace into its own temp subdir (four jointly-loaded
 * files written directly so fixtures do not depend on the CLI under test).
 */
async function freshWorkspace(name: string): Promise<string> {
	const cwd = join(tempRoot, name);
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeWorkspaceFile(cwd, "config.json", SEEDED_CONFIG);
	await writeWorkspaceFile(cwd, "contracts.json", {
		version: "1.0",
		contracts: {},
	});
	await writeWorkspaceFile(cwd, "manifests.json", {
		version: "1.0",
		manifests: {},
	});
	await writeWorkspaceFile(cwd, "predicates.json", {
		version: "1.0",
		predicates: {},
	});
	return cwd;
}

/**
 * Extractor-derived manifests store (loader format) for the fixture source
 * under <cwd>/src/ — the same derivation the §8 staleness recompute produces.
 */
function referenceManifests(cwd: string): unknown {
	const result = extractManifests([join(cwd, "src")]);
	const manifests: Record<string, unknown> = {};
	for (const [component, entry] of Object.entries(result.manifests)) {
		manifests[component] = {
			sourceHash: entry.sourceHash,
			fields: Object.fromEntries(
				entry.fields.map((field) => [field.name, field.typeRef]),
			),
		};
	}
	return { version: "1.0", manifests };
}

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-package-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── package.json lifecycle scripts (VERSAILLES-16) ─────────────────────────

describe("package.json lifecycle scripts (VERSAILLES-16 local install path)", () => {
	it("declares a `prepare` script that runs the tsc build — dist/ exists on install/link/publish, no manual build (asserts scripts.prepare is defined and runs tsc — install/link/publish must build dist)", async () => {
		const pkg = await readPackageJson();

		expect(pkg.scripts).toBeDefined();
		expect(pkg.scripts?.prepare).toBeDefined();
		// Robust pin: whatever the exact spelling, prepare must run the tsc
		// build that materializes dist/cli/index.js for bin/versailles.
		expect(pkg.scripts?.prepare).toContain("tsc");
	});

	it("declares a non-empty `prepublishOnly` guard — publishing must never ship a package whose CLI is broken (asserts scripts.prepublishOnly is defined and non-empty — publish must never ship a broken CLI)", async () => {
		const pkg = await readPackageJson();

		expect(pkg.scripts).toBeDefined();
		expect(pkg.scripts?.prepublishOnly).toBeDefined();
		expect(pkg.scripts?.prepublishOnly?.length).toBeGreaterThan(0);
	});
});

// ── Envelope + exit codes serialized by bin/versailles (VERSAILLES-16) ─────
// The bin shim does exactly: runCli(argv) → JSON.stringify(result) on stdout →
// process.exit(result.exitCode). These regressions pin that surface so the
// packaging fix cannot silently change it. runCli is imported from src (the
// shim's dist path is covered by the separate E2E walk).

type CliErrorShape = {
	code: string;
	field?: string;
	detail: string;
	ids?: string[];
};
type CliResultShape = {
	ok: boolean;
	errors: CliErrorShape[];
	warnings: CliErrorShape[];
	exitCode: 0 | 1 | 2;
	output?: unknown;
};
type RunCli = (
	argv: string[],
	options?: { cwd?: string },
) => Promise<CliResultShape>;

let runCli!: RunCli;

beforeAll(async () => {
	({ runCli } = await import("../src/cli/index.js"));
});

describe("runCli — stable envelope + exit codes serialized by bin/versailles (VERSAILLES-16)", () => {
	it("returns the { ok, errors, warnings, exitCode } envelope as JSON-round-trippable output — the exact shape the shim stringifies", async () => {
		const cwd = await freshWorkspace("p-envelope");
		const result = await runCli(["validate"], { cwd });

		expect(typeof result.ok).toBe("boolean");
		expect(Array.isArray(result.errors)).toBe(true);
		expect(Array.isArray(result.warnings)).toBe(true);
		expect([0, 1, 2]).toContain(result.exitCode);
		// The shim writes JSON.stringify(result) to stdout: the envelope must
		// survive a JSON round-trip byte-for-byte (no undefined/non-serializable).
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it("maps a clean workspace to exit 0 — validate on an empty-but-valid workspace (build-spec §8, §10)", async () => {
		const cwd = await freshWorkspace("p-clean");
		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.output).toMatchObject({ valid: true });
	});

	it("maps a usage error to exit 1 — unknown command surfaces UNKNOWN_COMMAND, never exit 2", async () => {
		const cwd = await freshWorkspace("p-usage");
		const result = await runCli(["bogus"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
		);
	});

	it("maps blocking staleness to exit 2 — check surfaces STALE with ids (build-spec §8, never 0 or 1)", async () => {
		const SOURCE_VERSION_A = `export class OrderService {
	id: number;
	total: number;
}
`;
		const SOURCE_VERSION_B = `export class OrderService {
	id: number;
	total: number;
	status: string;
}
`;
		const cwd = await freshWorkspace("p-stale");
		await writeSource(cwd, "OrderService.ts", SOURCE_VERSION_A);
		await writeWorkspaceFile(cwd, "manifests.json", referenceManifests(cwd));
		// Source changes after extraction: the stored hash no longer matches
		// the recomputed hash → blocking staleness.
		await writeSource(cwd, "OrderService.ts", SOURCE_VERSION_B);

		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(2);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "STALE", ids: ["OrderService"] }),
		);
		expect(result.output).toMatchObject({ staleIds: ["OrderService"] });
	});
});
