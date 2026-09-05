import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * EXTRACTOR_DEPENDENCY_MISSING survives the CLI boundary (VERSAILLES-191 W1).
 *
 * The bug: when the TS extractor cannot resolve the `typescript` package it
 * throws a structured `ExtractorDependencyMissingError` ({ code:
 * "EXTRACTOR_DEPENDENCY_MISSING", detail: "TypeScript extraction requires the
 * 'typescript' package (npm i typescript)" }), but neither
 * handleExtractManifests (packages/cli/src/cli/handlers/extract.ts:59) nor
 * handleCheck (packages/cli/src/cli/handlers/check.ts:50) catch it — the
 * handler's `extractManifests(roots, cwd)` throw falls into runCli's generic
 * catch (packages/cli/src/cli/index.ts:61-74) and is re-wrapped as
 * { code: "INTERNAL" }. The detail string survives but the designed error code
 * is lost — CI cannot distinguish "install typescript" from an internal bug.
 *
 * These tests pin the CORRECT boundary behavior: the command returns a
 * structured CliResult error whose code is EXTRACTOR_DEPENDENCY_MISSING (NOT
 * INTERNAL) and exits non-zero. They are RED against the current
 * implementation (which masks to INTERNAL) — the GREEN fix must catch
 * ExtractorDependencyMissingError in the handlers and return the same code.
 *
 * Mock strategy: the handlers import extractManifests from
 * ../../../../frontend-ts/src/extractors/index.js; the module path is the
 * seam. We mock that module (same resolved path from this test file) via
 * importOriginal-spread so every OTHER real export stays intact (mergeManifests,
 * computeSourceHash, the real ExtractorDependencyMissingError class) and only
 * extractManifests throws the structured dependency error — exactly what a
 * consumer without `typescript` installed would hit.
 */
vi.mock(
	"../packages/frontend-ts/src/extractors/index.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../packages/frontend-ts/src/extractors/index.js")
			>();
		return {
			...actual,
			extractManifests: () => {
				throw new actual.ExtractorDependencyMissingError(
					"TypeScript extraction requires the 'typescript' package (npm i typescript)",
				);
			},
		};
	},
);

// ── Fixture helpers ─────────────────────────────────────────────────────────

const SEEDED_CONFIG = {
	$schema: "../config.schema.json",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

type CliErrorShape = { code: string; detail: string };
type CliResultShape = {
	ok: boolean;
	errors: CliErrorShape[];
	warnings: CliErrorShape[];
	exitCode: number;
	output?: unknown;
};
type RunCli = (
	argv: string[],
	options?: { cwd?: string },
) => Promise<CliResultShape>;

let runCli!: RunCli;

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-cli-dep-"));
	({ runCli } = await import("../packages/cli/src/cli/index.js"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

/**
 * A valid workspace with a real source file under <cwd>/src/ so
 * expandSourceRoots resolves a non-empty root, sourceRootsGuard passes, and
 * the handler reaches the mocked extractManifests (which throws).
 */
async function validWorkspaceWithSource(name: string): Promise<string> {
	const cwd = join(tempRoot, name);
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeFile(
		join(cwd, ".versailles", "config.json"),
		`${JSON.stringify(SEEDED_CONFIG, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		join(cwd, ".versailles", "contracts.json"),
		`${JSON.stringify({ contracts: {} }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		join(cwd, ".versailles", "manifests.json"),
		`${JSON.stringify({ manifests: {} }, null, 2)}\n`,
		"utf8",
	);
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(
		join(cwd, "src", "Account.ts"),
		"export class Account {\n\tbalance: number;\n}\n",
		"utf8",
	);
	return cwd;
}

// ── RED pins: EXTRACTOR_DEPENDENCY_MISSING at the CLI boundary (VERSAILLES-191) ──

describe("runCli — EXTRACTOR_DEPENDENCY_MISSING survives the boundary (VERSAILLES-191 W1)", () => {
	it("extract-manifests returns a structured EXTRACTOR_DEPENDENCY_MISSING error — never the generic INTERNAL mask, exit non-zero", async () => {
		const cwd = await validWorkspaceWithSource("dep-missing-extract");
		const result = await runCli(["extract-manifests"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		// The designed code must survive the handler → runCli boundary.
		expect(result.errors[0]?.code).toBe("EXTRACTOR_DEPENDENCY_MISSING");
		// The actionable detail must survive too.
		expect(result.errors[0]?.detail).toMatch(/typescript/i);
	});

	it("check returns a structured EXTRACTOR_DEPENDENCY_MISSING error — handleCheck routes through the extractor too, never the generic INTERNAL mask, exit non-zero", async () => {
		const cwd = await validWorkspaceWithSource("dep-missing-check");
		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors[0]?.code).toBe("EXTRACTOR_DEPENDENCY_MISSING");
		expect(result.errors[0]?.detail).toMatch(/typescript/i);
	});
});
