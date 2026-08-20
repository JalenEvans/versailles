import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Reference example (VERSAILLES-17, "Get Ready For Beta" sprint Phase 3):
 * an examples/ directory holding a minimal TS domain (OrderService) with a
 * COMMITTED .versailles/ workspace (config.json, contracts.json,
 * manifests.json, predicates.json) and generated tests under
 * .versailles/generated/ — the dogfood path that proves determinism for beta
 * users. The root npm script "example:generate" regenerates that output and
 * asserts byte-identical regeneration. These tests pin the Phase 3 surface:
 *
 * 1. package.json declares scripts.example:generate as a non-empty string.
 * 2. The idempotency integration test: copy the committed example to a temp
 *    baseline, run `bun run example:generate` from the repo root twice, and
 *    assert (a) generated output is byte-identical across runs, (b) it is
 *    byte-identical to the committed baseline, and (c) `git diff --quiet` on
 *    examples/ stays clean — the ticket's "git diff clean after re-run"
 *    acceptance criterion (docs/specs/versailles.md: "the output under
 *    generated/ is identical (full-file, idempotent regeneration)").
 * 3. A static guard: the example flow runs on the nine-command CLI surface
 *    (docs/build-spec.md §12); src/cli/index.ts's COMMANDS dispatch set must
 *    contain every command the flow uses. This is a guard, not a Red — the
 *    commands exist today.
 *
 * RED PHASE: tests 1 and 2 fail now (no scripts.example:generate, no
 * examples/). Test 2 must NEVER pass vacuously: a missing examples/ dir or an
 * empty committed generated/ output fails loudly, never silently.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const EXAMPLE_ROOT = join(REPO_ROOT, "examples");
const DISPATCH_SOURCE_PATH = join(REPO_ROOT, "src", "cli", "index.ts");

// Two full example:generate runs (each builds + regenerates) plus a git call:
// generous so CI is never flaky, bounded so a hung script fails the test.
const GENERATE_TIMEOUT_MS = 120_000;

type PackageJson = {
	scripts?: Record<string, string>;
};

async function readPackageJson(): Promise<PackageJson> {
	return JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

/** The concrete example directory: examples/order-service if present, else examples/. */
function resolveExampleDir(): string {
	const orderService = join(EXAMPLE_ROOT, "order-service");
	return existsSync(orderService) ? orderService : EXAMPLE_ROOT;
}

/**
 * Every file under <exampleDir>/.versailles/generated/, keyed by its path
 * relative to the generated dir. Missing dir → {} (callers guard on non-empty).
 */
async function collectGenerated(
	exampleDir: string,
): Promise<Record<string, string>> {
	const generatedDir = join(exampleDir, ".versailles", "generated");
	const files: Record<string, string> = {};
	async function walk(dir: string): Promise<void> {
		let entries: {
			name: string;
			isDirectory(): boolean;
			isFile(): boolean;
		}[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				files[relative(generatedDir, full)] = await readFile(full, "utf8");
			}
		}
	}
	await walk(generatedDir);
	return files;
}

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-example-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

/** Runs `bun run example:generate` from the repo root (the script's cwd). */
function runExampleGenerate() {
	return spawnSync("bun", ["run", "example:generate"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: GENERATE_TIMEOUT_MS,
	});
}

/** Human-readable spawn failure: exit code, error, stdout, stderr. */
function describeRun(label: string, run: ReturnType<typeof spawnSync>): string {
	const error = run.error ? `\n${run.error.message}` : "";
	return `${label} exited ${run.status}:${error}\n${run.stdout}\n${run.stderr}`;
}

// ── package.json example:generate script (VERSAILLES-17) ───────────────────

describe("reference example — package.json example:generate script (VERSAILLES-17)", () => {
	it("declares a non-empty `example:generate` script that regenerates the example output", async () => {
		const pkg = await readPackageJson();

		expect(pkg.scripts).toBeDefined();
		expect(pkg.scripts?.["example:generate"]).toBeDefined();
		// Whatever the exact spelling, the script must run something — never a
		// no-op placeholder that "passes" idempotency vacuously.
		expect(pkg.scripts?.["example:generate"]?.trim().length).toBeGreaterThan(0);
	});
});

// ── Idempotent regeneration (VERSAILLES-17 determinism proof) ───────────────

describe("reference example — idempotent regeneration (VERSAILLES-17)", () => {
	it(
		"`bun run example:generate` is idempotent: generated output is byte-identical across runs and the committed example is unchanged (git diff clean)",
		async () => {
			// Red-phase guard: the example must exist before the script can
			// regenerate it. Fail LOUDLY — never pass vacuously because
			// examples/ is missing.
			expect(
				existsSync(EXAMPLE_ROOT),
				"examples/ does not exist — Phase 3 not implemented: create examples/ with a minimal TS domain, a committed .versailles/ workspace, and committed generated/ output",
			).toBe(true);

			const exampleDir = resolveExampleDir();

			// Baseline snapshot of the committed example (never trust the live
			// tree; exclude node_modules/.git so the copy stays small).
			const baseline = join(tempRoot, "example-baseline");
			await cp(exampleDir, baseline, {
				recursive: true,
				filter: (src) =>
					!src.split(sep).includes("node_modules") &&
					!src.split(sep).includes(".git"),
			});

			// The committed generated/ output must be non-empty — a
			// byte-identical comparison of zero files proves nothing.
			const baselineGenerated = await collectGenerated(baseline);
			expect(
				Object.keys(baselineGenerated).length,
				`the committed example has no generated output under ${exampleDir}/.versailles/generated — Phase 3 must commit tool-owned generated tests + coverage.json`,
			).toBeGreaterThan(0);

			// Run 1: regenerate in place from the repo root.
			const run1 = runExampleGenerate();
			expect(run1.status, describeRun("first example:generate run", run1)).toBe(
				0,
			);
			const afterRun1 = await collectGenerated(exampleDir);

			// Run 2: the same command again.
			const run2 = runExampleGenerate();
			expect(
				run2.status,
				describeRun("second example:generate run", run2),
			).toBe(0);
			const afterRun2 = await collectGenerated(exampleDir);

			// Idempotency: the second run produced byte-identical output.
			expect(afterRun2).toEqual(afterRun1);
			// Determinism vs the committed baseline: regeneration changed nothing.
			expect(afterRun1).toEqual(baselineGenerated);
			// git-level check (the ticket's acceptance criterion): no diff on examples/.
			const diff = spawnSync(
				"git",
				["diff", "--quiet", "--exit-code", "--", "examples"],
				{ cwd: REPO_ROOT, encoding: "utf8", timeout: GENERATE_TIMEOUT_MS },
			);
			expect(
				diff.status,
				`examples/ drifted after example:generate — committed generated/ must be unchanged:\n${describeRun("git diff --quiet -- examples", diff)}`,
			).toBe(0);
		},
		GENERATE_TIMEOUT_MS,
	);
});

// ── CLI flow commands guard (docs/build-spec.md §12) ───────────────────────

describe("reference example — CLI flow commands (guard, build-spec §12)", () => {
	it("dispatches every example-flow command in src/cli/index.ts's COMMANDS set — init → extract-manifests → validate → review --approve → generate → check, plus register-predicate / verify-purity / remind-unverified", async () => {
		const source = await readFile(DISPATCH_SOURCE_PATH, "utf8");
		const setMatch = source.match(
			/const COMMANDS = new Set\(\[([\s\S]*?)\]\);/,
		);
		if (!setMatch) {
			throw new Error(
				"src/cli/index.ts must define `const COMMANDS = new Set([...])` — the example flow relies on the dispatch table",
			);
		}
		const setBody = setMatch[1];
		const flowCommands = [
			"init",
			"extract-manifests",
			"validate",
			"check",
			"generate",
			"review",
			"register-predicate",
			"verify-purity",
			"remind-unverified",
		];
		for (const command of flowCommands) {
			expect(
				setBody,
				`COMMANDS dispatch set is missing "${command}" — the example flow cannot run without it`,
			).toContain(`"${command}"`);
		}
	});
});
