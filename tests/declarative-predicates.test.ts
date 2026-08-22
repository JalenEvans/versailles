import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Declarative predicates (Phase 3, VERSAILLES-153, ADR-0013) — predicates
 * move OUT of predicates.json and become a top-level `predicates` map in
 * contracts.json. The CLI trio (register-predicate, verify-purity,
 * remind-unverified) is REMOVED. predicates.json is retired.
 *
 * ── Module contract (what these tests require) ─────────────────────────────
 *
 * 1. Loader (src/loader/workspace.ts):
 *    - reads predicates from contracts.json (top-level `predicates` map)
 *    - does NOT read predicates.json (retired)
 *    - a workspace WITHOUT predicates.json validates clean
 *    - predicate entries carry: source, params, paramTypes, returnType,
 *      verifiedPure. sourceHash is DROPPED.
 *    - declaration name must be a valid IDENT
 *      (/^[A-Za-z_][A-Za-z0-9_]*$/, not a reserved keyword) — invalid names
 *      are a hard error (code: INVALID_PREDICATE_NAME).
 *    - resolve-or-warn: a declaration with `source` pointing at a
 *      nonexistent module/function → warning (code: PREDICATE_SOURCE_UNRESOLVED)
 *      surfaced in validationWarnings, exit 0, ok true (when the workspace is
 *      otherwise valid). This keeps greenfield TDD working.
 *
 * 2. Validator (src/core/validator.ts):
 *    - existing cross-check gate preserved: contract reference to a missing
 *      predicate → UNKNOWN_PREDICATE hard error.
 *    - contract reference to a predicate with verifiedPure !== true →
 *      UNVERIFIED_PREDICATE hard error.
 *    - arity (PREDICATE_ARITY) and arg-type (PREDICATE_ARG_TYPE) checks keep
 *      working from the declared params.
 *
 * 3. CLI (src/cli/index.ts):
 *    - register-predicate, verify-purity, remind-unverified → UNKNOWN_COMMAND,
 *      exit 1.
 *
 * ── RED PHASE ──────────────────────────────────────────────────────────────
 *
 * These tests FAIL against the current implementation:
 * - the loader reads predicates.json, not contracts.json's predicates map
 * - the CLI trio still routes to structured results (not UNKNOWN_COMMAND)
 * - the loader does not validate declaration names
 * - the loader does not attempt source resolution (no PREDICATE_SOURCE_UNRESOLVED)
 *
 * The Power Forward (GREEN) must implement the behaviors so these turn green.
 */

// The exact SEEDED_CONFIG written by initWorkspace (src/cli/init.ts).
const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

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
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-decl-pred-"));
	({ runCli } = await import("../src/cli/index.js"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

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
 * Scaffolds a fresh workspace WITHOUT predicates.json (the new shape:
 * predicates declared in contracts.json). The loader must NOT require
 * predicates.json to exist.
 */
async function freshWorkspaceNoPredicatesFile(
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
	// NOTE: NO predicates.json written — the new shape.
	return cwd;
}

// ── 1. Loader: predicates declared in contracts.json (no predicates.json) ──

describe("declarative predicates — loader reads predicates from contracts.json (no predicates.json)", () => {
	it("a workspace with predicates declared in contracts.json (and no predicates.json) loads them into the context — validate returns ok with no predicate errors", async () => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-loader-happy");
		// Predicates declared in contracts.json (top-level `predicates` map).
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			predicates: {
				isPositive: {
					source: "OrderService.isPositive",
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: true,
				},
			},
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [{ name: "price", type: "number" }],
							preconditions: [
								{ id: "OrderService.addItem.pre0", expr: "isPositive(price)" },
							],
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
				OrderService: {
					sourceHash: "man-os",
					fields: { balance: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		// The loader must source predicates from contracts.json, not
		// predicates.json. The contract's predicate call must resolve.
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.errors).not.toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_PREDICATE" }),
		);
	});
});

// ── 2. Validator gate preserved: verifiedPure: false → UNVERIFIED_PREDICATE ─

describe("declarative predicates — validator gate preserved (verifiedPure: false → UNVERIFIED_PREDICATE)", () => {
	it("contract referencing a predicate with verifiedPure: false (declared in contracts.json) → UNVERIFIED_PREDICATE hard error, exit 1", async () => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-unverified");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			predicates: {
				isPositive: {
					source: "OrderService.isPositive",
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: false, // NOT verified
				},
			},
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [{ name: "price", type: "number" }],
							preconditions: [
								{ id: "OrderService.addItem.pre0", expr: "isPositive(price)" },
							],
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
				OrderService: {
					sourceHash: "man-os",
					fields: { balance: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNVERIFIED_PREDICATE" }),
		);
	});
});

// ── 3. Missing predicate → UNKNOWN_PREDICATE ───────────────────────────────

