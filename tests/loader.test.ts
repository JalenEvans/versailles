import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initWorkspace } from "../src/cli/init.js";
// The joint .versailles/ loader (Phase 3.1, chunk 3.1; semantic wiring in
// chunk 3.3). The loader runs the semantic validator (src/core/validator.ts)
// over every successfully-parsed clause and aggregates its errors/warnings
// into validationErrors/validationWarnings, which feed the aggregated isValid
// flag (build-spec §6.5) alongside parse, version, and config errors.
import { extractScoped, loadWorkspace } from "../src/loader/workspace.js";

/**
 * Loader/context — pinned against build-spec §6, §2, §3.1 and the
 * workspace-context contract (docs/contracts/workspace-context.contract.yaml).
 *
 * The loader is the single shared path into the .versailles/ workspace: it
 * reads and JSON-parses the four jointly-loaded files (config.json,
 * contracts.json, manifests.json, predicates.json), applies the version gates
 * (build-spec §3.1) BEFORE any other processing, parses every expr string in
 * contracts.json into an AST via parseExpression (src/core/parser.ts),
 * validates config.json against config.schema.json (ADR-0009 matrix), and
 * returns ONE VersaillesContext with an aggregated isValid flag (build-spec
 * §6.5). After parsing, the loader runs the semantic validator over every
 * successfully-parsed clause and aggregates its errors/warnings into
 * validationErrors/validationWarnings (build-spec §6.5); loader-level results
 * (config schema errors under code CONFIG_INVALID, plus version, missing-file,
 * and invalid-json errors) are recorded into the same arrays.
 *
 * ── Module contract ────────────────────────────────────────────────────────
 *
 * Module: src/loader/workspace.ts
 * Exports: loadWorkspace, extractScoped, SUPPORTED_GRAMMAR_VERSION,
 *          SUPPORTED_SCHEMA_VERSION (+ the types below)
 *
 * ```ts
 * export const SUPPORTED_GRAMMAR_VERSION = "1.0";
 * export const SUPPORTED_SCHEMA_VERSION = "1.0";
 *
 * export type WorkspaceConfig = {
 *   grammarVersion: string;
 *   schemaVersion: string;
 *   sourceRoots: string[];
 *   language: "typescript" | "csharp" | "python";
 *   testFramework: "vitest" | "xunit" | "pytest";
 *   generatedDir: string;
 *   staleness: { blockOnStale: boolean };
 *   rejection?: { idiom: "throws" | "returns" };
 * };
 *
 * export type ContractClause = { id: string; expr: string };
 *
 * export type ContractOperation = {
 *   id: string;
 *   params: { name: string; type: string }[];
 *   preconditions: ContractClause[];
 *   postconditions: ContractClause[];
 *   effects: { field: string; kind: "mutate" | "create" | "delete" }[];
 *   sourceHash: string;
 * };
 *
 * export type ComponentContract = {
 *   invariants: ContractClause[];
 *   operations: Record<string, ContractOperation>;
 * };
 *
 * export type ContractsFile = {
 *   version: string;
 *   contracts: Record<string, ComponentContract>;
 * };
 *
 * export type ManifestsFile = {
 *   version: string;
 *   manifests: Record<string, { sourceHash: string; fields: Record<string, string> }>;
 * };
 *
 * export type PredicatesFile = {
 *   version: string;
 *   predicates: Record<string, {
 *     params: string[];
 *     paramTypes: string[];
 *     returnType: string;
 *     sourceRef: string;
 *     sourceHash: string;
 *     verifiedPure: boolean;
 *   }>;
 * };
 *
 * export type LoaderErrorCode =
 *   | "VERSION_MISMATCH" // config.grammarVersion / config.schemaVersion out of date
 *   | "MISSING_FILE"     // one of the four jointly-loaded files absent
 *   | "INVALID_JSON"     // a present file fails JSON.parse
 *   | "CONFIG_INVALID"   // config.schema.json / ADR-0009 rejection
 *   | "INVALID_SHAPE"    // valid-JSON/wrong-shape file (chunk 3.4a, ADR-0010)
 *   | "NOT_FOUND";       // extractScoped target missing
 *
 * export type LoaderError = { code: LoaderErrorCode; field: string; detail: string };
 * export type LoaderWarning = { code: string; field: string; detail: string };
 *
 * export type VersaillesContext = {
 *   config: WorkspaceConfig | null;
 *   contracts: ContractsFile | null;
 *   manifests: ManifestsFile | null;
 *   predicates: PredicatesFile | null;
 *   parsedContracts: Record<string, Node>; // clause id from contracts.json → AST
 *   parseErrors: ParseError[];             // build-spec §4.4, field decorated with the entry index
 *   validationErrors: LoaderError[];       // version/config/missing-file/invalid-json hard errors
 *   validationWarnings: LoaderWarning[];
 *   isValid: boolean;                      // parseErrors empty AND validationErrors empty
 * };
 *
 * export type ScopedView = {
 *   component: string;
 *   operation: string | null;
 *   contract: ComponentContract | ContractOperation | null;
 *   errors: (ParseError | LoaderError)[]; // scoped by contractId prefix; loader-level errors excluded
 *   warnings: LoaderWarning[];
 * };
 *
 * export declare function loadWorkspace(workspaceDir: string): Promise<VersaillesContext>;
 * export declare function extractScoped(
 *   context: VersaillesContext,
 *   component: string,
 *   operation?: string,
 * ): ScopedView;
 * ```
 *
 * ── Ambiguities resolved by these tests ────────────────────────────────────
 *
 * 1. Async: loadWorkspace is async (Promise<VersaillesContext>) — matches the
 *    repo's existing node:fs/promises convention (initWorkspace in
 *    src/cli/init.ts) and keeps the door open for an async semantic validator
 *    in Phase 3.2.
 * 2. parsedContracts keys: the clause `id` from contracts.json, which the
 *    build-spec §3.2 file shape already defines as "Component.operation.postN"
 *    / "Component.operation.preN" / "Component.invariantN" (build-spec §4.4
 *    example "OrderService.placeOrder.post0"). The loader passes that id to
 *    parseExpression as the contractId and uses it as the parsedContracts key.
 * 3. parseErrors keep the §4.4 shape; the loader decorates `field` with the
 *    entry index (e.g. "postconditions[0]"), which the standalone parser does
 *    not add (see the tests/parser.test.ts header note).
 * 4. Version mismatch short-circuits BEFORE any processing: no config schema
 *    validation and no expr parsing (build-spec §3.1 "checked before
 *    processing").
 * 5. Missing file / invalid JSON never throw: the loader records a structured
 *    LoaderError and the affected context field is null.
 * 6. Config schema errors go into validationErrors as
 *    { code: "CONFIG_INVALID", field: <ajv instancePath>, detail: <ajv message> }
 *    so the contract invariant isValid === (parseErrors empty && validationErrors
 *    empty) holds in this chunk.
 * 7. Scoped extraction filters parseErrors/validationErrors by contractId
 *    prefix; loader-level errors (which carry no contractId) never appear in a
 *    scoped view.
 */

