import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Node } from "../packages/core/src/core/parser.js";

/**
 * validate --verbose (ADR-0012 Phase 2, VERSAILLES-152) — pins the new
 * verbose output that folds the deleted review command's parser-sanity view
 * (per-clause expr + AST pairs) into `versailles validate --verbose`.
 *
 * These tests FAIL against the current implementation:
 * - `validate` does not yet accept `--verbose` (the CLI boundary rejects it
 *   as a USAGE error because validate takes no arguments today).
 * - The validate handler does not yet emit per-clause expr/AST pairs.
 *
 * The Power Forward implements the GREEN phase to turn these red pins green.
 *
 * ── Pinned output shape ───────────────────────────────────────────────────
 *
 * `validate --verbose` preserves the existing CliResult envelope and extends
 * the `output` payload additively with a `verbose` namespace:
 *
 * ```ts
 * output: {
 *   valid: boolean,
 *   verbose: {
 *     exprViews: Array<{
 *       id: string;        // clause id, e.g. "OrderService.inv0"
 *       clause: string;    // clause kind: "invariants" | "preconditions" | "postconditions"
 *       expr: string;      // raw expression string from contracts.json
 *       ast: Node | null;  // parsed AST (src/core/parser.ts Node) or null on parse failure
 *     }>
 *   }
 * }
 * ```
 *
 * Without `--verbose`, output remains `{ valid: boolean }` — no verbose key.
 *
 * ── Fixture strategy ──────────────────────────────────────────────────────
 *
 * Reuses the seedGeneratorWorkspace / freshWorkspace / writeWorkspaceFile
 * helpers from tests/cli.test.ts conventions. Each test writes its own
 * .versailles/ workspace into a fresh per-test mkdtemp subdir so fixtures
 * do not depend on the CLI under test.
 */

// ── Fixture helpers (mirror tests/cli.test.ts conventions) ─────────────────

