import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractManifests } from "../src/extractors/index.js";

/**
 * CLI surface + machine-readable output (Phases 6+7, VERSAILLES-8 +
 * VERSAILLES-9) — pinned against docs/contracts/versailles.contract.yaml,
 * build-spec §8 (staleness/exit codes), §10 (machine-readable output),
 * §12 (command table), ADR-0002 (determinism) and ADR-0010 (no LLM).
 *
 * ══ RED-PHASE NOTE ════════════════════════════════════════════════════════
 * This file defines the module surface the Power Forward must implement at
 * src/cli/index.ts. That module does NOT exist on this branch yet (only
 * src/cli/init.ts does), and src/generator/ is only a .gitkeep on this branch
 * (the generator lives on feat/generator-core and will be integrated). The
 * dynamic import below therefore rejects with ERR_MODULE_NOT_FOUND today —
 * that failure, propagated through the beforeAll hook, is the EXPECTED Red
 * state. Once the module lands, these tests pin its behavior.
 *
 * ── Module contract (what these tests require from src/cli/index.ts) ──────
 *
 * ```ts
 * export type CliError = {
 *   code: string;          // e.g. UNKNOWN_COMMAND | USAGE | PARSE_ERROR |
 *                          // MISSING_FILE | CONFIG_INVALID | STALE |
 *                          // REVIEW_NOT_AVAILABLE | ...
 *   field?: string;        // file / path the error is about
 *   detail: string;        // human-readable, agent-consumable detail
 *   ids?: string[];        // present on STALE errors: stale entry IDs (§8)
 * };
 *
 * export type CliResult = {
 *   ok: boolean;
 *   errors: CliError[];    // hard errors → exitCode 1 or 2
 *   warnings: CliError[];  // non-blocking → exitCode 0
 *   exitCode: 0 | 1 | 2;   // 0 clean · 1 parse/validation/usage · 2 staleness
 *   output?: unknown;      // per-command machine-readable payload
 * };
 *
 * // Pure-ish testable entry: NO process.exit, NO stdout/stderr writes.
 * // argv is process.argv minus node and script (e.g. ["validate"]).
 * // Commands run against <options.cwd>/.versailles/ (default: process.cwd()).
 * export declare function runCli(
 *   argv: string[],
 *   options?: { cwd?: string },
 * ): Promise<CliResult>;
 * ```
 *
 * ── Per-command output payloads (defined by these tests) ──────────────────
 *
 * | command           | output (machine-readable payload)                       |
 * |-------------------|--------------------------------------------------------|
 * | init              | { workspaceDir: string }  (.versailles dir created)     |
 * | extract-manifests | { updated: string[], preserved: string[], pruned: string[] } |
 * | validate          | { valid: boolean }                                     |
 * | check             | { staleIds: string[] }                                 |
 * | generate          | { files: string[] }  (paths written, relative to cwd)   |
 * | review            | (view/approve/reject payloads — pinned in tests/review.test.ts) |
 *
 * updated   = components covered by the fresh extraction (added OR refreshed)
 * preserved = components in the previous manifests.json the extraction did not
 *             cover, kept because --prune was not passed
 * pruned    = components in the previous manifests.json the extraction did not
 *             cover, REMOVED because --prune was passed
 * All three arrays are sorted for deterministic JSON (ADR-0002).
 *
 * ── Command behaviors pinned (exit codes are the contract) ────────────────
 *
 * 1. Routing (§12): argv[0] routes to init | extract-manifests | validate |
 *    check | generate | review <component> [operation]. Unknown commands
 *    (`author`, `bogus`) → { code: "UNKNOWN_COMMAND" } exit 1 — never exit 2.
 * 2. Usage errors: commands other than review accept NO unexpected
 *    positionals; review accepts exactly 1 required positional (component)
 *    plus an optional second (operation); any other shape → USAGE exit 1.
 * 3. init: scaffolds .versailles/ (config.json + empty stores) and exits 0.
 * 4. validate: ok true/exit 0 on a valid workspace; ok false/exit 1 with
 *    structured errors on parse or validation errors or load failures —
 *    never an unstructured throw.
 * 5. check (§8): exit 0 clean; exit 1 when parse/validation errors are
 *    present; exit 2 + STALE ids when stored manifest sourceHash differs
 *    from the recomputed hash and staleness.blockOnStale is true; exit 0 +
 *    STALE warning when blockOnStale is false.
 * 6. generate (§9): exit 0 and writes test files under config.generatedDir
 *    when the context is valid; exit 1, writes nothing, when invalid;
 *    rejection idiom read from config.rejection.idiom (default throws,
 *    ADR-0007). Routes through src/generator/index.js (planTestCases /
 *    emitSuite / coverageManifest) — the generator surface is pinned in the
 *    dedicated describe below and the PF integrates feat/generator-core.
 * 7. review: arg validation happens at the CLI boundary; valid arg shapes
 *    (component [operation]) route to the review handler. A valid shape with
 *    NO staged object returns NOT_FOUND (exit 1) — never REVIEW_NOT_AVAILABLE,
 *    never UNKNOWN_COMMAND. The full flow (scoped view / --approve /
 *    --reject) is pinned in tests/review.test.ts.
 * 8. Determinism (ADR-0002): same argv + same workspace → byte-identical
 *    JSON (no timestamps / randomness) — no LLM is ever invoked (ADR-0010).
 *
 * ── Fixture strategy ──────────────────────────────────────────────────────
 *
 * Every test writes its own .versailles/ workspace into a fresh per-test
 * mkdtemp subdir. Workspaces are written directly (never through the module
 * under test) so fixture failures are distinguishable from CLI failures.
 * Staleness fixtures use REAL source files under <cwd>/src/ and REAL hashes
 * computed via the extractor (computeSourceHash through extractManifests):
 * a stored hash equal to the recomputed hash is clean; mutating the source
 * (adding a field) makes the recomputed hash differ → stale. Check fixtures
 * keep contracts.json/predicates.json empty so the ONLY staleness signal is
 * the manifest-entry hash (the §8 mechanism implemented in PR 2).
 */

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

