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
