import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractManifests } from "../src/extractors/index.js";

/**
 * CLI property tests — pin the machine-readable contract of runCli under
 * GENERATED inputs, complementing the fixed battery in tests/cli.test.ts.
 *
 * Grounding: docs/contracts/versailles.contract.yaml (invariants: every
 * command path exits 0/1/2, machine output deterministic, no unstructured
 * throws), build-spec §10 (stable JSON, agent-iteration), ADR-0002
 * (determinism) and ADR-0010 (no LLM / never a raw throw).
 *
 * The Red phase applies identically: src/cli/index.ts does not exist on this
 * branch yet, so the dynamic import in beforeAll rejects and every test here
 * fails with ERR_MODULE_NOT_FOUND — the expected Red state.
 *
 * ── Properties ────────────────────────────────────────────────────────────
 *
 * 1. Never throws + always the envelope: for ANY argv vector (arbitrary
 *    strings, including empty strings and commands that don't exist) runCli
 *    resolves with { ok: boolean, errors: array, warnings: array,
 *    exitCode ∈ {0,1,2} } — never rejects, never an unstructured throw
 *    (contract invariant: every failure surface is a structured error).
 * 2. Determinism: running the same argv twice against the same workspace
 *    yields byte-identical JSON — no timestamps, randomness, or
 *    environment-dependent content (ADR-0002). Property 2 runs a fixed set
 *    of real commands (not arbitrary argv) so the assertion stays
 *    meaningful — arbitrary argv mostly exercises usage-error paths.
 *
 * Both properties run against ONE real seeded workspace (built once in
 * beforeAll) so the generated inputs exercise the same loaded context.
 * numRuns is 100 for never-throws (cheap) and 25 for the byte-identity
 * property (each run writes generated files; kept modest for CI speed).
 */

// The exact SEEDED_CONFIG from src/cli/init.ts — the fixture workspace must
// be valid for the loader so property failures are CLI failures, not
// fixture failures.
const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

const ACCOUNT = "AccountService";

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

let workspaceDir: string;

beforeAll(async () => {
	// Red phase: this rejects with ERR_MODULE_NOT_FOUND until the Power
	// Forward implements src/cli/index.ts (the surface pinned in
	// tests/cli.test.ts). The rejection fails every property below.
	({ runCli } = await import("../src/cli/index.js"));

	// Build one real, loader-valid workspace (generator fixture + source for
	// staleness-aware commands) shared by every property run.
	workspaceDir = await mkdtemp(join(tmpdir(), "versailles-cli-prop-"));
	await mkdir(join(workspaceDir, ".versailles"), { recursive: true });
	await writeWorkspaceFile(workspaceDir, "config.json", SEEDED_CONFIG);
	await writeWorkspaceFile(workspaceDir, "contracts.json", {
		version: "1.0",
		contracts: {
			[ACCOUNT]: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "AccountService.withdraw.pre0", expr: "amount >= 10" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	});
	await writeWorkspaceFile(workspaceDir, "manifests.json", {
		version: "1.0",
		manifests: {
			[ACCOUNT]: {
				sourceHash: "man-account",
				fields: { balance: "number" },
			},
		},
	});
	await writeWorkspaceFile(workspaceDir, "predicates.json", {
		version: "1.0",
		predicates: {},
	});
	// Real source so extract/check commands see a scannable sourceRoot.
	await mkdir(join(workspaceDir, "src"), { recursive: true });
	await writeFile(
		join(workspaceDir, "src", "AccountService.ts"),
		`export class AccountService {
	balance: number;
}
`,
		"utf8",
	);
	// Store the source-consistent manifest hash so check stays clean.
	const result = extractManifests([join(workspaceDir, "src")]);
	const accountEntry = result.manifests[ACCOUNT];
	await writeWorkspaceFile(workspaceDir, "manifests.json", {
		version: "1.0",
		manifests: {
			[ACCOUNT]: {
				sourceHash: accountEntry.sourceHash,
				fields: Object.fromEntries(
					accountEntry.fields.map((field) => [field.name, field.typeRef]),
				),
			},
		},
	});
});

afterAll(async () => {
	// workspaceDir is only assigned after the runCli import succeeds; when
	// the module is missing (Red phase) it stays undefined and there is
	// nothing to clean up.
	if (workspaceDir) {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});

// Arbitrary argv: any vector of strings — empty, garbage, real commands with
// extra positionals — must resolve, never reject.
const argvArb: fc.Arbitrary<string[]> = fc.array(fc.string(), {
	minLength: 0,
	maxLength: 5,
});

describe("runCli — never throws, always the structured envelope (ADR-0010)", () => {
	it("resolves for ANY argv vector with { ok, errors, warnings, exitCode ∈ {0,1,2} }", async () => {
		await fc.assert(
			fc.asyncProperty(argvArb, async (argv) => {
				const result = await runCli(argv, { cwd: workspaceDir });

				expect(typeof result.ok).toBe("boolean");
				expect(Array.isArray(result.errors)).toBe(true);
				expect(Array.isArray(result.warnings)).toBe(true);
				expect([0, 1, 2]).toContain(result.exitCode);
			}),
			{ numRuns: 100 },
		);
	});

	it("every error/warning entry is a structured object with a string code and detail (never a thrown string)", async () => {
		await fc.assert(
			fc.asyncProperty(argvArb, async (argv) => {
				const result = await runCli(argv, { cwd: workspaceDir });

				for (const error of result.errors) {
					expect(typeof error.code).toBe("string");
					expect(error.code.length).toBeGreaterThan(0);
					expect(typeof error.detail).toBe("string");
				}
				for (const warning of result.warnings) {
					expect(typeof warning.code).toBe("string");
					expect(typeof warning.detail).toBe("string");
				}
			}),
			{ numRuns: 100 },
		);
	});
});

describe("runCli — machine-readable determinism (ADR-0002)", () => {
	const deterministicCommands: string[][] = [
		["validate"],
		["check"],
		["generate"],
		["init"],
	];

	it("byte-identical JSON for the same argv twice against the same workspace", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...deterministicCommands.map((c) => JSON.stringify(c))),
				async (serialized) => {
					const argv = JSON.parse(serialized) as string[];
					const first = await runCli(argv, { cwd: workspaceDir });
					const second = await runCli(argv, { cwd: workspaceDir });

					expect(JSON.stringify(first)).toBe(JSON.stringify(second));
				},
			),
			{ numRuns: 25 },
		);
	});
});