// The exact SEEDED_CONFIG written by initWorkspace (src/cli/init.ts); kept
// local so the loader's happy path is pinned against the seed, not against
// the loader's own exported constants.
const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

function contractsFixture(): unknown {
	return {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [{ id: "OrderService.inv0", expr: "total >= 0" }],
				operations: {
					placeOrder: {
						id: "OrderService.placeOrder",
						params: [
							{ name: "items", type: "list<OrderItem>" },
							{ name: "customerId", type: "string" },
						],
						preconditions: [
							{ id: "OrderService.placeOrder.pre0", expr: 'customerId != ""' },
							{ id: "OrderService.placeOrder.pre1", expr: "items[0] != null" },
						],
						postconditions: [
							{
								id: "OrderService.placeOrder.post0",
								expr: 'order.status == "OPEN"',
							},
							{
								id: "OrderService.placeOrder.post1",
								expr: "old(total) <= total",
							},
						],
						effects: [{ field: "order.status", kind: "mutate" }],
						sourceHash: "abc123",
					},
				},
			},
			CustomerService: {
				invariants: [],
				operations: {
					register: {
						id: "CustomerService.register",
						params: [{ name: "email", type: "string" }],
						preconditions: [
							{
								id: "CustomerService.register.pre0",
								expr: "isValidEmail(email)",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "def456",
					},
				},
			},
		},
	};
}

function manifestsFixture(): unknown {
	return {
		version: "1.0",
		manifests: {
			OrderService: {
				sourceHash: "man-hash-1",
				fields: { total: "number", status: "string", order: "Order" },
			},
			OrderItem: {
				sourceHash: "man-hash-2",
				fields: { sku: "string", quantity: "number" },
			},
			Order: {
				sourceHash: "man-hash-3",
				fields: { status: "string" },
			},
		},
	};
}

function predicatesFixture(): unknown {
	return {
		version: "1.0",
		predicates: {
			isValidEmail: {
				params: ["email"],
				paramTypes: ["string"],
				returnType: "boolean",
				sourceRef: "EmailUtils.isValidEmail",
				sourceHash: "pred-hash-1",
				verifiedPure: true,
			},
		},
	};
}

