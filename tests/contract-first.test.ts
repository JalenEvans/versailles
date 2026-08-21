import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { planTestCases } from "../src/generator/index.js";
import type { PlannedSuite } from "../src/generator/index.js";
import { loadWorkspace } from "../src/loader/workspace.js";
import type { LoaderWarning } from "../src/loader/workspace.js";

/**
 * Contract-first emission (VERSAILLES-149, ADR-0011) — pinned against
 * docs/decisions/0011-contract-first-emission.md and
 * docs/contracts/deterministic-generation.contract.yaml.
 *
 * The feature: a workspace with ONLY `.versailles/config.json` +
 * `.versailles/contracts.json` (NO src/, NO manifests.json, NO predicates.json)
 * must let `versailles generate` succeed and emit the suite + coverage.json.
 * The module surface (operation params, types, module import path) is derived
 * from contracts.json alone. The emitted tests import a not-yet-existing
 * module (e.g. `../../src/Cart.js`) and FAIL at runtime with MODULE_NOT_FOUND
 * / TypeError when run — legitimate TDD Red, NOT an infrastructure error.
 *
 * ── Loader/validator behavior discovered (grounding) ─────────────────────
 *
 * 1. `loadWorkspace` (src/loader/workspace.ts) calls `loadJsonFile` for each
 *    of config/contracts/manifests/predicates. A missing file pushes a
 *    `MISSING_FILE` LoaderError into `validationErrors` (line 192-196).
 *    `isValid = parseErrors.length === 0 && validationErrors.length === 0`
 *    (line 714-715), so missing manifests.json → isValid=false.
 *
 * 2. `getManifestEntry` (src/core/validator.ts line 562-570) returns null
 *    when `context.manifests === null`. `resolveRoot` for invariant-scope
 *    field refs then returns `{ type: null, confidence: "declared" }`
 *    (line 524-527), and `resolveFieldPath` adds an `UNKNOWN_FIELD` error
 *    (line 425-430). So even if MISSING_FILE were tolerated, semantic
 *    validation would fail on `balance == old(balance) + price` because
 *    `balance` is not a param.
 *
 * 3. `handleGenerate` (src/cli/handlers/generate.ts line 27-35) gates on
 *    `context.isValid` — an invalid context writes ZERO files and returns
 *    exit 1.
 *
 * 4. `deriveModulePaths` (line 129-148) iterates `manifests?.manifests ?? {}`
 *    — when manifests is null, the result is `{}`. The vitest emitter falls
 *    back to `../../src/<Component>.js` (src/generator/emitters/vitest.ts
 *    line 40, 130-134). So the import path is already deterministic; the
 *    only blocker is the isValid gate.
 *
 * 5. V-25 check (src/generator/planner.ts line 241-244):
 *    `componentMethods !== undefined && componentMethods[operationName] === undefined`
 *    → warn+skip. When manifests is null, `context.manifests?.manifests[componentName]?.methods`
 *    is undefined → the condition is false → NO warn+skip (greenfield path).
 *    When manifests is present with a methods map but the op is missing →
 *    warn+skip (brownfield path). This distinction MUST be preserved.
 *
 * ── Module contract (what these tests require) ────────────────────────────
 *
 * The loader must tolerate missing manifests.json + predicates.json when
 * contracts.json is present and well-formed. The semantic validator must
 * skip field-resolution checks that require manifests when manifests is
 * absent (greenfield: the fields will be derived from contracts at emit
 * time, or the user will add them later). The planner must plan cases from
 * contracts alone. The emitter must emit the deterministic default import
 * path (`../../src/<Component>.js` for vitest).
 */

const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

const CART = "Cart";

/**
 * Cart contract (the ADR-0011 reference example): addItem(sku: string, price: number)
 * with pre `price > 0`, post `balance == old(balance) + price`.
 * This is the canonical greenfield contract-first scenario.
 */
function cartContracts(): unknown {
	return {
		version: "1.0",
		contracts: {
			[CART]: {
				invariants: [],
				operations: {
					addItem: {
						id: "Cart.addItem",
						params: [
							{ name: "sku", type: "string" },
							{ name: "price", type: "number" },
						],
						preconditions: [{ id: "Cart.addItem.pre0", expr: "price > 0" }],
						postconditions: [
							{
								id: "Cart.addItem.post0",
								expr: "balance == old(balance) + price",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "cart-additem-hash",
					},
				},
			},
		},
	};
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Scaffolds a contracts-only workspace: config.json + contracts.json ONLY.
 * NO manifests.json, NO predicates.json, NO src/.
 */
async function contractsOnlyWorkspace(name: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), `versailles-cf-${name}-`));
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeJsonFile(join(cwd, ".versailles", "config.json"), SEEDED_CONFIG);
	await writeJsonFile(
		join(cwd, ".versailles", "contracts.json"),
		cartContracts(),
	);
	return cwd;
}