describe("declarative predicates — missing predicate → UNKNOWN_PREDICATE", () => {
	it("contract referencing a predicate not declared at all → UNKNOWN_PREDICATE hard error, exit 1", async () => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-missing");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			predicates: {
				// isPositive is NOT declared — only isNegative is.
				isNegative: {
					source: "OrderService.isNegative",
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: true,
				},
			},
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [{ name: "price", type: "number" }],
							preconditions: [
								{ id: "OrderService.addItem.pre0", expr: "isPositive(price)" },
							],
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
				OrderService: {
					sourceHash: "man-os",
					fields: { balance: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_PREDICATE" }),
		);
	});
});

// ── 4. Resolve-or-warn: source unresolvable → warning, exit 0 ──────────────

describe("declarative predicates — resolve-or-warn (source unresolvable → warning, exit 0)", () => {
	it("declaration with `source` pointing at a nonexistent module/function → warning surfaced (PREDICATE_SOURCE_UNRESOLVED), exit 0, ok true", async () => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-source-unresolved");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			predicates: {
				isPositive: {
					// This source does NOT exist under sourceRoots.
					source: "NonExistentModule.doesNotExist",
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: true,
				},
			},
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [{ name: "price", type: "number" }],
							preconditions: [
								{ id: "OrderService.addItem.pre0", expr: "isPositive(price)" },
							],
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
				OrderService: {
					sourceHash: "man-os",
					fields: { balance: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		// Resolve-or-warn: unresolvable source → warning (not hard error).
		// The workspace is otherwise valid → exit 0, ok true.
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ code: "PREDICATE_SOURCE_UNRESOLVED" }),
		);
	});
});

// ── 5. Invalid declaration name → INVALID_PREDICATE_NAME ───────────────────

describe("declarative predicates — invalid declaration name → INVALID_PREDICATE_NAME", () => {
	it.each([
		["bad-name", "hyphen is not an IDENT character"],
		["9lives", "leading digit is not an IDENT start"],
		["and", "reserved keyword cannot be a predicate name"],
	])(
		"predicates: { %s: {...} } → INVALID_PREDICATE_NAME hard error, exit 1 (%s)",
		async (name) => {
			const cwd = await freshWorkspaceNoPredicatesFile("dp-invalid-name");
			await writeWorkspaceFile(cwd, "contracts.json", {
				version: "1.0",
				predicates: {
					[name]: {
						source: "OrderService.someFn",
						params: ["amount"],
						paramTypes: ["number"],
						returnType: "boolean",
						verifiedPure: true,
					},
				},
				contracts: {},
			});
			await writeWorkspaceFile(cwd, "manifests.json", {
				version: "1.0",
				manifests: {},
			});

			const result = await runCli(["validate"], { cwd });

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.errors).toContainEqual(
				expect.objectContaining({ code: "INVALID_PREDICATE_NAME" }),
			);
		},
	);
});

// ── 6. CLI trio removed → UNKNOWN_COMMAND ──────────────────────────────────

describe("declarative predicates — CLI trio removed (register-predicate, verify-purity, remind-unverified → UNKNOWN_COMMAND)", () => {
	it.each([
		[
			"register-predicate",
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
			],
		],
		["verify-purity", ["verify-purity", "isAvailable"]],
		["remind-unverified", ["remind-unverified"]],
	])("%s → UNKNOWN_COMMAND, exit 1", async (_command, argv) => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-cli-removed");

		const result = await runCli(argv, { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "UNKNOWN_COMMAND" }),
		);
	});
});

// ── 7. Arity/type checks still work ────────────────────────────────────────

describe("declarative predicates — arity/type checks still work (PREDICATE_ARITY, PREDICATE_ARG_TYPE)", () => {
	it("a contract calling isPositive(price, extra) where the declaration declares params: ['amount'] (arity 1) → PREDICATE_ARITY", async () => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-arity");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			predicates: {
				isPositive: {
					source: "OrderService.isPositive",
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: true,
				},
			},
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [
								{ name: "price", type: "number" },
								{ name: "extra", type: "number" },
							],
							preconditions: [
								// Arity mismatch: isPositive expects 1 arg, got 2.
								{
									id: "OrderService.addItem.pre0",
									expr: "isPositive(price, extra)",
								},
							],
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
				OrderService: {
					sourceHash: "man-os",
					fields: { balance: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "PREDICATE_ARITY" }),
		);
	});

	it("a contract calling isPositive(name) where the declaration declares paramTypes: ['number'] → PREDICATE_ARG_TYPE", async () => {
		const cwd = await freshWorkspaceNoPredicatesFile("dp-arg-type");
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			predicates: {
				isPositive: {
					source: "OrderService.isPositive",
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: true,
				},
			},
			contracts: {
				OrderService: {
					invariants: [],
					operations: {
						addItem: {
							id: "OrderService.addItem",
							params: [{ name: "name", type: "string" }],
							preconditions: [
								// Type mismatch: isPositive expects number, got string.
								{ id: "OrderService.addItem.pre0", expr: "isPositive(name)" },
							],
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
				OrderService: {
					sourceHash: "man-os",
					fields: { balance: "number" },
				},
			},
		});

		const result = await runCli(["validate"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "PREDICATE_ARG_TYPE" }),
		);
	});
});