async function writeWorkspaceFile(
	workspaceDir: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	await writeFile(
		join(workspaceDir, fileName),
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-loader-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Seeds a brand-new workspace via the real initWorkspace (so the seeded
 * config.json is exercised end-to-end) and returns the `.versailles/` dir.
 * Tests then overlay the richer contracts/manifests/predicates fixtures (or
 * deliberately break one file) — each test stays in its own fresh subdir.
 */
async function seedWorkspace(name: string): Promise<string> {
	const targetDir = join(tempRoot, name);
	await rm(targetDir, { recursive: true, force: true });
	await initWorkspace(targetDir);
	return join(targetDir, ".versailles");
}

async function seedRichWorkspace(name: string): Promise<string> {
	const ws = await seedWorkspace(name);
	await writeWorkspaceFile(ws, "contracts.json", contractsFixture());
	await writeWorkspaceFile(ws, "manifests.json", manifestsFixture());
	await writeWorkspaceFile(ws, "predicates.json", predicatesFixture());
	return ws;
}

describe("loadWorkspace — joint loading of the four .versailles/ files", () => {
	it("returns one context with all four files parsed, no errors, isValid true", async () => {
		const ws = await seedRichWorkspace("a-happy-path");

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.config).toEqual(SEEDED_CONFIG);
		expect(context.contracts).toEqual(contractsFixture());
		expect(context.manifests).toEqual(manifestsFixture());
		expect(context.predicates).toEqual(predicatesFixture());
		expect(context.parseErrors).toEqual([]);
		expect(context.validationErrors).toEqual([]);
		expect(context.validationWarnings).toEqual([]);
		expect(context.isValid).toBe(true);
	});

	it("parses every well-formed expr into an AST keyed by the clause id", async () => {
		const ws = await seedRichWorkspace("a2-asts");

		const context = await loadWorkspace(ws);

		expect(Object.keys(context.parsedContracts).sort()).toEqual([
			"CustomerService.register.pre0",
			"OrderService.inv0",
			"OrderService.placeOrder.post0",
			"OrderService.placeOrder.post1",
			"OrderService.placeOrder.pre0",
			"OrderService.placeOrder.pre1",
		]);

		expect(
			context.parsedContracts["OrderService.placeOrder.post0"],
		).toMatchObject({ type: "compare", op: "==" });
		expect(
			context.parsedContracts["OrderService.placeOrder.post1"],
		).toMatchObject({ type: "compare", op: "<=", left: { type: "old" } });
		expect(context.parsedContracts["OrderService.inv0"]).toMatchObject({
			type: "compare",
			op: ">=",
		});
		expect(
			context.parsedContracts["CustomerService.register.pre0"],
		).toMatchObject({ type: "predicateCall", name: "isValidEmail" });
	});
});

describe("loadWorkspace — parse errors", () => {
	it("collects a §4.4-structured error with the decorated field for a malformed expr — never throws", async () => {
		const ws = await seedWorkspace("b-malformed");
		await writeWorkspaceFile(ws, "contracts.json", {
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

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.parseErrors).toHaveLength(1);
		const error = context.parseErrors[0];
		expect(error).toMatchObject({
			contractId: "OrderService.placeOrder.post0",
			field: "postconditions[0]",
			position: 6,
			found: "=",
			expected: ["=="],
		});
		expect(error.message).toMatch(/did you mean '=='/);
		expect(context.parsedContracts).toEqual({});
		expect(context.isValid).toBe(false);
	});
});

describe("loadWorkspace — version gates (build-spec §3.1)", () => {
	it.each(["grammarVersion", "schemaVersion"])(
		"hard-fails with an upgrade-path message when config.%s is out of date — never throws",
		async (versionField) => {
			const ws = await seedWorkspace(`c-${versionField}`);
			await writeWorkspaceFile(ws, "config.json", {
				...SEEDED_CONFIG,
				[versionField]: "9.9",
			});
			// A well-formed expr is present: the version gate must short-circuit
			// parsing, proving "checked before processing" (build-spec §3.1).
			await writeWorkspaceFile(ws, "contracts.json", contractsFixture());

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			const versionError = context.validationErrors.find(
				(error) => error.code === "VERSION_MISMATCH",
			);
			expect(versionError).toBeDefined();
			expect(versionError?.field).toBe(versionField);
			expect(versionError?.detail).toMatch(/upgrade/i);
			expect(context.parseErrors).toEqual([]);
			expect(context.parsedContracts).toEqual({});
			expect(context.isValid).toBe(false);
		},
	);
});

describe("loadWorkspace — missing files", () => {
	it.each([
		"config.json",
		"contracts.json",
		"manifests.json",
		"predicates.json",
	])(
		"records a structured MISSING_FILE error when %s is absent — never throws",
		async (missingFile) => {
			const ws = await seedWorkspace(`d-${missingFile.replace(".", "-")}`);
			await rm(join(ws, missingFile), { force: true });

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			const missingErrors = context.validationErrors.filter(
				(error) => error.code === "MISSING_FILE",
			);
			expect(missingErrors).toHaveLength(1);
			expect(missingErrors[0].field).toBe(missingFile);
			expect(missingErrors[0].detail).not.toBe("");
			if (missingFile === "config.json") {
				expect(context.config).toBeNull();
			}
			expect(context.isValid).toBe(false);
		},
	);

	it("records a structured INVALID_JSON error for an unparseable present file — never throws", async () => {
		const ws = await seedWorkspace("d2-invalid-json");
		await writeFile(join(ws, "contracts.json"), "{ not valid json !!!", "utf8");

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		const invalidError = context.validationErrors.find(
			(error) => error.code === "INVALID_JSON",
		);
		expect(invalidError).toBeDefined();
		expect(invalidError?.field).toBe("contracts.json");
		expect(context.isValid).toBe(false);
	});
});

describe("loadWorkspace — config validation against the ADR-0009 matrix", () => {
	it("rejects config with testFramework 'jest' via a structured CONFIG_INVALID error", async () => {
		const ws = await seedWorkspace("e-invalid-config");
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			testFramework: "jest",
		});
		await writeWorkspaceFile(ws, "contracts.json", contractsFixture());
		await writeWorkspaceFile(ws, "manifests.json", manifestsFixture());
		await writeWorkspaceFile(ws, "predicates.json", predicatesFixture());

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		const configError = context.validationErrors.find(
			(error) => error.code === "CONFIG_INVALID",
		);
		expect(configError).toBeDefined();
		expect(configError?.field).toBe("/testFramework");
		expect(configError?.detail).toMatch(/allowed values/);
		expect(context.parseErrors).toEqual([]);
		expect(context.isValid).toBe(false);
	});
});

