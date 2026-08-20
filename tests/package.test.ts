import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Packaging lifecycle (VERSAILLES-16, "Get Ready For Beta" sprint Phase 2):
 * bin/versailles imports ../dist/cli/index.js, but dist/ is gitignored, so
 * package.json ships the prepare and prepublishOnly hooks that make a clean
 * install/link/publish self-sufficient. These tests pin that behavior:
 *
 * 1. scripts.prepare runs the tsc build (src → dist per tsconfig outDir), so
 *    dist/cli/index.js exists on install/link/publish — no manual build step.
 * 2. scripts.prepublishOnly runs the build + smoke, so a broken package
 *    (missing dist/ or failing smoke) can never be published.
 * 3. The stable machine-readable envelope { ok, errors, warnings, exitCode }
 *    that bin/versailles serializes survives a JSON round-trip through runCli
 *    and a clean workspace maps to exit 0. The rest of the envelope /
 *    exit-code matrix (UNKNOWN_COMMAND → 1, STALE → 2, ...) is pinned in
 *    tests/cli.test.ts; this file keeps only the packaging-relevant bit.
 * 4. The real bin/versailles shim is exercised end-to-end below: it is spawned
 *    with node against a scratch workspace (after a fresh `bun run build`) and
 *    its stdout must parse to the envelope while the process exit code must
 *    equal result.exitCode — covering the shipped surface runCli cannot:
 *    JSON.stringify on stdout + process.exit wiring (build-spec §10).
 *
 * Contract grounding:
 * - docs/contracts/versailles.contract.yaml: every command answers with the
 *   stable shape { ok, errors, warnings, exitCode } and exit codes are exactly
 *   {0, 1, 2} — 2 is reserved for blocking staleness (build-spec §8, §10).
 * - tsconfig.json: outDir "dist", rootDir "src" — `tsc -p tsconfig.json` is
 *   the build that materializes dist/cli/index.js for bin/versailles.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const SHIM_PATH = join(REPO_ROOT, "bin", "versailles");

type PackageJson = {
	name?: string;
	scripts?: Record<string, string>;
	license?: string;
	repository?: { url?: string };
	author?: string | { name?: string };
	keywords?: string[];
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

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-package-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── package.json lifecycle scripts (VERSAILLES-16) ─────────────────────────

describe("package.json lifecycle scripts (VERSAILLES-16 local install path)", () => {
	it("declares a `prepare` script that runs the tsc build — dist/ exists on install/link/publish, no manual build", async () => {
		const pkg = await readPackageJson();

		expect(pkg.scripts).toBeDefined();
		expect(pkg.scripts?.prepare).toBeDefined();
		// Robust pin: whatever the exact spelling, prepare must run the tsc
		// build that materializes dist/cli/index.js for bin/versailles.
		expect(pkg.scripts?.prepare).toMatch(/tsc -p tsconfig\.json/);
	});

	it("declares a `prepublishOnly` guard that runs build and smoke — a broken CLI can never be published", async () => {
		const pkg = await readPackageJson();

		expect(pkg.scripts).toBeDefined();
		expect(pkg.scripts?.prepublishOnly).toBeDefined();
		// The publish gate must run the full check: build (materialize dist/)
		// AND smoke (run the shipped-surface suite) before npm can publish.
		expect(pkg.scripts?.prepublishOnly).toContain("build");
		expect(pkg.scripts?.prepublishOnly).toContain("smoke");
	});
});

// ── package.json publish metadata (VERSAILLES-19) ──────────────────────────
// "Get Ready For Beta" sprint Phase 5 housekeeping: the ticket AC requires
// "npm pkg checks clean; no publish warnings for license/repository".
// package.json currently ships name/version/description/private/type/main/
// types/exports/bin/files/scripts/devDependencies/packageManager/engines but
// LACKS license, repository, author, and keywords — so `npm publish --dry-run`
// warns on all four. The repo already carries a LICENSE file (MIT); the
// manifest must declare it. These tests pin the four fields npm surfaces in
// publish warnings, asserting presence/shape only — never content beyond the
// license value — so a future URL/author/keyword wording change stays green.

describe("package.json publish metadata (VERSAILLES-19)", () => {
	it('declares `license` as "MIT" — the repo\'s LICENSE file is declared for npm publish', async () => {
		const pkg = await readPackageJson();

		expect(pkg.license).toBe("MIT");
	});

	it("declares a `repository` object with a `url` field — npm publish resolves the homepage without a warning", async () => {
		const pkg = await readPackageJson();

		expect(pkg.repository).toBeDefined();
		expect(typeof pkg.repository?.url).toBe("string");
	});

	it("declares a non-empty `author` (string, or object with a name) — npm publish surfaces an author", async () => {
		const pkg = await readPackageJson();

		const author = pkg.author;
		const authorIsNonEmptyString =
			typeof author === "string" && author.trim().length > 0;
		const authorIsObjectWithName =
			typeof author === "object" &&
			author !== null &&
			typeof author.name === "string" &&
			author.name.trim().length > 0;
		expect(authorIsNonEmptyString || authorIsObjectWithName).toBe(true);
	});

	it("declares `keywords` as a non-empty string array — npm publish discovers the package by topic", async () => {
		const pkg = await readPackageJson();

		expect(Array.isArray(pkg.keywords)).toBe(true);
		expect((pkg.keywords ?? []).length).toBeGreaterThan(0);
		expect((pkg.keywords ?? []).every((k) => typeof k === "string")).toBe(true);
	});
});

// ── Envelope through runCli (VERSAILLES-16) ────────────────────────────────
// The bin shim does exactly: runCli(argv) → JSON.stringify(result) on stdout →
// process.exit(result.exitCode). The envelope / exit-code matrix itself (clean
// 0, UNKNOWN_COMMAND 1, STALE 2, ...) is pinned in tests/cli.test.ts; this
// file keeps only the packaging-relevant bit — the envelope must survive the
// JSON round-trip the shim performs (no undefined / non-serializable members)
// on a representative clean run. The REAL shim surface (JSON.stringify +
// process.exit) is covered below by spawning bin/versailles against dist/.

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

describe("runCli — JSON-round-trippable envelope + clean exit 0 (VERSAILLES-16)", () => {
	it("returns the { ok, errors, warnings, exitCode } envelope as JSON-round-trippable output and maps a clean workspace to exit 0", async () => {
		const cwd = await freshWorkspace("p-clean");
		const result = await runCli(["validate"], { cwd });

		expect(typeof result.ok).toBe("boolean");
		expect(Array.isArray(result.errors)).toBe(true);
		expect(Array.isArray(result.warnings)).toBe(true);
		expect([0, 1, 2]).toContain(result.exitCode);
		// The shim writes JSON.stringify(result) to stdout: the envelope must
		// survive a JSON round-trip byte-for-byte (no undefined/non-serializable).
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.output).toMatchObject({ valid: true });
	});
});

