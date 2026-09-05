import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * TypeScript extractor lazy `typescript` dependency (VERSAILLES-190).
 *
 * The bug: `typescript` is a hard runtime `dependency` (package.json:45) AND
 * the TS extractor eagerly imports the compiler API at module load
 * (packages/frontend-ts/src/extractors/typescript.ts:49). Consumers who never
 * run extract-manifests on a TS project still pay the dependency cost.
 *
 * The fix: the extractor lazy-loads the compiler API inside the extract path
 * (dynamic `await import("typescript")`) and `typescript` moves to an
 * optional/peer/dev dependency. These tests pin the lazy-load contract:
 *
 * 1. Importing the extractor module must NOT require `typescript` to be
 *    resolvable — no top-level static `import ... from "typescript"` and no
 *    module-level compiler-options constant that evaluates ts namespace
 *    members (module load must not touch `typescript` at all).
 * 2. The extract function, when `typescript` is unresolvable, fails with a
 *    structured EXTRACTOR_DEPENDENCY_MISSING error (consistent with the
 *    CLI's { code, detail } structured-error conventions) — never a raw
 *    module-not-found throw leaking out of the CLI.
 *
 * The regression guard — real `typescript` present (vitest/bun run in this
 * repo, which HAS typescript) → extraction still works — lives in
 * tests/extractor.test.ts, which imports the same module WITHOUT this mock.
 *
 * Mock strategy: the `typescript` module factory THROWS — exactly what
 * `await import("typescript")` does for a consumer who never installed the
 * package. Under the current eager-import code, importing the extractor
 * module itself rejects (the top-level `import ts from "typescript"` runs
 * first, and the module-level COMPILER_OPTIONS constant then evaluates
 * ts.ScriptTarget/ModuleKind/ModuleResolutionKind) — these tests are the RED
 * pin for the fix.
 */
vi.mock("typescript", () => {
	throw new Error("Cannot find module 'typescript'");
});

// ── Fixture source ─────────────────────────────────────────────────────────

const ACCOUNT_SOURCE = `
export class Account {
	balance: number;
	owner: string;
	tags: string[];
}
`;

// ── Fixture helpers ────────────────────────────────────────────────────────

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-ts-dep-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

/** Creates a fresh per-test subdir under the shared temp root. */
async function fixtureDir(name: string): Promise<string> {
	const dir = join(tempRoot, name);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	return dir;
}

/** Writes a fixture file (creating parent dirs), returning its absolute path. */
async function writeFixture(
	dir: string,
	relativePath: string,
	source: string,
): Promise<string> {
	const filePath = join(dir, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `${source}\n`, "utf8");
	return filePath;
}

// ── Lazy dependency pins (VERSAILLES-190) ──────────────────────────────────

describe("typescriptExtractor — lazy `typescript` dependency (VERSAILLES-190)", () => {
	it("imports the extractor module without `typescript` being resolvable — no top-level static typescript import", async () => {
		// With `typescript` mocked to throw on resolution, the module must
		// still load: the compiler API is only touched inside the extract
		// path. Today the top-level `import ts from "typescript"` plus the
		// module-level COMPILER_OPTIONS constant (ts.ScriptTarget / ts.ModuleKind
		// / ts.ModuleResolutionKind) make this import reject — the RED pin.
		const mod = await import(
			"../packages/frontend-ts/src/extractors/typescript.js"
		);

		expect(mod.typescriptExtractor).toBeDefined();
		expect(mod.typescriptExtractor.language).toBe("typescript");
	});

	it("fails with a structured EXTRACTOR_DEPENDENCY_MISSING error when `typescript` is unresolvable — never a raw module-not-found crash", async () => {
		const dir = await fixtureDir("dep-missing");
		await writeFixture(dir, "account.ts", ACCOUNT_SOURCE);

		const { typescriptExtractor } = await import(
			"../packages/frontend-ts/src/extractors/typescript.js"
		);

		// Normalize sync-throw OR async-reject (the fix may make the extract
		// path async) into a single outcome value.
		let outcome: unknown;
		try {
			await typescriptExtractor.extract([dir]);
		} catch (error) {
			outcome = error;
		}

		expect(outcome).toBeDefined();
		// The structured code — consistent with the CLI's { code, detail }
		// error conventions — never the raw throw from import().
		expect(outcome).toMatchObject({ code: "EXTRACTOR_DEPENDENCY_MISSING" });
		// The message/detail tells the user exactly what is missing.
		const detail = String(
			(outcome as { detail?: unknown }).detail ??
				(outcome as { message?: unknown }).message ??
				"",
		);
		expect(detail).toMatch(/typescript/i);
	});
});