describe("extractScoped — scoped views for human review (build-spec §6.6)", () => {
	it("returns just the operation sub-object with only its own errors — never the whole file", async () => {
		const ws = await seedWorkspace("f-scoped-operator");
		await writeWorkspaceFile(ws, "contracts.json", {
			version: "1.0",
			contracts: {
				OrderService: {
					invariants: [{ id: "OrderService.inv0", expr: "total >= 0" }],
					operations: {
						placeOrder: {
							id: "OrderService.placeOrder",
							params: [{ name: "customerId", type: "string" }],
							preconditions: [
								{
									id: "OrderService.placeOrder.pre0",
									expr: 'customerId != ""',
								},
							],
							postconditions: [
								{ id: "OrderService.placeOrder.post0", expr: "total = 100" },
							],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
				CustomerService: {
					invariants: [],
					operations: {
						register: {
							id: "CustomerService.register",
							params: [{ name: "email", type: "string" }],
							preconditions: [
								{ id: "CustomerService.register.pre0", expr: 'email != ""' },
							],
							postconditions: [],
							effects: [],
							sourceHash: "def456",
						},
					},
				},
			},
		});

		const context = await loadWorkspace(ws);
		const view = extractScoped(context, "OrderService", "placeOrder");

		expect(view.component).toBe("OrderService");
		expect(view.operation).toBe("placeOrder");
		expect(view.contract).not.toBeNull();
		const contract = view.contract as Record<string, unknown>;
		expect(contract).toMatchObject({
			id: "OrderService.placeOrder",
			params: [{ name: "customerId", type: "string" }],
			sourceHash: "abc123",
		});
		// Never the whole file: an operation sub-object has no operations map.
		expect(contract).not.toHaveProperty("operations");
		expect(contract).not.toHaveProperty("contracts");
		// Its errors: only the parse error that belongs to this operation.
		expect(view.errors).toHaveLength(1);
		expect(view.errors[0]).toMatchObject({
			contractId: "OrderService.placeOrder.post0",
			field: "postconditions[0]",
		});
	});

	it("scopes by prefix: a clean operation has no errors; component scope aggregates its operations", async () => {
		const ws = await seedWorkspace("f2-scoped-clean");
		await writeWorkspaceFile(ws, "contracts.json", {
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
				CustomerService: {
					invariants: [],
					operations: {
						register: {
							id: "CustomerService.register",
							params: [{ name: "email", type: "string" }],
							preconditions: [
								{ id: "CustomerService.register.pre0", expr: 'email != ""' },
							],
							postconditions: [],
							effects: [],
							sourceHash: "def456",
						},
					},
				},
			},
		});

		const context = await loadWorkspace(ws);

		const clean = extractScoped(context, "CustomerService", "register");
		expect(clean.contract).not.toBeNull();
		expect(clean.contract).toMatchObject({ id: "CustomerService.register" });
		expect(clean.errors).toEqual([]);

		const componentView = extractScoped(context, "OrderService");
		expect(componentView.operation).toBeNull();
		expect(componentView.contract).not.toBeNull();
		const component = componentView.contract as Record<string, unknown>;
		expect(component).toHaveProperty("operations");
		expect(component).toHaveProperty("invariants");
		// Not the whole file: no top-level "contracts" key.
		expect(component).not.toHaveProperty("contracts");
		expect(componentView.errors).toHaveLength(1);
	});
});

describe("loadWorkspace — repeatability", () => {
	it("returns the same structure across repeated loadWorkspace calls", async () => {
		const ws = await seedRichWorkspace("g-idempotent");

		const first = await loadWorkspace(ws);
		const second = await loadWorkspace(ws);

		expect(second).toEqual(first);
		expect(second.isValid).toBe(true);
	});
});

/**
 * Semantic-wiring fixtures (chunk 3.3): the loader runs semanticValidate over
 * every successfully-parsed clause with the right clauseKind + scope and
 * appends semantic errors (contractId-carrying) and warnings to
 * validationErrors/validationWarnings alongside loader-level results. These
 * tests pin build-spec §6.5: any semantic error flips isValid (ADR-0004
 * warnings excepted).
 */
function semanticErrorContractsFixture(): unknown {
	return {
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
			otherComp: {
				invariants: [],
				operations: {
					doThing: {
						id: "otherComp.doThing",
						params: [],
						preconditions: [],
						postconditions: [],
						effects: [],
						sourceHash: "def456",
					},
				},
			},
		},
	};
}

function semanticErrorManifestsFixture(): unknown {
	return {
		version: "1.0",
		manifests: {
			svc: { sourceHash: "man-svc", fields: { known: "number" } },
			otherComp: { sourceHash: "man-other", fields: {} },
		},
	};
}

function emptyPredicatesFixture(): unknown {
	return { version: "1.0", predicates: {} };
}

async function seedSemanticErrorWorkspace(name: string): Promise<string> {
	const ws = await seedWorkspace(name);
	await writeWorkspaceFile(
		ws,
		"contracts.json",
		semanticErrorContractsFixture(),
	);
	await writeWorkspaceFile(
		ws,
		"manifests.json",
		semanticErrorManifestsFixture(),
	);
	await writeWorkspaceFile(ws, "predicates.json", emptyPredicatesFixture());
	return ws;
}

describe("loadWorkspace — semantic validation wiring (§6.5)", () => {
	it("a: an unknown-field clause propagates UNKNOWN_FIELD into validationErrors and flips isValid false", async () => {
		const ws = await seedSemanticErrorWorkspace("a-unknown-field");

		const context = await loadWorkspace(ws);

		// The clause parsed successfully — the semantic error is an error in
		// ADDITION to the parse, not a sign the parse failed.
		expect(context.parsedContracts["svc.op.pre0"]).toBeDefined();
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "UNKNOWN_FIELD",
				contractId: "svc.op.pre0",
			}),
		);
		expect(context.isValid).toBe(false);
	});

	it("b: a fully-valid workspace (all fields resolvable, predicates registered+verifiedPure) stays valid with no semantic errors", async () => {
		const ws = await seedWorkspace("b-semantic-clean");
		await writeWorkspaceFile(ws, "contracts.json", {
			version: "1.0",
			contracts: {
				svc: {
					invariants: [{ id: "svc.inv0", expr: "total >= 0" }],
					operations: {
						op: {
							id: "svc.op",
							params: [{ name: "amount", type: "number" }],
							preconditions: [
								{ id: "svc.op.pre0", expr: "isPositive(amount)" },
							],
							postconditions: [
								{ id: "svc.op.post0", expr: "old(total) <= total" },
							],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		await writeWorkspaceFile(ws, "manifests.json", {
			version: "1.0",
			manifests: {
				svc: { sourceHash: "man-svc", fields: { total: "number" } },
			},
		});
		await writeWorkspaceFile(ws, "predicates.json", {
			version: "1.0",
			predicates: {
				isPositive: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isPositive",
					sourceHash: "p1",
					verifiedPure: true,
				},
			},
		});

		const context = await loadWorkspace(ws);

		expect(context.isValid).toBe(true);
		expect(context.validationErrors).toEqual([]);
		expect(context.validationWarnings).toEqual([]);
	});

	it("c: a type mismatch between a clause literal and the manifest-declared field type propagates TYPE_MISMATCH with the clause contractId", async () => {
		const ws = await seedWorkspace("c-type-mismatch");
		await writeWorkspaceFile(ws, "contracts.json", {
			version: "1.0",
			contracts: {
				svc: {
					invariants: [],
					operations: {
						op: {
							id: "svc.op",
							params: [],
							preconditions: [{ id: "svc.op.pre0", expr: 'balance == "str"' }],
							postconditions: [],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		await writeWorkspaceFile(ws, "manifests.json", {
			version: "1.0",
			manifests: {
				svc: { sourceHash: "man-svc", fields: { balance: "number" } },
			},
		});
		await writeWorkspaceFile(ws, "predicates.json", emptyPredicatesFixture());

		const context = await loadWorkspace(ws);

		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "TYPE_MISMATCH",
				contractId: "svc.op.pre0",
			}),
		);
		expect(context.isValid).toBe(false);
	});

	it("d: an inferred (low-confidence) manifest field warns LOW_CONFIDENCE_FIELD but never flips isValid (ADR-0004)", async () => {
		const ws = await seedWorkspace("d-low-confidence");
		await writeWorkspaceFile(ws, "contracts.json", {
			version: "1.0",
			contracts: {
				svc: {
					invariants: [],
					operations: {
						op: {
							id: "svc.op",
							params: [],
							preconditions: [
								{ id: "svc.op.pre0", expr: "inferredField >= 0" },
							],
							postconditions: [],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		});
		// ADR-0004 extension object form: { type, confidence: "inferred" }.
		await writeWorkspaceFile(ws, "manifests.json", {
			version: "1.0",
			manifests: {
				svc: {
					sourceHash: "man-svc",
					fields: {
						inferredField: { type: "number", confidence: "inferred" },
					},
				},
			},
		});
		await writeWorkspaceFile(ws, "predicates.json", emptyPredicatesFixture());

		const context = await loadWorkspace(ws);

		expect(context.validationWarnings).toContainEqual(
			expect.objectContaining({ code: "LOW_CONFIDENCE_FIELD" }),
		);
		expect(context.validationErrors).toEqual([]);
		expect(context.isValid).toBe(true);
	});

	it("e: extractScoped includes the semantic error for the owning component/operation only", async () => {
		const ws = await seedSemanticErrorWorkspace("e-scoped-semantic");

		const context = await loadWorkspace(ws);

		const opView = extractScoped(context, "svc", "op");
		expect(opView.errors).toContainEqual(
			expect.objectContaining({
				code: "UNKNOWN_FIELD",
				contractId: "svc.op.pre0",
			}),
		);

		const otherView = extractScoped(context, "otherComp");
		expect(otherView.errors).not.toContainEqual(
			expect.objectContaining({
				code: "UNKNOWN_FIELD",
				contractId: "svc.op.pre0",
			}),
		);
	});

	it("f: loader-level MISSING_FILE and semantic UNKNOWN_FIELD coexist in validationErrors (append, not replace)", async () => {
		const ws = await seedWorkspace("f-loader-plus-semantic");
		await writeWorkspaceFile(
			ws,
			"contracts.json",
			semanticErrorContractsFixture(),
		);
		await writeWorkspaceFile(
			ws,
			"manifests.json",
			semanticErrorManifestsFixture(),
		);
		// predicates.json removed on purpose: config stays valid so the version
		// gate passes, the loader records MISSING_FILE, and the semantic
		// validator still runs over the parsed clause.
		await rm(join(ws, "predicates.json"), { force: true });

		const context = await loadWorkspace(ws);

		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "MISSING_FILE",
				field: "predicates.json",
			}),
		);
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "UNKNOWN_FIELD",
				contractId: "svc.op.pre0",
			}),
		);
		expect(context.isValid).toBe(false);
	});
});

/**
 * Malformed-shape robustness block (chunk 3.4a, ADR-0010): valid-JSON but
 * wrong-SHAPE workspace files must never throw — the loader's documented
 * never-throws promise (src/loader/workspace.ts:10-11). Each test seeds a
 * valid workspace from the base fixtures below (mirroring
 * contractsFixture/manifestsFixture) and corrupts ONE file, then pins the
 * post-fix outcome contract: a structured INVALID_SHAPE loader error, or —
 * for the degenerate extractScoped cases (C6/C9) — a non-throwing scoped
 * view carrying an errors array. The tests must genuinely reject today with
 * the raw TypeError/RangeError; the assertions below are the structured
 * outcomes the fix must produce (no lazy try/catch can satisfy them).
 *
 * Field naming convention chosen for INVALID_SHAPE errors:
 * - top-level file:                       "<file>.json"
 * - clause entry (primitive):             "contracts.contracts.<Component>.<clauseKind>[<index>]"
 * - clauseKind that is not an array:      "contracts.contracts.<Component>.<clauseKind>"
 * - manifest entry:                       "manifests.manifests.<Component>.fields"
 */
type ShapeOperation = {
	id: string;
	params: unknown[];
	preconditions: unknown;
	postconditions: unknown[];
	effects: unknown[];
	sourceHash: string;
};

type ShapeContractFile = {
	version: string;
	contracts: Record<
		string,
		{
			invariants: unknown;
			operations: Record<string, ShapeOperation>;
		}
	>;
};

type ShapeOverrides = {
	contracts?: unknown;
	manifests?: unknown;
	predicates?: unknown;
};

function baseContracts(): ShapeContractFile {
	return {
		version: "1.0",
		contracts: {
			Svc: {
				invariants: [{ id: "Svc.inv0", expr: "total >= 0" }],
				operations: {
					op: {
						id: "Svc.op",
						params: [],
						preconditions: [],
						postconditions: [],
						effects: [],
						sourceHash: "abc123",
					},
				},
			},
		},
	};
}

function baseManifests(): unknown {
	return {
		version: "1.0",
		manifests: {
			Svc: { sourceHash: "man-svc", fields: { total: "number" } },
		},
	};
}

function basePredicates(): unknown {
	return { version: "1.0", predicates: {} };
}

async function seedShapeWorkspace(
	name: string,
	overrides: ShapeOverrides = {},
): Promise<string> {
	const ws = await seedWorkspace(name);
	await writeWorkspaceFile(
		ws,
		"contracts.json",
		overrides.contracts ?? baseContracts(),
	);
	await writeWorkspaceFile(
		ws,
		"manifests.json",
		overrides.manifests ?? baseManifests(),
	);
	await writeWorkspaceFile(
		ws,
		"predicates.json",
		overrides.predicates ?? basePredicates(),
	);
	return ws;
}

describe("loadWorkspace — malformed-shape workspace files never throw (ADR-0010)", () => {
	it.each([
		{ file: "contracts.json", value: 42 },
		{ file: "manifests.json", value: "hello" },
		{ file: "predicates.json", value: true },
	])(
		"records INVALID_SHAPE with field $file when top-level $file is a primitive (C1/C2/C17) — never throws",
		async ({ file, value }) => {
			const overrides: ShapeOverrides = {};
			if (file === "contracts.json") {
				overrides.contracts = value;
			}
			if (file === "manifests.json") {
				overrides.manifests = value;
			}
			if (file === "predicates.json") {
				overrides.predicates = value;
			}

			const ws = await seedShapeWorkspace(
				`s1-primitive-top-level-${file.replace(".", "-")}`,
				overrides,
			);

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			expect(context.isValid).toBe(false);
			expect(context.validationErrors).toContainEqual(
				expect.objectContaining({ code: "INVALID_SHAPE", field: file }),
			);
		},
	);

	it.each([
		{ label: "a number (42)", value: 42 },
		{ label: "null", value: null },
	])(
		"records INVALID_SHAPE for a clause entry that is $label (C4/C5) — never throws",
		async ({ value }) => {
			const contracts = baseContracts();
			contracts.contracts.Svc.invariants = [value];

			const ws = await seedShapeWorkspace(
				`s2-clause-entry-${JSON.stringify(value)}`,
				{ contracts },
			);

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			expect(context.isValid).toBe(false);
			expect(context.validationErrors).toContainEqual(
				expect.objectContaining({
					code: "INVALID_SHAPE",
					// Chosen naming: contracts.contracts.Svc.invariants[0]
					field: expect.stringContaining("invariants"),
				}),
			);
		},
	);

	it("records INVALID_SHAPE when the invariants clauseKind is not an array (C12) — never throws", async () => {
		const contracts = baseContracts();
		contracts.contracts.Svc.invariants = 5;

		const ws = await seedShapeWorkspace("s3-invariants-non-array", {
			contracts,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.isValid).toBe(false);
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "INVALID_SHAPE",
				// Chosen naming: contracts.contracts.Svc.invariants
				field: expect.stringContaining("invariants"),
			}),
		);
	});

	it("records INVALID_SHAPE when the preconditions clauseKind is not an array (C13) — never throws", async () => {
		const contracts = baseContracts();
		contracts.contracts.Svc.operations.op.preconditions = "x";

		const ws = await seedShapeWorkspace("s4-preconditions-non-array", {
			contracts,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.isValid).toBe(false);
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "INVALID_SHAPE",
				// Chosen naming: contracts.contracts.Svc.operations.op.preconditions
				field: expect.stringContaining("preconditions"),
			}),
		);
	});

	it("records INVALID_SHAPE when a manifest entry is missing fields, root ref (C7) — never throws", async () => {
		const manifests = {
			version: "1.0",
			manifests: { Svc: { sourceHash: "man-svc" } },
		};

		const ws = await seedShapeWorkspace("s5-manifest-missing-fields-root", {
			manifests,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.isValid).toBe(false);
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "INVALID_SHAPE",
				// Chosen naming: manifests.manifests.Svc.fields
				field: expect.stringContaining("Svc"),
			}),
		);
	});

	it("records INVALID_SHAPE when a nested-referenced manifest entry is missing fields (C8) — never throws", async () => {
		const contracts = baseContracts();
		contracts.contracts.Svc.invariants = [
			{ id: "Svc.inv0", expr: 'order.status == "OPEN"' },
		];
		const manifests = {
			version: "1.0",
			manifests: {
				Svc: { sourceHash: "man-svc", fields: { order: "Order" } },
				Order: { sourceHash: "man-order" },
			},
		};

		const ws = await seedShapeWorkspace("s6-manifest-missing-fields-nested", {
			contracts,
			manifests,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.isValid).toBe(false);
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "INVALID_SHAPE",
				// Chosen naming: manifests.manifests.Order.fields
				field: expect.stringContaining("Order"),
			}),
		);
	});

	it("records INVALID_SHAPE when a manifest entry has fields: null (C10) — never throws", async () => {
		const manifests = {
			version: "1.0",
			manifests: { Svc: { sourceHash: "man-svc", fields: null } },
		};

		const ws = await seedShapeWorkspace("s7-manifest-fields-null", {
			manifests,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.isValid).toBe(false);
		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "INVALID_SHAPE",
				// Chosen naming: manifests.manifests.Svc.fields
				field: expect.stringContaining("Svc"),
			}),
		);
	});

	it("extractScoped returns a scoped view with an errors array for a component lacking operations (C9) — never throws", async () => {
		const contracts = {
			version: "1.0",
			contracts: { Svc: { invariants: [] } },
		};

		const ws = await seedShapeWorkspace("s8-extract-scoped-no-operations", {
			contracts,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		const view = extractScoped(context, "Svc", "op");
		expect(view).toBeDefined();
		expect(Array.isArray(view.errors)).toBe(true);
	});

	it("extractScoped returns a scoped view with an errors array after an id-less failing clause (C6) — never throws", async () => {
		const contracts = {
			version: "1.0",
			contracts: {
				Svc: {
					invariants: [],
					operations: {
						op: {
							id: "Svc.op",
							params: [],
							preconditions: [{ expr: "total = 100" }],
							postconditions: [],
							effects: [],
							sourceHash: "abc123",
						},
					},
				},
			},
		};

		const ws = await seedShapeWorkspace("s9-idless-failing-clause", {
			contracts,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		const view = extractScoped(context, "Svc", "op");
		expect(view).toBeDefined();
		expect(Array.isArray(view.errors)).toBe(true);
	});

	it("never throws when a manifest typeRef nests 20000 levels deep (F2) — result keeps validationErrors/isValid", async () => {
		// F2: today the validator's recursive parseTypeRef overflows the call
		// stack at depth 20000 (RangeError: Maximum call stack size exceeded).
		// The fix may emit a structured error OR raise/lower the depth guard —
		// pin only never-throws plus the shape of the result.
		const DEPTH = 20000;
		const deepTypeRef = `${"list<".repeat(DEPTH)}number${">".repeat(DEPTH)}`;
		const manifests = {
			version: "1.0",
			manifests: {
				Svc: { sourceHash: "man-svc", fields: { total: deepTypeRef } },
			},
		};

		const ws = await seedShapeWorkspace("s10-type-ref-depth-20000", {
			manifests,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(Array.isArray(context.validationErrors)).toBe(true);
		expect(typeof context.isValid).toBe("boolean");
	});
});

/**
 * Re-review crash holes (chunk 3.4b): the Center's re-review of the 3.4a
 * robustness fix found four holes the 3.4a fixtures could not reach — none of
 * them mutated `operation.params`, and none combined a primitive store with
 * extractScoped. Each test must genuinely reject today with the raw
 * TypeError/RangeError noted in its comment; the assertions below pin the
 * structured outcome the fix must produce (no lazy try/catch can satisfy
 * them).
 *
 * B1 — operation.params non-array / null element: findOperationParam
 *   (src/core/validator.ts) does `operation.params ?? []` then `.find(...)`,
 *   so `params: "x"`, `42`, `{}` → TypeError: params.find is not a function
 *   and `[null]` → TypeError: reading 'name'. (params: null coalesces to [] —
 *   it already passes, so it is not pinned.) Post-fix: a shape-guard check on
 *   operation.params (mirrors the per-entry predicates check) records
 *   INVALID_SHAPE with a field naming the params path.
 * B2 — extractScoped on a shape-invalid primitive contracts.json: findContract
 *   (src/loader/workspace.ts) does `contracts.contracts[component]` where
 *   `contracts` is the primitive 42/true → TypeError: Cannot read properties
 *   of undefined (reading 'Svc'). Post-fix: a non-throwing scoped view with an
 *   errors array.
 * W1 — compatible recursion on deep same-family typeRefs: the 3.4a F2 test
 *   compared a scalar literal to the deep list (returns false, no recursion);
 *   a same-family compare (`total == total`) makes compatible recurse per
 *   nesting level (validator.ts list/optional cases) → RangeError at depth
 *   20000. Post-fix: loadWorkspace resolves with a structured validationErrors
 *   array + boolean isValid (do not over-pin which).
 * W2 — a present file whose content is the JSON literal `null` parses to null
 *   with NO error (loadJsonFile), the shape guard treats null as
 *   missing-file-covered, and isValid ends TRUE (false green). Post-fix: a
 *   structured signal carrying the file's field and isValid false.
 */
describe("loadWorkspace — re-review crash holes close (chunk 3.4b)", () => {
	it.each([
		{ dir: "s11-b1-string", label: 'the string "x"', params: "x" },
		{ dir: "s11-b1-number", label: "the number 42", params: 42 },
		{ dir: "s11-b1-object", label: "a plain object {}", params: {} },
		{
			dir: "s11-b1-null-element",
			label: "an array containing a null element",
			params: [null],
		},
	])(
		"records INVALID_SHAPE when operation params is $label (B1) — never throws",
		async ({ dir, params }) => {
			const contracts = baseContracts();
			contracts.contracts.Svc.operations.op.params =
				params as ShapeOperation["params"];
			// A precondition referencing a field forces findOperationParam to
			// resolve the (broken) params array — without it no param lookup
			// runs and the crash class stays latent.
			contracts.contracts.Svc.operations.op.preconditions = [
				{ id: "Svc.op.pre0", expr: "total >= 0" },
			];

			const ws = await seedShapeWorkspace(dir, { contracts });

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			expect(context.isValid).toBe(false);
			expect(context.validationErrors).toContainEqual(
				expect.objectContaining({
					code: "INVALID_SHAPE",
					// Chosen naming: contracts.contracts.Svc.operations.op.params
					field: expect.stringContaining("params"),
				}),
			);
		},
	);

	it.each([
		{ dir: "s12-b2-number", label: "the number 42", value: 42 },
		{ dir: "s12-b2-boolean", label: "the boolean true", value: true },
	])(
		"extractScoped returns a scoped view with an errors array when contracts.json is $label (B2) — never throws",
		async ({ dir, value }) => {
			const ws = await seedShapeWorkspace(dir, { contracts: value });

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			expect(context.isValid).toBe(false);
			expect(context.validationErrors).toContainEqual(
				expect.objectContaining({
					code: "INVALID_SHAPE",
					field: "contracts.json",
				}),
			);

			const view = extractScoped(context, "Svc", "op");
			expect(view).toBeDefined();
			expect(Array.isArray(view.errors)).toBe(true);
		},
	);

	it("never throws when compatible compares two same-family typeRefs nested 20000 deep (W1) — result keeps validationErrors/isValid", async () => {
		// W1: the 3.4a F2 test compared a scalar literal to the deep list type
		// (compatible returns false with no recursion); a same-family compare
		// (`total == total`) recurses per nesting level in the validator's
		// list/optional cases → RangeError: Maximum call stack size exceeded.
		// The fix may emit a structured error or handle the depth — pin only
		// never-throws plus the shape of the result.
		const DEPTH = 20000;
		const deepTypeRef = `${"list<".repeat(DEPTH)}number${">".repeat(DEPTH)}`;
		const contracts = baseContracts();
		contracts.contracts.Svc.operations.op.preconditions = [
			{ id: "Svc.op.pre0", expr: "total == total" },
		];
		const manifests = {
			version: "1.0",
			manifests: {
				Svc: { sourceHash: "man-svc", fields: { total: deepTypeRef } },
			},
		};

		const ws = await seedShapeWorkspace("s13-compatible-depth-20000", {
			contracts,
			manifests,
		});

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(Array.isArray(context.validationErrors)).toBe(true);
		expect(typeof context.isValid).toBe("boolean");
	});

	it.each(["config.json", "contracts.json"])(
		"does not silently load %s with literal JSON null content as valid (W2) — structured signal with the file field, isValid false",
		async (file) => {
			const ws = await seedWorkspace(`s14-null-${file.replace(".", "-")}`);
			await writeWorkspaceFile(ws, "contracts.json", baseContracts());
			await writeWorkspaceFile(ws, "manifests.json", baseManifests());
			await writeWorkspaceFile(ws, "predicates.json", basePredicates());
			// The file is PRESENT and its content is the JSON literal null
			// (readFile succeeds, JSON.parse yields null) — distinct from the
			// missing-file and invalid-JSON cases.
			await writeFile(join(ws, file), "null", "utf8");

			const context = await loadWorkspace(ws);

			expect(context.isValid).toBe(false);
			expect(context.validationErrors).toContainEqual(
				expect.objectContaining({ field: file }),
			);
		},
	);
});