const ACCOUNT = "AccountService";
const CUSTOMER = "CustomerService";

/** Generator fixture (valid through the real loader — verified): §9.1 + §9.2 case sources. */
function generatorContracts(): unknown {
	return {
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
							{ id: "AccountService.withdraw.pre1", expr: "amount <= 100" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
							{
								id: "AccountService.withdraw.post1",
								expr: "old(balance) >= balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
					setStatus: {
						id: "AccountService.setStatus",
						params: [{ name: "newStatus", type: "string" }],
						preconditions: [
							{
								id: "AccountService.setStatus.pre0",
								expr: 'newStatus in ["ACTIVE", "FROZEN"]',
							},
						],
						postconditions: [
							{
								id: "AccountService.setStatus.post0",
								expr: "status == newStatus",
							},
						],
						effects: [{ field: "status", kind: "mutate" }],
						sourceHash: "setstatus-hash",
					},
				},
			},
			[CUSTOMER]: {
				invariants: [],
				operations: {
					upgrade: {
						id: "CustomerService.upgrade",
						params: [{ name: "newTier", type: "enum<GOLD,SILVER>" }],
						preconditions: [
							{
								id: "CustomerService.upgrade.pre0",
								expr: "newTier != null",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "upgrade-hash",
					},
				},
			},
		},
	};
}

function generatorManifests(): unknown {
	return {
		version: "1.0",
		manifests: {
			[ACCOUNT]: {
				sourceHash: "man-account",
				fields: { balance: "number", status: "string" },
			},
			[CUSTOMER]: { sourceHash: "man-customer", fields: {} },
		},
	};
}

function emptyPredicates(): unknown {
	return { version: "1.0", predicates: {} };
}

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
 * Scaffolds a fresh workspace (with optional config overrides) into its own
 * temp subdir. Writes the four jointly-loaded files directly so fixtures do
 * not depend on the CLI under test.
 */
async function freshWorkspace(
	name: string,
	configOverrides: Record<string, unknown> = {},
): Promise<string> {
	const cwd = join(tempRoot, name);
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeWorkspaceFile(cwd, "config.json", {
		...SEEDED_CONFIG,
		...configOverrides,
	});
	await writeWorkspaceFile(cwd, "contracts.json", {
		version: "1.0",
		contracts: {},
	});
	await writeWorkspaceFile(cwd, "manifests.json", {
		version: "1.0",
		manifests: {},
	});
	await writeWorkspaceFile(cwd, "predicates.json", emptyPredicates());
	return cwd;
}

/** Overlays the generator fixture (valid workspace) onto a fresh workspace. */
async function seedGeneratorWorkspace(name: string): Promise<string> {
	const cwd = await freshWorkspace(name);
	await writeWorkspaceFile(cwd, "contracts.json", generatorContracts());
	await writeWorkspaceFile(cwd, "manifests.json", generatorManifests());
	return cwd;
}

/**
 * Extractor-derived manifests store (loader format) for the fixture source
 * under <cwd>/src/ — the same derivation the extract-manifests command and
 * the §8 staleness recompute must produce.
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

/** .test.ts files present under <cwd>/.versailles/generated ([] if absent). */
async function generatedTestFiles(cwd: string): Promise<string[]> {
	try {
		const entries = await readdir(join(cwd, ".versailles", "generated"));
		return entries.filter((entry) => entry.endsWith(".test.ts")).sort();
	} catch {
		return [];
	}
}

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-cli-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── Red-phase import ───────────────────────────────────────────────────────
// src/cli/index.ts does not exist on this branch yet. When it is missing this
// hook rejects and EVERY test below fails with the module-resolution error —
// the expected Red state. When the Power Forward lands the module, the hook
// resolves and the tests pin its behavior.
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

// ── Routing (build-spec §12, ADR-0010) ─────────────────────────────────────

describe("runCli — command routing (build-spec §12)", () => {
	it("returns the machine-readable envelope { ok, errors, warnings, exitCode } for every command — never a raw throw", async () => {
		const cwd = await seedGeneratorWorkspace("a-envelope");
		const commands: string[][] = [
			["init"],
			["extract-manifests"],
			["validate"],
			["check"],
			["generate"],
			["review", ACCOUNT],
		];

		for (const argv of commands) {
			const result = await runCli(argv, { cwd });
			expect(typeof result.ok).toBe("boolean");
			expect(Array.isArray(result.errors)).toBe(true);
			expect(Array.isArray(result.warnings)).toBe(true);
			expect([0, 1, 2]).toContain(result.exitCode);
		}
	});

	it("routes `author` to a structured UNKNOWN_COMMAND usage error, exit 1 — no author subcommand exists (ADR-0010)", async () => {
		const cwd = await freshWorkspace("a-author");
		const result = await runCli(["author", "OrderService"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
		);
	});

	it("routes an unknown command (`bogus`) to a structured UNKNOWN_COMMAND usage error, exit 1 — never exit 2", async () => {
		const cwd = await freshWorkspace("a-bogus");
		const result = await runCli(["bogus"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
		);
	});

	it("treats an empty argv as a missing-command usage error, exit 1", async () => {
		const cwd = await freshWorkspace("a-empty");
		const result = await runCli([], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});
});

// ── Usage errors (build-spec §12) ──────────────────────────────────────────

describe("runCli — usage errors (build-spec §12)", () => {
	it.each(["init", "extract-manifests", "validate", "check", "generate"])(
		"rejects an unexpected positional for `%s` as a USAGE error, exit 1",
		async (command) => {
			const cwd = await seedGeneratorWorkspace(`u-${command}`);
			const result = await runCli([command, "extra"], { cwd });

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.errors).toContainEqual(
				expect.objectContaining({ code: "USAGE" }),
			);
		},
	);

	it("rejects an unknown flag (`--bogus`) for extract-manifests as a USAGE error, exit 1", async () => {
		const cwd = await freshWorkspace("u-bogus-flag");
		const result = await runCli(["extract-manifests", "--bogus"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});

	it("rejects `review` with no component as a USAGE error, exit 1", async () => {
		const cwd = await seedGeneratorWorkspace("u-review-no-component");
		const result = await runCli(["review"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});

	it("rejects `review` with three positionals as a USAGE error, exit 1", async () => {
		const cwd = await seedGeneratorWorkspace("u-review-three");
		const result = await runCli(["review", "A", "B", "C"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});
});

// ── init (build-spec §2, §12) ──────────────────────────────────────────────

describe("runCli init — scaffolds .versailles/ (build-spec §2, §12)", () => {
	it("scaffolds the four jointly-loaded files with a schema-valid seeded config, exit 0", async () => {
		const cwd = await freshWorkspace("i-scaffold");
		const result = await runCli(["init"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const entries = (await readdir(join(cwd, ".versailles"))).sort();
		expect(entries).toEqual([
			"config.json",
			"contracts.json",
			"manifests.json",
			"predicates.json",
		]);

		const config = JSON.parse(
			await readFile(join(cwd, ".versailles", "config.json"), "utf8"),
		) as Record<string, unknown>;
		expect(config).toEqual(SEEDED_CONFIG);
	});

	it("reports the created workspace dir in output", async () => {
		const cwd = await freshWorkspace("i-output");
		const result = await runCli(["init"], { cwd });

		expect(result.output).toMatchObject({
			workspaceDir: join(cwd, ".versailles"),
		});
	});

	it("is idempotent: a second init on an existing workspace exits 0 and preserves the files", async () => {
		const cwd = await freshWorkspace("i-idempotent");
		await runCli(["init"], { cwd });
		const second = await runCli(["init"], { cwd });

		expect(second.ok).toBe(true);
		expect(second.exitCode).toBe(0);
		const entries = (await readdir(join(cwd, ".versailles"))).sort();
		expect(entries).toEqual([
			"config.json",
			"contracts.json",
			"manifests.json",
			"predicates.json",
		]);
	});
});

// ── extract-manifests (build-spec §7) ──────────────────────────────────────

describe("runCli extract-manifests — update covered, preserve uncovered (build-spec §7)", () => {
	const ORDER_SERVICE_SOURCE = `export class OrderService {
	id: number;
	total: number;
}
`;
	const ORDER_ITEM_SOURCE = `export class OrderItem {
	sku: string;
	qty: number;
}
`;

	async function seedExtractWorkspace(name: string): Promise<string> {
		const cwd = await freshWorkspace(name);
		await writeSource(cwd, "OrderService.ts", ORDER_SERVICE_SOURCE);
		await writeSource(cwd, "OrderItem.ts", ORDER_ITEM_SOURCE);
		// A stale covered entry + an uncovered component that must survive.
		await writeWorkspaceFile(cwd, "manifests.json", {
			version: "1.0",
			manifests: {
				OrderService: {
					sourceHash: "deadbeef",
					fields: { id: "number", total: "number" },
				},
				LegacyComponent: {
					sourceHash: "legacy-hash",
					fields: { note: "string" },
				},
			},
		});
		return cwd;
	}

	it("extracts from config.sourceRoots, updates the covered entry, preserves the uncovered entry, exit 0", async () => {
		const cwd = await seedExtractWorkspace("x-merge");
		const result = await runCli(["extract-manifests"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		// output buckets: updated = covered by the extraction (added OR
		// refreshed), preserved = uncovered kept, pruned = [] without --prune.
		expect(result.output).toMatchObject({
			updated: ["OrderItem", "OrderService"],
			preserved: ["LegacyComponent"],
			pruned: [],
		});

		// On-disk manifests.json reflects the merge: OrderService refreshed
		// to the real structural hash, OrderItem added, LegacyComponent kept.
		const stored = JSON.parse(
			await readFile(join(cwd, ".versailles", "manifests.json"), "utf8"),
		) as {
			manifests: Record<
				string,
				{ sourceHash: string; fields: Record<string, string> }
			>;
		};
		const reference = referenceManifests(cwd) as {
			manifests: Record<
				string,
				{ sourceHash: string; fields: Record<string, string> }
			>;
		};
		expect(stored.manifests.OrderService.sourceHash).toBe(
			reference.manifests.OrderService.sourceHash,
		);
		expect(stored.manifests.OrderService.fields).toEqual({
			id: "number",
			total: "number",
		});
		expect(stored.manifests.OrderItem.sourceHash).toBe(
			reference.manifests.OrderItem.sourceHash,
		);
		expect(stored.manifests.LegacyComponent).toEqual({
			sourceHash: "legacy-hash",
			fields: { note: "string" },
		});
	});

	it("with --prune removes the uncovered entry and reports it as pruned, exit 0", async () => {
		const cwd = await seedExtractWorkspace("x-prune");
		const result = await runCli(["extract-manifests", "--prune"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.output).toMatchObject({
			updated: ["OrderItem", "OrderService"],
			preserved: [],
			pruned: ["LegacyComponent"],
		});

		const stored = JSON.parse(
			await readFile(join(cwd, ".versailles", "manifests.json"), "utf8"),
		) as { manifests: Record<string, unknown> };
		expect(stored.manifests.LegacyComponent).toBeUndefined();
		expect(stored.manifests.OrderService).toBeDefined();
		expect(stored.manifests.OrderItem).toBeDefined();
	});
});

// ── validate (build-spec §10, §12) ─────────────────────────────────────────

describe("runCli validate — structured report (build-spec §10)", () => {
	it("valid workspace → ok true, exit 0, output.valid true", async () => {
		const cwd = await seedGeneratorWorkspace("v-valid");
		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.output).toMatchObject({ valid: true });
	});

	it("workspace with a parse error → ok false, PARSE_ERROR in errors, exit 1 — never a throw", async () => {
		const cwd = await freshWorkspace("v-parse-error");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						placeOrder: {
							id: "OrderService.placeOrder",
							params: [],
							preconditions: [],
							postconditions: [
								{ id: "OrderService.placeOrder.post0", expr: "total = 100" },
							],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		await writeWorkspaceFile(cwd, "manifests.json", {
			version: "1.0",
			manifests: {
				OrderService: {
					sourceHash: "man-os",
					fields: { total: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				code: "PARSE_ERROR",
				field: "postconditions[0]",
			}),
		);
		expect(result.output).toMatchObject({ valid: false });
	});

	it("workspace with a semantic validation error → ok false, UNKNOWN_FIELD in errors, exit 1", async () => {
		const cwd = await freshWorkspace("v-semantic-error");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			contracts: {
				svc: {
					invariants: [],
					operations: {
						op: {
							id: "svc.op",
							params: [],
							preconditions: [{ id: "svc.op.pre0", expr: "missingField == 0" }],
							postconditions: [],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		await writeWorkspaceFile(cwd, "manifests.json", {
			version: "1.0",
			manifests: {
				svc: { sourceHash: "man-svc", fields: { known: "number" } },
			},
		});

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_FIELD" }),
		);
	});

	it("load failure (missing file) → ok false, MISSING_FILE in errors, exit 1 — never a throw", async () => {
		const cwd = await freshWorkspace("v-missing-file");
		await rm(join(cwd, ".versailles", "contracts.json"), { force: true });

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				code: "MISSING_FILE",
				field: "contracts.json",
			}),
		);
	});
});

// ── check (build-spec §8) ──────────────────────────────────────────────────

describe("runCli check — staleness / exit codes (build-spec §8)", () => {
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

	it("clean workspace (stored hash == recomputed) → ok true, exit 0, no STALE", async () => {
		const cwd = await freshWorkspace("c-clean");
		await writeSource(cwd, "OrderService.ts", SOURCE_VERSION_A);
		await writeWorkspaceFile(cwd, "manifests.json", referenceManifests(cwd));

		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.warnings).not.toContainEqual(
			expect.objectContaining({ code: "STALE" }),
		);
		expect(result.output).toMatchObject({ staleIds: [] });
	});

	it("validation errors dominate staleness → exit 1 with the validation error (never 2)", async () => {
		const cwd = await freshWorkspace("c-validation-error");
		await writeSource(cwd, "OrderService.ts", SOURCE_VERSION_A);
		await writeWorkspaceFile(cwd, "manifests.json", referenceManifests(cwd));
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			contracts: {
				svc: {
					invariants: [],
					operations: {
						op: {
							id: "svc.op",
							params: [],
							preconditions: [{ id: "svc.op.pre0", expr: "missingField == 0" }],
							postconditions: [],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});

		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_FIELD" }),
		);
	});

	it("stale manifests with staleness.blockOnStale true → exit 2, STALE error listing stale IDs", async () => {
		const cwd = await freshWorkspace("c-stale-block");
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

	it("stale manifests with staleness.blockOnStale false → exit 0, STALE warning report", async () => {
		const cwd = await freshWorkspace("c-stale-warn", {
			staleness: { blockOnStale: false },
		});
		await writeSource(cwd, "OrderService.ts", SOURCE_VERSION_A);
		await writeWorkspaceFile(cwd, "manifests.json", referenceManifests(cwd));
		await writeSource(cwd, "OrderService.ts", SOURCE_VERSION_B);

		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ code: "STALE", ids: ["OrderService"] }),
		);
		expect(result.output).toMatchObject({ staleIds: ["OrderService"] });
	});
});

// ── generate (build-spec §9) ───────────────────────────────────────────────

describe("runCli generate — deterministic generation (build-spec §9)", () => {
	it("valid workspace → exit 0, writes test files under config.generatedDir, output.files lists them", async () => {
		const cwd = await seedGeneratorWorkspace("g-valid");
		const result = await runCli(["generate"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.output).toMatchObject({
			files: expect.arrayContaining([
				".versailles/generated/AccountService.test.ts",
				".versailles/generated/CustomerService.test.ts",
			]),
		});

		// Files exist on disk under the configured generatedDir.
		expect(await generatedTestFiles(cwd)).toEqual([
			"AccountService.test.ts",
			"CustomerService.test.ts",
		]);
		const content = await readFile(
			join(cwd, ".versailles", "generated", "AccountService.test.ts"),
			"utf8",
		);
		expect(content).toContain("AccountService");
	});

	it("is deterministic: two runs against the same workspace produce byte-identical JSON", async () => {
		const cwd = await seedGeneratorWorkspace("g-deterministic");
		const first = await runCli(["generate"], { cwd });
		const second = await runCli(["generate"], { cwd });

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no timestamps
	});

	it("invalid workspace → exit 1 with structured errors and NO test files written", async () => {
		const cwd = await freshWorkspace("g-invalid");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						placeOrder: {
							id: "OrderService.placeOrder",
							params: [],
							preconditions: [],
							postconditions: [
								{ id: "OrderService.placeOrder.post0", expr: "total = 100" },
							],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		await writeWorkspaceFile(cwd, "manifests.json", {
			version: "1.0",
			manifests: {
				OrderService: {
					sourceHash: "man-os",
					fields: { total: "number" },
				},
			},
		});

		const result = await runCli(["generate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "PARSE_ERROR" }),
		);
		expect(await generatedTestFiles(cwd)).toEqual([]);
	});

	it("honors config.rejection.idiom (default throws) in generated rejection assertions (ADR-0007)", async () => {
		const cwd = await seedGeneratorWorkspace("g-idiom-throws");
		const result = await runCli(["generate"], { cwd });
		expect(result.exitCode).toBe(0);

		const content = await readFile(
			join(cwd, ".versailles", "generated", "AccountService.test.ts"),
			"utf8",
		);
		expect(content).toContain(".toThrow()");
	});

	it('honors config.rejection.idiom "returns" — generated rejection assertions use toBeNull, never toThrow (ADR-0007)', async () => {
		const cwd = await seedGeneratorWorkspace("g-idiom-returns");
		await writeWorkspaceFile(cwd, "config.json", {
			...SEEDED_CONFIG,
			rejection: { idiom: "returns" },
		});

		const result = await runCli(["generate"], { cwd });
		expect(result.exitCode).toBe(0);

		const content = await readFile(
			join(cwd, ".versailles", "generated", "AccountService.test.ts"),
			"utf8",
		);
		expect(content).toContain(".toBeNull()");
		expect(content).not.toContain(".toThrow()");
	});
});

// ── review (valid arg routing; no staged object → NOT_FOUND, exit 1 — real flow) ─

describe("runCli review — valid arg shapes route to the handler; no staged object → NOT_FOUND, exit 1 (flow pinned in tests/review.test.ts)", () => {
	it("valid args (component + operation) route to the review handler — no staged object → NOT_FOUND, exit 1, never REVIEW_NOT_AVAILABLE, never UNKNOWN_COMMAND", async () => {
		const cwd = await seedGeneratorWorkspace("r-two-args");
		const result = await runCli(["review", ACCOUNT, "withdraw"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
		expect(result.errors).not.toContainEqual(
			expect.objectContaining({ code: "REVIEW_NOT_AVAILABLE" }),
		);
		expect(result.errors).not.toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
		);
	});

	it("valid args (component only) also route to the review handler — no staged object → NOT_FOUND, exit 1, never REVIEW_NOT_AVAILABLE", async () => {
		const cwd = await seedGeneratorWorkspace("r-one-arg");
		const result = await runCli(["review", ACCOUNT], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
		expect(result.errors).not.toContainEqual(
			expect.objectContaining({ code: "REVIEW_NOT_AVAILABLE" }),
		);
	});
});

// ── Machine-readable determinism (ADR-0002) ────────────────────────────────

describe("runCli — machine-readable determinism (ADR-0002, build-spec §10)", () => {
	it("validate twice against the same workspace → byte-identical JSON", async () => {
		const cwd = await seedGeneratorWorkspace("d-validate");
		const first = await runCli(["validate"], { cwd });
		const second = await runCli(["validate"], { cwd });

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("check twice against the same workspace → byte-identical JSON", async () => {
		const cwd = await freshWorkspace("d-check");
		await writeSource(
			cwd,
			"OrderService.ts",
			`export class OrderService {
	id: number;
	total: number;
}
`,
		);
		await writeWorkspaceFile(cwd, "manifests.json", referenceManifests(cwd));

		const first = await runCli(["check"], { cwd });
		const second = await runCli(["check"], { cwd });

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

// ── Generator module surface (integrated by the PF from feat/generator-core) ─

describe("generate — generator module surface (src/generator/index.js)", () => {
	let generator:
		| {
				planTestCases: unknown;
				emitSuite: unknown;
				coverageManifest: unknown;
		  }
		| undefined;
	let generatorImportError: unknown;

	beforeAll(async () => {
		try {
			generator = await import("../src/generator/index.js");
		} catch (error) {
			generatorImportError = error;
		}
	});

	it("exposes planTestCases / emitSuite / coverageManifest (the PF integrates feat/generator-core)", () => {
		// Red until the generator lands on this branch: the import above
		// rejected with ERR_MODULE_NOT_FOUND and we re-throw that here so the
		// failure is the module-resolution error, not a vague assertion.
		if (!generator) {
			throw generatorImportError;
		}
		expect(typeof generator.planTestCases).toBe("function");
		expect(typeof generator.emitSuite).toBe("function");
		expect(typeof generator.coverageManifest).toBe("function");
	});

	it("emitSuite renders per-component .test.ts files for the vitest framework (ADR-0008/0009)", () => {
		if (!generator) {
			throw generatorImportError;
		}
		// A minimal hand-built PlannedSuite drives the emitter seam without
		// depending on the loader: the CLI surface pins the same seam.
		const suite = {
			operations: [
				{
					component: ACCOUNT,
					operation: "withdraw",
					cases: [
						{
							id: "AccountService.withdraw.precondition-violation-0",
							kind: "precondition-violation",
							description: "amount below the 10 boundary",
							inputs: { amount: 9 },
							expects: { outcome: "reject", rejectionIdiom: "throws" },
							traces: ["AccountService.withdraw.pre0"],
						},
					],
				},
			],
			invariantCases: [],
			clauseIds: ["AccountService.withdraw.pre0"],
		} as Parameters<typeof generator.emitSuite>[0];

		const files = generator.emitSuite(suite, "vitest");
		expect(files.length).toBeGreaterThan(0);
		const accountFile = files.find(
			(file) => file.path === ".versailles/generated/AccountService.test.ts",
		);
		expect(accountFile).toBeDefined();
		expect(accountFile?.content).toContain(".toThrow()");
	});
});

// ── Center review regressions: pin the FIXED behavior (Red phase) ──────────
//
// The four describes below are the Red-phase pins for the Center review
// findings on the CLI/extractor. Against the current implementation each
// assertion FAILS (verified); the Power Forward must implement the fixed
// behavior so these turn green. They ONLY touch the CLI surface (runCli) —
// no production code is exercised beyond the module under test.

// ── W1: check false-green when sourceRoots resolves to zero roots ─────────
// Current: expandSourceRoots silently skips the non-existent prefix →
// roots = [] → extractManifests([]) = {} → every stored entry is
// "not hash-comparable" and skipped → staleIds = [] → exit 0 CLEAN. In CI
// this disables the staleness gate silently.
// Fixed: when sourceRoots resolves to zero actual roots while stored
// manifests are non-empty, check returns a structured error (code family
// NO_SOURCE_ROOT / ZERO_ROOTS / SOURCE_ROOTS), exit 1 — never a clean 0.

describe("runCli check — zero-resolved sourceRoots must never false-green (Center W1)", () => {
	it("returns a structured error (exit 1) when sourceRoots resolves to zero roots but stored manifests are non-empty — never a clean exit 0", async () => {
		const cwd = await freshWorkspace("c-zero-roots", {
			sourceRoots: ["does-not-exist/**/*.ts"],
		});
		// Genuine grounding the zero-root scan cannot verify: a stored
		// manifest whose hash check must NOT be silently skipped.
		await writeWorkspaceFile(cwd, "manifests.json", {
			version: "1.0",
			manifests: {
				OrderService: {
					sourceHash: "deadbeef",
					fields: { id: "number", total: "number" },
				},
			},
		});

		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(
			result.errors.some((error) =>
				/NO_SOURCE_ROOT|ZERO_ROOTS|SOURCE_ROOTS/.test(error.code),
			),
		).toBe(true);
	});
});

// ── W2: extract-manifests --prune with unusable roots destroys the store ──
// Current: roots = [] → extracted.manifests = {} → merge with prune=true
// removes every stored entry → manifests.json rewritten empty, exit 0. A
// config typo destroys the grounding layer.
// Fixed: when the scan covered nothing (roots empty) while stored manifests
// are non-empty, extract-manifests --prune REFUSES (structured error, exit 1,
// same guard as W1) and the on-disk manifests.json is left unchanged.

describe("runCli extract-manifests --prune — unusable roots must not silently destroy the manifest store (Center W2)", () => {
	it("refuses with a structured error (exit 1) and leaves manifests.json untouched when the scan covered nothing but stored manifests are non-empty", async () => {
		const cwd = await freshWorkspace("x-prune-zero-roots", {
			sourceRoots: ["does-not-exist/**/*.ts"],
		});
		const stored = {
			version: "1.0",
			manifests: {
				OrderService: {
					sourceHash: "deadbeef",
					fields: { id: "number", total: "number" },
				},
			},
		};
		await writeWorkspaceFile(cwd, "manifests.json", stored);
		const before = await readFile(
			join(cwd, ".versailles", "manifests.json"),
			"utf8",
		);

		const result = await runCli(["extract-manifests", "--prune"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(
			result.errors.some((error) =>
				/NO_SOURCE_ROOT|ZERO_ROOTS|SOURCE_ROOTS/.test(error.code),
			),
		).toBe(true);

		// The store must survive: byte-identical and semantically equal.
		const after = await readFile(
			join(cwd, ".versailles", "manifests.json"),
			"utf8",
		);
		expect(after).toBe(before);
		expect(JSON.parse(after)).toEqual(stored);
	});
});

// ── W3: extractor warnings dropped at the CLI boundary ─────────────────────
// Current: extracted.warnings (e.g. LOW_CONFIDENCE_FIELD) are discarded by
// the extract handler (warnings: []) and the check handler (loader warnings
// only) — ADR-0004's "non-blocking warning is surfaced" never reaches the
// envelope.
// Fixed: extraction warnings surface in CliResult.warnings for both
// extract-manifests and check, with exit 0 (warnings are non-blocking).

describe("runCli — extractor warnings surface at the CLI boundary (Center W3, ADR-0004)", () => {
	const PROFILE_SOURCE = `export class Profile {
	name: string;
	balance = 0;
}
`;

	it("extract-manifests returns LOW_CONFIDENCE_FIELD in warnings, ok true, exit 0 — warnings are non-blocking", async () => {
		const cwd = await freshWorkspace("w3-extract-warning");
		await writeSource(cwd, "Profile.ts", PROFILE_SOURCE);

		const result = await runCli(["extract-manifests"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ code: "LOW_CONFIDENCE_FIELD" }),
		);
	});

	it("check surfaces extraction warnings (LOW_CONFIDENCE_FIELD) in warnings while staying exit 0", async () => {
		const cwd = await freshWorkspace("w3-check-warning");
		await writeSource(cwd, "Profile.ts", PROFILE_SOURCE);
		// Consistent stored hashes: staleness is NOT the signal — the only
		// expected warning is the extraction one.
		await writeWorkspaceFile(cwd, "manifests.json", referenceManifests(cwd));

		const result = await runCli(["check"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.output).toMatchObject({ staleIds: [] });
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ code: "LOW_CONFIDENCE_FIELD" }),
		);
	});
});

// ── W4: generate never writes generated/coverage.json ─────────────────────
// Current: the generate handler writes only .test.ts files; coverageManifest
// is never wired to the CLI — build-spec §9.3's coverage artifact is missing.
// Fixed: after generate on a valid workspace, generated/coverage.json exists
// under config.generatedDir, is valid JSON, maps every contract clause id →
// test ids (zero-coverage clauses as empty arrays), and the path appears in
// the machine-readable output (output.files or a coverageFile field).

describe("runCli generate — writes generated/coverage.json (Center W4, build-spec §9.3)", () => {
	it("writes a valid coverage.json mapping every contract clause id → test ids, listed in the output", async () => {
		const cwd = await seedGeneratorWorkspace("g-coverage-json");
		const clauseIds = [
			"AccountService.inv0",
			"AccountService.withdraw.pre0",
			"AccountService.withdraw.pre1",
			"AccountService.withdraw.post0",
			"AccountService.withdraw.post1",
			"AccountService.setStatus.pre0",
			"AccountService.setStatus.post0",
			"CustomerService.upgrade.pre0",
		];

		const result = await runCli(["generate"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// §9.3 artifact under the configured generatedDir.
		const coveragePath = join(cwd, ".versailles", "generated", "coverage.json");
		const raw = await readFile(coveragePath, "utf8");
		const coverage = JSON.parse(raw) as {
			coverage: Record<string, string[]>;
		};
		expect(typeof coverage.coverage).toBe("object");
		for (const clauseId of clauseIds) {
			expect(coverage.coverage[clauseId]).toBeDefined();
			expect(Array.isArray(coverage.coverage[clauseId])).toBe(true);
		}

		// The coverage artifact is machine-readable output, not a hidden file.
		const output = result.output as { files?: string[]; coverageFile?: string };
		const listedInFiles =
			output.files?.includes(".versailles/generated/coverage.json") ?? false;
		expect(
			listedInFiles ||
				output.coverageFile === ".versailles/generated/coverage.json",
		).toBe(true);
	});
});

// ── Predicate registry command routing (build-spec §13 milestone 8) ────────
// Red-phase pins for the milestone-8 commands (docs/contracts/
// predicate-registry.contract.yaml): register-predicate / verify-purity /
// remind-unverified must route to structured results — never UNKNOWN_COMMAND,
// never a throw (ADR-0010). TODAY all three are unknown commands, so every
// assertion below FAILS — the expected Red state. The full behavior of each
// command (single-entry read-modify-write, sourceHash verification,
// verifiedPure gate, purity reminder) is pinned in tests/predicate-registry.test.ts.

describe("runCli — predicate registry command routing (predicate-registry.contract.yaml, build-spec §13 milestone 8)", () => {
	it("routes register-predicate / verify-purity / remind-unverified to structured results — never UNKNOWN_COMMAND, never a throw", async () => {
		const cwd = await freshWorkspace("pr-route");
		// Ground the registration fixture source (covered by sourceRoots) so a
		// valid register-predicate invocation can succeed post-implementation.
		await writeSource(
			cwd,
			"Inventory.ts",
			`export function isAvailable(amount: number): boolean {
	return amount >= 0;
}
`,
		);
		const commands: string[][] = [
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
				"--params",
				"amount",
				"--paramTypes",
				"number",
			],
			["verify-purity", "isAvailable"],
			["remind-unverified"],
		];

		for (const argv of commands) {
			const result = await runCli(argv, { cwd });
			expect(typeof result.ok).toBe("boolean");
			expect(Array.isArray(result.errors)).toBe(true);
			expect(Array.isArray(result.warnings)).toBe(true);
			expect([0, 1, 2]).toContain(result.exitCode);
			expect(result.errors).not.toContainEqual(
				expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
			);
		}
	});
});