const SEEDED_CONFIG = {
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeWorkspaceFile(
	cwd: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	await writeJsonFile(join(cwd, ".versailles", fileName), value);
}

async function freshWorkspace(name: string): Promise<string> {
	const { mkdir } = await import("node:fs/promises");
	const cwd = join(tempRoot, name);
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeWorkspaceFile(cwd, "config.json", SEEDED_CONFIG);
	await writeWorkspaceFile(cwd, "contracts.json", {
		contracts: {},
	});
	await writeWorkspaceFile(cwd, "manifests.json", {
		manifests: {},
	});
	return cwd;
}

/**
 * OrderService-like fixture (from examples/order-service/.versailles/contracts.json):
 * - 1 invariant: balance >= 0
 * - addItem op with pre0 (sku != ""), pre1 (isPositive(price)),
 *   post0 (balance == old(balance) + price)
 * Total: 4 clauses — a natural fixture for asserting every clause kind.
 */
function orderServiceContracts(): unknown {
	return {
		contracts: {
			OrderService: {
				invariants: [{ id: "OrderService.inv0", expr: "balance >= 0" }],
				operations: {
					addItem: {
						id: "OrderService.addItem",
						params: [
							{ name: "sku", type: "string" },
							{ name: "price", type: "number" },
						],
						preconditions: [
							{ id: "OrderService.addItem.pre0", expr: 'sku != ""' },
							{
								id: "OrderService.addItem.pre1",
								expr: "isPositive(price)",
							},
						],
						postconditions: [
							{
								id: "OrderService.addItem.post0",
								expr: "balance == old(balance) + price",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "e6d9d945",
					},
				},
			},
		},
	};
}

function orderServiceManifests(): unknown {
	return {
		manifests: {
			OrderService: {
				sourceHash: "man-order",
				fields: { balance: "number", sku: "string" },
			},
		},
	};
}

/**
 * ADR-0013 (Phase 3): predicates are now declared inline in contracts.json's
 * top-level `predicates` map. Returns the predicates map (not a file envelope).
 */
function orderServicePredicates(): Record<string, unknown> {
	return {
		isPositive: {
			source: "Math.isPositive",
			params: ["value"],
			paramTypes: ["number"],
			returnType: "boolean",
			verifiedPure: true,
		},
	};
}

async function seedOrderServiceWorkspace(name: string): Promise<string> {
	const cwd = await freshWorkspace(name);
	// ADR-0013 (Phase 3): merge predicates into contracts.json.
	const contracts = orderServiceContracts() as Record<string, unknown>;
	contracts.predicates = orderServicePredicates();
	await writeWorkspaceFile(cwd, "contracts.json", contracts);
	await writeWorkspaceFile(cwd, "manifests.json", orderServiceManifests());
	return cwd;
}

/**
 * VERSAILLES-168 Phase 5 (VERSAILLES-173): generic seeder for the
 * predicateReferences fixtures — writes a contracts.json envelope carrying
 * the given predicates map plus a manifests file.
 */
async function seedWorkspaceWith(
	name: string,
	contracts: unknown,
	predicates: Record<string, unknown>,
	manifests: unknown = orderServiceManifests(),
): Promise<string> {
	const cwd = await freshWorkspace(name);
	const envelope = contracts as Record<string, unknown>;
	envelope.predicates = predicates;
	await writeWorkspaceFile(cwd, "contracts.json", envelope);
	await writeWorkspaceFile(cwd, "manifests.json", manifests);
	return cwd;
}

/**
 * Multi-clause fixture: TWO clauses reference the same predicate.
 * - OrderService.addItem.pre1: isPositive(price)   (price is a number param)
 * - OrderService.addItem.post0: isPositive(balance) (balance is a number field)
 * Both parse; the semantic validator resolves price (param) and balance
 * (manifest field) as number, so the workspace stays valid (exit 0).
 */
function orderServiceMultiClauseContracts(): unknown {
	return {
		contracts: {
			OrderService: {
				invariants: [{ id: "OrderService.inv0", expr: "balance >= 0" }],
				operations: {
					addItem: {
						id: "OrderService.addItem",
						params: [
							{ name: "sku", type: "string" },
							{ name: "price", type: "number" },
						],
						preconditions: [
							{ id: "OrderService.addItem.pre0", expr: 'sku != ""' },
							{
								id: "OrderService.addItem.pre1",
								expr: "isPositive(price)",
							},
						],
						postconditions: [
							{
								id: "OrderService.addItem.post0",
								expr: "isPositive(balance)",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "e6d9d945",
					},
				},
			},
		},
	};
}

/**
 * Multi-predicate fixture: TWO declared predicates, one used once and one
 * used twice.
 * - isAvailable(sku) used once (pre0, sku is a string param)
 * - isPositive(price) pre1 + isPositive(balance) post0 → used twice
 */
function orderServiceMultiPredicateContracts(): unknown {
	return {
		contracts: {
			OrderService: {
				invariants: [{ id: "OrderService.inv0", expr: "balance >= 0" }],
				operations: {
					addItem: {
						id: "OrderService.addItem",
						params: [
							{ name: "sku", type: "string" },
							{ name: "price", type: "number" },
						],
						preconditions: [
							{
								id: "OrderService.addItem.pre0",
								expr: "isAvailable(sku)",
							},
							{
								id: "OrderService.addItem.pre1",
								expr: "isPositive(price)",
							},
						],
						postconditions: [
							{
								id: "OrderService.addItem.post0",
								expr: "isPositive(balance)",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "e6d9d945",
					},
				},
			},
		},
	};
}

function orderServiceMultiPredicateDeclarations(): Record<string, unknown> {
	return {
		isAvailable: {
			source: "Math.isAvailable",
			params: ["value"],
			paramTypes: ["string"],
			returnType: "boolean",
			verifiedPure: true,
		},
		isPositive: {
			source: "Math.isPositive",
			params: ["value"],
			paramTypes: ["number"],
			returnType: "boolean",
			verifiedPure: true,
		},
	};
}

/**
 * Zero-reference fixture: predicates map declares isEven (never referenced)
 * alongside isPositive (referenced once by OrderService.addItem.pre1).
 */
function orderServicePredicatesWithUnused(): Record<string, unknown> {
	return {
		isEven: {
			source: "Math.isEven",
			params: ["value"],
			paramTypes: ["number"],
			returnType: "boolean",
			verifiedPure: true,
		},
		isPositive: {
			source: "Math.isPositive",
			params: ["value"],
			paramTypes: ["number"],
			returnType: "boolean",
			verifiedPure: true,
		},
	};
}

// ── Module import ──────────────────────────────────────────────────────────

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

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-vv-"));
	({ runCli } = await import("../packages/cli/src/cli/index.js"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── Test cases ─────────────────────────────────────────────────────────────

describe("runCli validate --verbose — per-clause expr+AST pairs (ADR-0012 Phase 2, VERSAILLES-152)", () => {
	it("emits exprViews for EVERY clause of a valid workspace: all 4 OrderService clauses with correct expr strings and non-null ast", async () => {
		const cwd = await seedOrderServiceWorkspace("vv-valid");
		const result = await runCli(["validate", "--verbose"], { cwd });

		// Still a valid workspace — ok true, exit 0.
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		// Output carries the existing `valid` field AND the new `verbose` namespace.
		const output = result.output as {
			valid: boolean;
			verbose?: { exprViews?: unknown[] };
		};
		expect(output.valid).toBe(true);
		expect(output.verbose).toBeDefined();
		expect(Array.isArray(output.verbose?.exprViews)).toBe(true);

		const views = output.verbose?.exprViews as Array<{
			id: string;
			clause: string;
			expr: string;
			ast: Node | null;
		}>;

		// All 4 clauses present: 1 invariant + 2 preconditions + 1 postcondition.
		expect(views).toHaveLength(4);

		// Each view carries the expected shape and a non-null ast (valid parse).
		for (const view of views) {
			expect(typeof view.id).toBe("string");
			expect(["invariants", "preconditions", "postconditions"]).toContain(
				view.clause,
			);
			expect(typeof view.expr).toBe("string");
			expect(view.ast).not.toBeNull();
		}

		// Pin the exact clause ids and expr strings (deterministic, ADR-0002).
		const byId = Object.fromEntries(views.map((v) => [v.id, v]));
		expect(byId["OrderService.inv0"]).toMatchObject({
			clause: "invariants",
			expr: "balance >= 0",
		});
		expect(byId["OrderService.addItem.pre0"]).toMatchObject({
			clause: "preconditions",
			expr: 'sku != ""',
		});
		expect(byId["OrderService.addItem.pre1"]).toMatchObject({
			clause: "preconditions",
			expr: "isPositive(price)",
		});
		expect(byId["OrderService.addItem.post0"]).toMatchObject({
			clause: "postconditions",
			expr: "balance == old(balance) + price",
		});

		// AST shapes: pin a couple to confirm they are real parsed Nodes.
		expect(byId["OrderService.inv0"].ast).toMatchObject({
			type: "compare",
			op: ">=",
		});
		expect(byId["OrderService.addItem.post0"].ast).toMatchObject({
			type: "compare",
			op: "==",
		});
	});

	it("with a parse-failing contract, reports the failing clause with ast: null alongside the parse errors (exit 1)", async () => {
		const cwd = await freshWorkspace("vv-parse-fail");
		// One valid invariant + one operation with a parse-failing postcondition
		// (single '=' is a parse error — the grammar requires '==').
		await writeWorkspaceFile(cwd, "contracts.json", {
			contracts: {
				OrderService: {
					invariants: [{ id: "OrderService.inv0", expr: "balance >= 0" }],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [{ name: "price", type: "number" }],
							preconditions: [],
							postconditions: [
								{ id: "OrderService.addItem.post0", expr: "balance = 100" },
							],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		await writeWorkspaceFile(cwd, "manifests.json", orderServiceManifests());

		const result = await runCli(["validate", "--verbose"], { cwd });

		// Parse error → exit 1, ok false.
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "PARSE_ERROR" }),
		);

		// Verbose data is still emitted — the failing clause appears with ast: null.
		const output = result.output as {
			valid: boolean;
			verbose?: { exprViews?: unknown[] };
		};
		expect(output.valid).toBe(false);
		expect(output.verbose).toBeDefined();
		const views = output.verbose?.exprViews as Array<{
			id: string;
			clause: string;
			expr: string;
			ast: Node | null;
		}>;

		// Both clauses appear: the valid invariant (non-null ast) and the
		// failing postcondition (ast: null).
		expect(views).toHaveLength(2);
		const byId = Object.fromEntries(views.map((v) => [v.id, v]));
		expect(byId["OrderService.inv0"].ast).not.toBeNull();
		expect(byId["OrderService.addItem.post0"].expr).toBe("balance = 100");
		expect(byId["OrderService.addItem.post0"].ast).toBeNull();
	});

	it("on a workspace with NO contracts (empty contracts map), validate --verbose returns ok with verbose.exprViews === [] (no crash)", async () => {
		// freshWorkspace seeds { contracts: {} } — no components,
		// no predicates, no clauses. The verbose builder must tolerate an empty
		// contracts map and emit an empty exprViews array (not crash, not null).
		const cwd = await freshWorkspace("vv-empty-contracts");
		const result = await runCli(["validate", "--verbose"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const output = result.output as {
			valid: boolean;
			verbose?: { exprViews?: unknown[] };
		};
		expect(output.valid).toBe(true);
		expect(output.verbose).toBeDefined();
		expect(Array.isArray(output.verbose?.exprViews)).toBe(true);
		expect(output.verbose?.exprViews).toEqual([]);
	});

	it("without --verbose, output is unchanged — no verbose key, just { valid: boolean }", async () => {
		const cwd = await seedOrderServiceWorkspace("vv-no-flag");
		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// Output shape is exactly the existing { valid: boolean } — no verbose.
		const output = result.output as Record<string, unknown>;
		expect(output).toEqual({ valid: true });
		expect(output.verbose).toBeUndefined();
	});
});

describe("runCli validate --verbose — predicateReferences reverse-reference index (VERSAILLES-168 Phase 5, VERSAILLES-173)", () => {
	// ── Pinned output shape ────────────────────────────────────────────────
	// output.verbose gains an additive predicateReferences array — one entry
	// per DECLARED predicate, mapping predicate name → clause usage:
	//
	//   predicateReferences: Array<{
	//     predicate: string;  // declared predicate name, e.g. "isPositive"
	//     source: string;     // the declaration's "source" field from contracts.json
	//     clauses: string[];  // sorted clause ids whose expr calls this predicate
	//     singleUse: boolean; // clauses.length === 1
	//   }>
	//
	// Pinned decisions (reported to the Point Guard):
	// - Entries are sorted by predicate name (alphabetical) — deterministic.
	// - clauses are sorted by clause id (alphabetical).
	// - singleUse is exactly clauses.length === 1.
	// - EVERY declared predicate gets an entry, INCLUDING declared-but-unused
	//   ones (clauses: [], singleUse: false) — authors must see unused
	//   predicates; that is the discoverability intent.
	// - References come from parsed ASTs only: a clause whose expr failed to
	//   parse contributes nothing (and never crashes).
	// - No declared predicates → predicateReferences: [].
	// - --verbose is the only trigger.

	type PredicateReference = {
		predicate: string;
		source: string;
		clauses: string[];
		singleUse: boolean;
	};

	function refsOf(result: { output?: unknown }): PredicateReference[] {
		const output = result.output as {
			verbose?: { predicateReferences?: unknown };
		};
		expect(output.verbose).toBeDefined();
		const refs = output.verbose?.predicateReferences as
			| PredicateReference[]
			| undefined;
		expect(Array.isArray(refs)).toBe(true);
		return refs as PredicateReference[];
	}

	it("single use: the OrderService fixture's declared isPositive maps to OrderService.addItem.pre1 (source from the declaration, singleUse: true)", async () => {
		const cwd = await seedOrderServiceWorkspace("vv-pr-single");
		const result = await runCli(["validate", "--verbose"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// Exact array — deterministic pin (not just shape). The fixture's
		// predicates map declares source "Math.isPositive".
		expect(refsOf(result)).toEqual([
			{
				predicate: "isPositive",
				source: "Math.isPositive",
				clauses: ["OrderService.addItem.pre1"],
				singleUse: true,
			},
		]);
	});

	it("multi-clause: one predicate referenced by TWO clauses → clauses sorted with both ids, singleUse: false", async () => {
		const cwd = await seedWorkspaceWith(
			"vv-pr-multi-clause",
			orderServiceMultiClauseContracts(),
			orderServicePredicates(),
		);
		const result = await runCli(["validate", "--verbose"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// Both pre1 (isPositive(price)) and post0 (isPositive(balance))
		// reference isPositive. Clause ids sort alphabetically:
		// "OrderService.addItem.post0" < "OrderService.addItem.pre1".
		expect(refsOf(result)).toEqual([
			{
				predicate: "isPositive",
				source: "Math.isPositive",
				clauses: ["OrderService.addItem.post0", "OrderService.addItem.pre1"],
				singleUse: false,
			},
		]);
	});

	it("multi-predicate: two declared predicates (one used twice, one once) → 2 entries sorted by predicate name", async () => {
		const cwd = await seedWorkspaceWith(
			"vv-pr-multi-pred",
			orderServiceMultiPredicateContracts(),
			orderServiceMultiPredicateDeclarations(),
		);
		const result = await runCli(["validate", "--verbose"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// Entries sorted alphabetically by predicate: isAvailable < isPositive.
		expect(refsOf(result)).toEqual([
			{
				predicate: "isAvailable",
				source: "Math.isAvailable",
				clauses: ["OrderService.addItem.pre0"],
				singleUse: true,
			},
			{
				predicate: "isPositive",
				source: "Math.isPositive",
				clauses: ["OrderService.addItem.post0", "OrderService.addItem.pre1"],
				singleUse: false,
			},
		]);
	});

	it("declared-but-unused predicate gets an entry with clauses: [] and singleUse: false (zero-reference decision)", async () => {
		const cwd = await seedWorkspaceWith(
			"vv-pr-unused",
			orderServiceContracts(),
			orderServicePredicatesWithUnused(),
		);
		const result = await runCli(["validate", "--verbose"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// isEven is declared but never referenced — it still appears, pinned
		// with an empty clauses array and singleUse: false, so authors can
		// discover unused predicate declarations. Entries stay alphabetical:
		// isEven < isPositive.
		expect(refsOf(result)).toEqual([
			{
				predicate: "isEven",
				source: "Math.isEven",
				clauses: [],
				singleUse: false,
			},
			{
				predicate: "isPositive",
				source: "Math.isPositive",
				clauses: ["OrderService.addItem.pre1"],
				singleUse: true,
			},
		]);
	});

	it("no declared predicates → predicateReferences: []", async () => {
		// freshWorkspace seeds contracts.json with { contracts: {} } — no
		// predicates map, no components. The builder must tolerate that and
		// emit an empty array (not crash, not null, not undefined).
		const cwd = await freshWorkspace("vv-pr-no-preds");
		const result = await runCli(["validate", "--verbose"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(refsOf(result)).toEqual([]);
	});

	it("a clause that fails to parse does not contribute a reference (and does not crash)", async () => {
		const cwd = await seedWorkspaceWith(
			"vv-pr-parse-fail",
			{
				contracts: {
					OrderService: {
						invariants: [],
						operations: {
							addItem: {
								id: "OrderService.addItem",
								params: [{ name: "price", type: "number" }],
								preconditions: [
									{
										id: "OrderService.addItem.pre0",
										expr: "isPositive(price)",
									},
									// Unclosed '(' — a parse error. No AST is
									// produced, so this clause must NOT appear
									// in isPositive's clauses list.
									{
										id: "OrderService.addItem.pre1",
										expr: "isPositive(price",
									},
								],
								postconditions: [],
								effects: [],
								sourceHash: "abc123",
							},
						},
					},
				},
			},
			orderServicePredicates(),
		);
		const result = await runCli(["validate", "--verbose"], { cwd });

		// Parse error → exit 1, ok false.
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "PARSE_ERROR" }),
		);

		// Verbose data is still emitted. pre0 parsed and contributes the
		// reference; pre1 failed to parse so it is absent from clauses — the
		// reference list survives the parse failure without crashing.
		expect(refsOf(result)).toEqual([
			{
				predicate: "isPositive",
				source: "Math.isPositive",
				clauses: ["OrderService.addItem.pre0"],
				singleUse: true,
			},
		]);
	});

	it("without --verbose, no predicateReferences key anywhere — output stays { valid: boolean }", async () => {
		const cwd = await seedOrderServiceWorkspace("vv-pr-no-flag");
		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		// Exactly the legacy { valid: true } payload: no verbose namespace,
		// so no predicateReferences key at any level.
		const output = result.output as Record<string, unknown>;
		expect(output).toEqual({ valid: true });
		expect(output.verbose).toBeUndefined();
	});
});

describe("runCli — unexpected flags on commands that do not support them (build-spec §12)", () => {
	it("check --verbose is rejected as a USAGE error, exit 1 — check does not support --verbose", async () => {
		const cwd = await freshWorkspace("vv-check-verbose");
		const result = await runCli(["check", "--verbose"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});
});