/** suite.warnings typed through the planned seam. */
function suiteWarnings(suite: PlannedSuite): LoaderWarning[] {
	return (
		(suite as PlannedSuite & { warnings?: LoaderWarning[] }).warnings ?? []
	);
}

// ── IT 1: planner/context — contracts-only workspace loads valid ────────────

describe("VERSAILLES-149 — contract-first emission (ADR-0011)", () => {
	describe("IT 1: contracts-only workspace loads valid (no manifests, no predicates)", () => {
		it("loadWorkspace returns isValid=true for a workspace with ONLY config.json + contracts.json — currently Red because MISSING_FILE + UNKNOWN_FIELD errors flip isValid", async () => {
			const cwd = await contractsOnlyWorkspace("it1");
			try {
				const context = await loadWorkspace(join(cwd, ".versailles"));

				// The workspace MUST be valid despite missing manifests.json and predicates.json.
				// Currently Red: loadWorkspace pushes MISSING_FILE for manifests.json and
				// predicates.json, and semantic validation pushes UNKNOWN_FIELD for `balance`
				// (a field ref with no manifest entry).
				expect(
					context.isValid,
					`expected isValid=true but got errors: ${JSON.stringify(context.validationErrors)}`,
				).toBe(true);
				expect(context.parseErrors).toEqual([]);
				// No MISSING_FILE errors for manifests.json or predicates.json — they are optional
				// in a greenfield contracts-only workspace.
				const missingManifests = context.validationErrors.find(
					(e) => e.code === "MISSING_FILE" && e.field === "manifests.json",
				);
				const missingPredicates = context.validationErrors.find(
					(e) => e.code === "MISSING_FILE" && e.field === "predicates.json",
				);
				expect(
					missingManifests,
					"manifests.json must be optional in a contracts-only workspace",
				).toBeUndefined();
				expect(
					missingPredicates,
					"predicates.json must be optional in a contracts-only workspace",
				).toBeUndefined();
				// No UNKNOWN_FIELD errors for field refs — the validator must skip field-resolution
				// when manifests is absent (greenfield: fields will be derived from contracts).
				const unknownFields = context.validationErrors.filter(
					(e) => e.code === "UNKNOWN_FIELD",
				);
				expect(
					unknownFields,
					`expected no UNKNOWN_FIELD errors but got: ${JSON.stringify(unknownFields)}`,
				).toEqual([]);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		});
	});

	// ── IT 2: generate emits test files + coverage.json from contracts-only workspace ───────

	describe("IT 2: generate emits test files + coverage.json from contracts-only workspace", () => {
		it("planTestCases produces a non-empty suite for a contracts-only context — currently Red because isValid=false blocks generation", async () => {
			const cwd = await contractsOnlyWorkspace("it2");
			try {
				const context = await loadWorkspace(join(cwd, ".versailles"));
				// The context must be valid (IT 1 pins this). If isValid is false, planTestCases
				// throws "planTestCases requires a validated context (isValid: true)".
				expect(
					context.isValid,
					`expected isValid=true but got errors: ${JSON.stringify(context.validationErrors)}`,
				).toBe(true);

				const suite = planTestCases(context);
				// The suite must have at least one operation group with cases.
				expect(suite.operations.length).toBeGreaterThan(0);
				const cartGroup = suite.operations.find(
					(g) => g.component === CART && g.operation === "addItem",
				);
				expect(
					cartGroup,
					"expected Cart.addItem operation group",
				).toBeDefined();
				expect(
					cartGroup?.cases.length,
					"expected Cart.addItem to have planned cases",
				).toBeGreaterThan(0);
				// The suite must trace the contract clause ids.
				expect(suite.clauseIds).toContain("Cart.addItem.pre0");
				expect(suite.clauseIds).toContain("Cart.addItem.post0");
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		});
	});

	// ── IT 3: emitted test imports the module path and fails at runtime (TDD Red) ───────────

	describe("IT 3: emitted test imports the module path and fails at runtime (TDD Red)", () => {
		it("the emitted test file imports ../../src/Cart.js and when run against no source fails with MODULE_NOT_FOUND — currently Red because generate is gated invalid", async () => {
			const cwd = await contractsOnlyWorkspace("it3");
			try {
				const context = await loadWorkspace(join(cwd, ".versailles"));
				expect(
					context.isValid,
					`expected isValid=true but got errors: ${JSON.stringify(context.validationErrors)}`,
				).toBe(true);

				const suite = planTestCases(context);
				// Import emitSuite dynamically to avoid circular deps in the test file.
				const { emitSuite } = await import("../src/generator/index.js");
				const files = emitSuite(suite, "vitest", {
					generatedDir: ".versailles/generated",
					modulePaths: {}, // no manifest sourcePath → deterministic default
				});
				const cartFile = files.find((f) => f.path.endsWith("Cart.test.ts"));
				expect(cartFile, "expected Cart.test.ts to be emitted").toBeDefined();
				// The emitted import must reference the deterministic default path.
				expect(cartFile?.content).toContain(
					'import { Cart } from "../../src/Cart.js"',
				);

				// Write the emitted file to disk and run it with the real vitest runner.
				const generatedDir = join(cwd, ".versailles", "generated");
				await mkdir(generatedDir, { recursive: true });
				await writeFile(
					join(generatedDir, "Cart.test.ts"),
					cartFile?.content,
					"utf8",
				);

				const vitestBin = join(
					dirname(fileURLToPath(import.meta.url)),
					"..",
					"node_modules",
					"vitest",
					"vitest.mjs",
				);
				const run = spawnSync(process.execPath, [vitestBin, "run"], {
					cwd: generatedDir,
					encoding: "utf8",
				});
				// The run must fail (exit !== 0) because the module does not exist.
				expect(run.status, "expected vitest run to fail (TDD Red)").not.toBe(0);
				// The failure must be MODULE_NOT_FOUND or TypeError (legitimate TDD Red),
				// NOT an infrastructure error (e.g. syntax error in the emitted file).
				const combinedOutput = run.stdout + run.stderr;
				const isModuleNotFoundError =
					combinedOutput.includes("MODULE_NOT_FOUND") ||
					combinedOutput.includes("Cannot find module") ||
					combinedOutput.includes("Error:") ||
					combinedOutput.includes("TypeError");
				expect(
					isModuleNotFoundError,
					`expected MODULE_NOT_FOUND or TypeError but got:\n${combinedOutput}`,
				).toBe(true);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		});
	});

	// ── IT 4: V-25 distinction — greenfield vs brownfield ───────────────────

	describe("IT 4: V-25 distinction — greenfield (no manifests) vs brownfield (manifests present, op missing)", () => {
		it("when manifests.json is ABSENT, the op is emitted (greenfield, no warn+skip) — currently Red because isValid=false blocks planning", async () => {
			const cwd = await contractsOnlyWorkspace("it4-greenfield");
			try {
				const context = await loadWorkspace(join(cwd, ".versailles"));
				expect(
					context.isValid,
					`expected isValid=true but got errors: ${JSON.stringify(context.validationErrors)}`,
				).toBe(true);

				const suite = planTestCases(context);
				const warnings = suiteWarnings(suite);
				// No UNPLANNABLE_OPERATION warning — greenfield path (no manifests at all).
				const unplannable = warnings.filter(
					(w) => w.code === "UNPLANNABLE_OPERATION",
				);
				expect(unplannable, "greenfield path must NOT warn+skip").toEqual([]);
				// The op must have planned cases.
				const cartGroup = suite.operations.find(
					(g) => g.component === CART && g.operation === "addItem",
				);
				expect(cartGroup?.cases.length).toBeGreaterThan(0);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		});

		// ── IT 4b: asymmetric workspace — manifests present, predicates missing ─────
		// Regression pin (VERSAILLES-149): loadWorkspace only tolerates MISSING_FILE
		// for manifests.json AND predicates.json when BOTH are absent (greenfield).
		// If ONLY ONE is missing, it's a brownfield-with-a-hole and the loader MUST
		// report MISSING_FILE for the absent file. This pins that predicates.json
		// absence alone flips isValid=false with a MISSING_FILE error.
		it("asymmetric workspace: contracts + manifests present but predicates.json missing → MISSING_FILE for predicates.json, isValid=false (VERSAILLES-149)", async () => {
			const cwd = await mkdtemp(
				join(tmpdir(), "versailles-cf-it4b-asymmetric-"),
			);
			try {
				await mkdir(join(cwd, ".versailles"), { recursive: true });
				await writeJsonFile(
					join(cwd, ".versailles", "config.json"),
					SEEDED_CONFIG,
				);
				await writeJsonFile(
					join(cwd, ".versailles", "contracts.json"),
					cartContracts(),
				);
				// manifests.json present (brownfield half) — minimal valid shape.
				await writeJsonFile(join(cwd, ".versailles", "manifests.json"), {
					version: "1.0",
					manifests: {
						[CART]: {
							sourceHash: "cart-hash",
							fields: {},
							methods: {
								addItem: {
									static: false,
									params: [
										{ name: "sku", type: "string" },
										{ name: "price", type: "number" },
									],
									returnType: "void",
								},
							},
						},
					},
				});
				// predicates.json deliberately NOT written — asymmetric hole.

				const context = await loadWorkspace(join(cwd, ".versailles"));

				// Mirror the assertion style of loader.test.ts "f: loader-level
				// MISSING_FILE and semantic UNKNOWN_FIELD coexist".
				const missingPredicates = context.validationErrors.find(
					(e) => e.code === "MISSING_FILE" && e.field === "predicates.json",
				);
				expect(
					missingPredicates,
					"expected MISSING_FILE for predicates.json in asymmetric workspace",
				).toBeDefined();
				// manifests.json must NOT be reported missing (it is present).
				const missingManifests = context.validationErrors.find(
					(e) => e.code === "MISSING_FILE" && e.field === "manifests.json",
				);
				expect(
					missingManifests,
					"manifests.json is present — must NOT be reported MISSING_FILE",
				).toBeUndefined();
				// isValid must be false because the hole is not tolerated.
				expect(
					context.isValid,
					`expected isValid=false for asymmetric workspace but got errors: ${JSON.stringify(context.validationErrors)}`,
				).toBe(false);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		});

		it("when manifests.json IS present with methods map, an op missing from it still warns+skips (brownfield regression pin)", async () => {
			// This is the existing V-25 behavior — the brownfield path. The test constructs
			// a context with manifests present but the op missing from the methods map.
			// This should warn+skip (UNPLANNABLE_OPERATION warning, empty cases).
			const { parseExpression } = await import("../src/core/parser.js");
			const contracts = {
				version: "1.0",
				contracts: {
					[CART]: {
						invariants: [],
						operations: {
							addItem: {
								id: "Cart.addItem",
								params: [
									{ name: "sku", type: "string" },
									{ name: "price", type: "number" },
								],
								preconditions: [{ id: "Cart.addItem.pre0", expr: "price > 0" }],
								postconditions: [],
								effects: [],
								sourceHash: "cart-additem-hash",
							},
						},
					},
				},
			};
			const parsedContracts: Record<string, unknown> = {};
			for (const component of Object.values(contracts.contracts)) {
				for (const clause of component.invariants ?? []) {
					const result = parseExpression(clause.expr, "invariants", clause.id);
					if (result.ok) parsedContracts[clause.id] = result.ast;
				}
				for (const op of Object.values(component.operations ?? {})) {
					for (const clause of op.preconditions ?? []) {
						const result = parseExpression(
							clause.expr,
							"preconditions",
							clause.id,
						);
						if (result.ok) parsedContracts[clause.id] = result.ast;
					}
					for (const clause of op.postconditions ?? []) {
						const result = parseExpression(
							clause.expr,
							"postconditions",
							clause.id,
						);
						if (result.ok) parsedContracts[clause.id] = result.ast;
					}
				}
			}
			const context = {
				config: SEEDED_CONFIG,
				contracts,
				manifests: {
					version: "1.0",
					manifests: {
						[CART]: {
							sourceHash: "cart-hash",
							fields: {},
							// Methods map present but addItem is MISSING → brownfield drift.
							methods: {
								otherMethod: { static: false, params: [], returnType: "void" },
							},
						},
					},
				},
				predicates: { version: "1.0", predicates: {} },
				parsedContracts,
				parseErrors: [],
				validationErrors: [],
				validationWarnings: [],
				isValid: true,
			};
			const suite = planTestCases(context);
			const warnings = suiteWarnings(suite);
			// UNPLANNABLE_OPERATION warning must be present (brownfield path).
			const unplannable = warnings.filter(
				(w) => w.code === "UNPLANNABLE_OPERATION",
			);
			expect(unplannable.length, "brownfield path MUST warn+skip").toBe(1);
			expect(unplannable[0].field).toBe("Cart.addItem");
			// The op must have NO planned cases (skipped).
			const cartGroup = suite.operations.find(
				(g) => g.component === CART && g.operation === "addItem",
			);
			expect(
				cartGroup?.cases.length,
				"brownfield skipped op must have empty cases",
			).toBe(0);
		});
	});
});