// ── bin/versailles shim E2E (VERSAILLES-16) ────────────────────────────────
// Real shipped surface: npm links bin/versailles as the `versailles` binary,
// which imports ../dist/cli/index.js (gitignored → the prepare hook rebuilds
// it on install). Spawn the shim with node against a scratch workspace so the
// E2E covers exactly what runCli cannot: JSON.stringify on stdout + process.
// exit with the result exit code.

describe("bin/versailles shim — real shipped surface (VERSAILLES-16)", () => {
	beforeAll(() => {
		// dist/ is gitignored; rebuild it so the shim's import of
		// ../dist/cli/index.js resolves to the current src — the same dist a
		// fresh install (prepare hook) or `bun run build` would produce.
		const build = spawnSync("bun", ["run", "build"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(
			build.status,
			`bun run build failed:\n${build.stdout}\n${build.stderr}`,
		).toBe(0);
	});

	it("validate on a clean workspace → stdout parses to the envelope, ok true, exit 0", async () => {
		const cwd = await freshWorkspace("shim-clean");
		const run = spawnSync("node", [SHIM_PATH, "validate"], {
			cwd,
			encoding: "utf8",
		});

		expect(
			run.status,
			`shim exited ${run.status}:\n${run.stdout}\n${run.stderr}`,
		).toBe(0);
		const envelope = JSON.parse(run.stdout) as CliResultShape;
		expect(envelope.ok).toBe(true);
		expect(envelope.exitCode).toBe(0);
		expect(Array.isArray(envelope.errors)).toBe(true);
		expect(Array.isArray(envelope.warnings)).toBe(true);
		expect(envelope.errors).toEqual([]);
		expect(envelope.output).toMatchObject({ valid: true });
	});

	it("an unknown command → stdout parses to the envelope, ok false, exit 1 — process.exit propagates the result exit code", async () => {
		const cwd = await freshWorkspace("shim-usage");
		const run = spawnSync("node", [SHIM_PATH, "bogus"], {
			cwd,
			encoding: "utf8",
		});

		expect(
			run.status,
			`shim exited ${run.status}:\n${run.stdout}\n${run.stderr}`,
		).toBe(1);
		const envelope = JSON.parse(run.stdout) as CliResultShape;
		expect(envelope.ok).toBe(false);
		expect(envelope.exitCode).toBe(1);
		expect(envelope.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
		);
	});
});
