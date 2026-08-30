import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initWorkspace } from "../packages/cli/src/cli/init.js";

// The joint .versailles/ loader (Phase 3.1, chunk 3.1; semantic wiring in
// chunk 3.3). The loader runs the semantic validator (src/core/validator.ts)
// over every successfully-parsed clause and aggregates its errors/warnings
// into validationErrors/validationWarnings, which feed the aggregated isValid
// flag (build-spec §6.5) alongside parse, version, and config errors.
import { loadWorkspace } from "../packages/core/src/loader/workspace.js";

/**
 * Loader/context — pinned against build-spec §6, §2, §3.1 and the
 * workspace-context contract (docs/contracts/workspace-context.contract.yaml).
 *
 * The loader is the single shared path into the .versailles/ workspace: it
 * reads and JSON-parses the three jointly-loaded files (config.json,
 * contracts.json, manifests.json), parses every expr string in
 * contracts.json into an AST via parseExpression (src/core/parser.ts),
 * validates config.json against config.schema.json (ADR-0009 matrix), and
 * returns ONE VersaillesContext with an aggregated isValid flag (build-spec
 * §6.5). After parsing, the loader runs the semantic validator over every
 * successfully-parsed clause and aggregates its errors/warnings into
 * validationErrors/validationWarnings (build-spec §6.5); loader-level results
 * (config schema errors under code CONFIG_INVALID, plus missing-file,
 * and invalid-json errors) are recorded into the same arrays.
 *
 * ── Module contract ────────────────────────────────────────────────────────
 *
 * ADR-0018 (VERSAILLES-170): the version ceremony is removed. No workspace
 * file carries a top-level `version` field, config.json carries no
 * grammarVersion/schemaVersion, and the loader has no version-gate branches
 * (SUPPORTED_GRAMMAR_VERSION / SUPPORTED_SCHEMA_VERSION / VERSION_MISMATCH
 * are gone). config.json may carry a `$schema` pointer string instead.
 *
 * Module: src/loader/workspace.ts
 * Exports: loadWorkspace (+ the types below)
 *
 * ```ts
 * export type WorkspaceConfig = {
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
 *   contracts: Record<string, ComponentContract>;
 * };
 *
 * export type ManifestsFile = {
 *   manifests: Record<string, { sourceHash: string; fields: Record<string, string> }>;
 * };
 *
 * export type PredicatesFile = {
 *   predicates: Record<string, {
 *     params: string[];
 *     paramTypes: string[];
 *     returnType: string;
 *     sourceRef: string;
 *     verifiedPure: boolean;
 *   }>;
 * };
 *
 * export type LoaderErrorCode =
 *   | "MISSING_FILE"     // one of the four jointly-loaded files absent
 *   | "INVALID_JSON"     // a present file fails JSON.parse
 *   | "CONFIG_INVALID"   // config.schema.json / ADR-0009 rejection
 *   | "INVALID_SHAPE";   // valid-JSON/wrong-shape file (chunk 3.4a, ADR-0010)
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
 * export declare function loadWorkspace(workspaceDir: string): Promise<VersaillesContext>;
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
 * 4. ADR-0018 (VERSAILLES-170): there is no version gate — the loader never
 *    short-circuits on config.grammarVersion / config.schemaVersion (the
 *    fields and the VERSION_MISMATCH branch are removed); a version-less
 *    config is the valid default and `$schema` is tolerated.
 * 5. Missing file / invalid JSON never throw: the loader records a structured
 *    LoaderError and the affected context field is null.
 * 6. Config schema errors go into validationErrors as
 *    { code: "CONFIG_INVALID", field: <ajv instancePath>, detail: <ajv message> }
 *    so the contract invariant isValid === (parseErrors empty && validationErrors
 *    empty) holds in this chunk.
 * 7. Scoped extraction filters parseErrors/validationErrors by contractId
 *    prefix; loader-level errors (which carry no contractId) never appear in a
 *    scoped view.
 * 8. ADR-0017 propertyBased: the loader needs no bespoke propertyBased shape
 *    checks — config.schema.json gains the optional block and the existing
 *    ajv pass (code CONFIG_INVALID, field = ajv instancePath) surfaces every
 *    propertyBased shape error; a workspace without propertyBased stays valid
 *    (v1 default).
 */

// The exact SEEDED_CONFIG written by initWorkspace (src/cli/init.ts); kept
// local so the loader's happy path is pinned against the seed. ADR-0018
// (VERSAILLES-170): no grammarVersion/schemaVersion fields — the `$schema`
// pointer string replaces the version ceremony.
const SEEDED_CONFIG = {
	$schema: "../../config.schema.json",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

function contractsFixture(): unknown {
	return {
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

/**
 * ADR-0013 (Phase 3): predicates are now declared inline in contracts.json's
 * top-level `predicates` map. Each entry carries: source, params, paramTypes,
 * returnType, verifiedPure. The sourceHash field is dropped.
 */
function predicatesFixture(): Record<string, unknown> {
	return {
		isValidEmail: {
			source: "EmailUtils.isValidEmail",
			params: ["email"],
			paramTypes: ["string"],
			returnType: "boolean",
			verifiedPure: true,
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
	// ADR-0013 (Phase 3): predicates are inline in contracts.json's top-level
	// `predicates` map. Merge the predicates fixture into the contracts fixture.
	const contracts = contractsFixture() as Record<string, unknown>;
	contracts.predicates = predicatesFixture();
	await writeWorkspaceFile(ws, "contracts.json", contracts);
	await writeWorkspaceFile(ws, "manifests.json", manifestsFixture());
	return ws;
}

describe("loadWorkspace — joint loading of the three .versailles/ files", () => {
	it("returns one context with all three files parsed, no errors, isValid true", async () => {
		const ws = await seedRichWorkspace("a-happy-path");

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(context.config).toEqual(SEEDED_CONFIG);
		// ADR-0013 (Phase 3): contracts.json now carries predicates inline.
		const expectedContracts = contractsFixture() as Record<string, unknown>;
		expectedContracts.predicates = predicatesFixture();
		expect(context.contracts).toEqual(expectedContracts);
		expect(context.manifests).toEqual(manifestsFixture());
		// ADR-0013 (Phase 3) + ADR-0018 (VERSAILLES-170): the loader builds a
		// PredicatesFile from the inline predicates for backward compatibility
		// with the validator. The shape carries no `version` and no `sourceHash`
		// (the `""` vestige is removed); sourceRef = source.
		expect(context.predicates).toEqual({
			predicates: {
				isValidEmail: {
					params: ["email"],
					paramTypes: ["string"],
					returnType: "boolean",
					sourceRef: "EmailUtils.isValidEmail",
					verifiedPure: true,
				},
			},
		});
		expect(context.parseErrors).toEqual([]);
		expect(context.validationErrors).toEqual([]);
		// Note: validationWarnings may contain PREDICATE_SOURCE_UNRESOLVED if the
		// predicate source can't be resolved under config.sourceRoots. This test
		// pins that the workspace loads cleanly (no errors), not that loader
		// warnings are empty.
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

/**
 * ADR-0018 (VERSAILLES-170): the version ceremony is removed. config.json no
 * longer carries grammarVersion/schemaVersion and the loader has no
 * VERSION_MISMATCH branch — a version-less config is the valid default and
 * parsing proceeds (no short-circuit). config.json may carry a `$schema`
 * pointer string instead; the new config.schema.json allows that key.
 */
describe("loadWorkspace — version ceremony removed (ADR-0018)", () => {
	it("loads a config WITHOUT grammarVersion/schemaVersion as valid — no version errors, no short-circuit", async () => {
		const ws = await seedWorkspace("c-versionless-config");
		// SEEDED_CONFIG carries no grammarVersion/schemaVersion (ADR-0018).
		await writeWorkspaceFile(ws, "config.json", SEEDED_CONFIG);
		// A well-formed expr is present: with the version gates gone, parsing
		// must proceed — the loader never short-circuits before processing.
		// The contracts fixture calls isValidEmail(email), so the matching
		// predicates map must be declared inline (ADR-0013) — otherwise the
		// clause would surface UNKNOWN_PREDICATE instead of pinning the
		// version-ceremony behavior.
		const contracts = contractsFixture() as Record<string, unknown>;
		contracts.predicates = predicatesFixture();
		await writeWorkspaceFile(ws, "contracts.json", contracts);

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		// No VERSION_MISMATCH-style errors, no config errors, no parse errors.
		expect(context.validationErrors).toEqual([]);
		expect(context.parseErrors).toEqual([]);
		// Parsing proceeded — the well-formed expr produced an AST.
		expect(
			context.parsedContracts["OrderService.placeOrder.post0"],
		).toBeDefined();
		expect(context.isValid).toBe(true);
	});

	it("tolerates a config carrying a $schema pointer string — the key is allowed by the new schema", async () => {
		const ws = await seedWorkspace("c-schema-pointer");
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			$schema: "../../config.schema.json",
		});
		// The contracts fixture calls isValidEmail(email), so the matching
		// predicates map must be declared inline (ADR-0013) — otherwise the
		// clause would surface UNKNOWN_PREDICATE instead of pinning the
		// $schema-tolerance behavior.
		const contracts = contractsFixture() as Record<string, unknown>;
		contracts.predicates = predicatesFixture();
		await writeWorkspaceFile(ws, "contracts.json", contracts);

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(
			context.validationErrors.filter((e) => e.code === "CONFIG_INVALID"),
		).toEqual([]);
		expect(context.parseErrors).toEqual([]);
		expect(context.isValid).toBe(true);
	});

	// ADR-0018 deprecate-don't-remove promise (VERSAILLES-168 Center review):
	// a PRE-MIGRATION config.json — one still carrying the removed
	// grammarVersion/schemaVersion fields — must LOAD PERMISSIVELY without a
	// version error, so old workspaces keep working until a future `migrate`
	// command rewrites them. Today config.schema.json declares neither key and
	// keeps additionalProperties: false, so ajv rejects the legacy keys with
	// CONFIG_INVALID "must NOT have additional properties". The Green schema
	// fix declares both as OPTIONAL deprecated properties; these tests pin the
	// post-fix contract and MUST FAIL (Red) against the current schema.
	it("loads a PRE-MIGRATION config carrying legacy grammarVersion/schemaVersion as valid — deprecate-don't-remove (ADR-0018)", async () => {
		const ws = await seedWorkspace("c-pre-migration-legacy-fields");
		// SEEDED_CONFIG is the version-less shape; spread the removed legacy
		// version fields back in to simulate a pre-migration workspace.
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			grammarVersion: "1.0",
			schemaVersion: "1.0",
		});
		// The contracts fixture calls isValidEmail(email), so the matching
		// predicates map must be declared inline (ADR-0013) — otherwise the
		// clause would surface UNKNOWN_PREDICATE instead of pinning the
		// permissive-loading behavior.
		const contracts = contractsFixture() as Record<string, unknown>;
		contracts.predicates = predicatesFixture();
		await writeWorkspaceFile(ws, "contracts.json", contracts);

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		// Permissive: the legacy keys are tolerated, not rejected.
		expect(
			context.validationErrors.filter((e) => e.code === "CONFIG_INVALID"),
		).toEqual([]);
		// VERSION_MISMATCH is gone entirely — no version-gate error may appear.
		expect(
			context.validationErrors.some((e) => e.code === "VERSION_MISMATCH"),
		).toBe(false);
		expect(context.parseErrors).toEqual([]);
		expect(context.isValid).toBe(true);
	});

	it("loads a PRE-MIGRATION config carrying legacy version fields AND a $schema pointer as valid (ADR-0018)", async () => {
		const ws = await seedWorkspace("c-pre-migration-legacy-schema");
		// The pre-migration shape may also keep its $schema pointer alongside
		// the legacy version fields — both must be tolerated together.
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			$schema: "../../config.schema.json",
			grammarVersion: "1.0",
			schemaVersion: "1.0",
		});
		// Same inline-predicates rationale as the sibling legacy test.
		const contracts = contractsFixture() as Record<string, unknown>;
		contracts.predicates = predicatesFixture();
		await writeWorkspaceFile(ws, "contracts.json", contracts);

		const load = loadWorkspace(ws);
		await expect(load).resolves.toBeDefined();
		const context = await load;

		expect(
			context.validationErrors.filter((e) => e.code === "CONFIG_INVALID"),
		).toEqual([]);
		expect(context.parseErrors).toEqual([]);
		expect(context.isValid).toBe(true);
	});
});

describe("loadWorkspace — missing files", () => {
	// ADR-0013 (Phase 3): predicates.json is retired — only config.json and
	// contracts.json are required. manifests.json is optional (greenfield path).
	it.each(["config.json", "contracts.json"])(
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

/**
 * ADR-0017 (seeded PBT emission): config.schema.json gains an optional
 * propertyBased block { enabled (boolean, required), numRuns (positive
 * integer, required), seed? (32-bit integer override) }. The loader validates
 * the whole config against config.schema.json via ajv (code CONFIG_INVALID,
 * field = ajv instancePath), so every propertyBased shape error surfaces as a
 * structured CONFIG_INVALID — no bespoke loader checks needed. A workspace
 * without propertyBased is the v1 default and must stay valid.
 */
describe("loadWorkspace — config validation against the ADR-0017 propertyBased block", () => {
	it("loads a workspace WITHOUT propertyBased as valid (v1 default, backward-compat)", async () => {
		const ws = await seedRichWorkspace("pb0-no-propertybased");

		const context = await loadWorkspace(ws);

		expect(context.isValid).toBe(true);
		expect(
			context.validationErrors.filter((e) => e.code === "CONFIG_INVALID"),
		).toEqual([]);
	});

	it("loads a workspace WITH propertyBased { enabled: true, numRuns: 100 } — no CONFIG_INVALID, block surfaced on config", async () => {
		const ws = await seedRichWorkspace("pb1-enabled-true");
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			propertyBased: { enabled: true, numRuns: 100 },
		});

		const context = await loadWorkspace(ws);

		expect(
			context.validationErrors.filter((e) => e.code === "CONFIG_INVALID"),
		).toEqual([]);
		expect(context.isValid).toBe(true);
		const propertyBased = (
			context.config as unknown as {
				propertyBased?: { enabled: boolean; numRuns: number; seed?: number };
			}
		).propertyBased;
		expect(propertyBased).toEqual({ enabled: true, numRuns: 100 });
	});

	it("loads a workspace WITH propertyBased { enabled: true, numRuns: 100, seed: 12345 } — explicit seed override accepted", async () => {
		const ws = await seedRichWorkspace("pb2-explicit-seed");
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			propertyBased: { enabled: true, numRuns: 100, seed: 12345 },
		});

		const context = await loadWorkspace(ws);

		expect(
			context.validationErrors.filter((e) => e.code === "CONFIG_INVALID"),
		).toEqual([]);
		expect(context.isValid).toBe(true);
		const propertyBased = (
			context.config as unknown as {
				propertyBased?: { enabled: boolean; numRuns: number; seed?: number };
			}
		).propertyBased;
		expect(propertyBased).toEqual({ enabled: true, numRuns: 100, seed: 12345 });
	});

	it.each([
		{
			dir: "pb3-enabled-missing",
			label: "enabled is missing",
			propertyBased: { numRuns: 100 },
			field: "/propertyBased",
		},
		{
			dir: "pb3-numruns-missing",
			label: "numRuns is missing",
			propertyBased: { enabled: true },
			field: "/propertyBased",
		},
		{
			dir: "pb3-enabled-not-boolean",
			label: "enabled is not a boolean",
			propertyBased: { enabled: "yes", numRuns: 100 },
			field: "/propertyBased/enabled",
		},
		{
			dir: "pb3-numruns-not-number",
			label: "numRuns is not a number",
			propertyBased: { enabled: true, numRuns: "many" },
			field: "/propertyBased/numRuns",
		},
		{
			dir: "pb3-numruns-zero",
			label: "numRuns is 0 (not a positive integer)",
			propertyBased: { enabled: true, numRuns: 0 },
			field: "/propertyBased/numRuns",
		},
		{
			dir: "pb3-numruns-negative",
			label: "numRuns is -1",
			propertyBased: { enabled: true, numRuns: -1 },
			field: "/propertyBased/numRuns",
		},
		{
			dir: "pb3-seed-not-number",
			label: "seed is not a number",
			propertyBased: { enabled: true, numRuns: 100, seed: "abc" },
			field: "/propertyBased/seed",
		},
		{
			dir: "pb3-seed-out-of-range",
			label: "seed is out of 32-bit range (2^32)",
			propertyBased: { enabled: true, numRuns: 100, seed: 4294967296 },
			field: "/propertyBased/seed",
		},
		{
			dir: "pb3-unknown-key",
			label: "an unknown key is present inside propertyBased",
			propertyBased: { enabled: true, numRuns: 100, rogueKey: true },
			field: "/propertyBased",
		},
		{
			dir: "pb3-not-object",
			label: "propertyBased is not an object",
			propertyBased: true,
			field: "/propertyBased",
		},
	])(
		"records a structured CONFIG_INVALID error at $field when $label — never throws",
		async ({ dir, propertyBased, field }) => {
			const ws = await seedWorkspace(dir);
			await writeWorkspaceFile(ws, "config.json", {
				...SEEDED_CONFIG,
				propertyBased,
			});
			await writeWorkspaceFile(ws, "contracts.json", contractsFixture());
			await writeWorkspaceFile(ws, "manifests.json", manifestsFixture());

			const load = loadWorkspace(ws);
			await expect(load).resolves.toBeDefined();
			const context = await load;

			expect(context.validationErrors).toContainEqual(
				expect.objectContaining({
					code: "CONFIG_INVALID",
					field,
				}),
			);
			expect(context.isValid).toBe(false);
		},
	);
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
		manifests: {
			svc: { sourceHash: "man-svc", fields: { known: "number" } },
			otherComp: { sourceHash: "man-other", fields: {} },
		},
	};
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
		// ADR-0013 (Phase 3): predicates are inline in contracts.json.
		await writeWorkspaceFile(ws, "contracts.json", {
			predicates: {
				isPositive: {
					source: "Num.isPositive",
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					verifiedPure: true,
				},
			},
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
			manifests: {
				svc: { sourceHash: "man-svc", fields: { total: "number" } },
			},
		});

		const context = await loadWorkspace(ws);

		expect(context.isValid).toBe(true);
		expect(context.validationErrors).toEqual([]);
		// Note: validationWarnings may contain PREDICATE_SOURCE_UNRESOLVED if the
		// predicate source can't be resolved under config.sourceRoots. This test
		// pins that semantic validation is clean (no semantic errors), not that
		// loader warnings are empty.
	});

	it("c: a type mismatch between a clause literal and the manifest-declared field type propagates TYPE_MISMATCH with the clause contractId", async () => {
		const ws = await seedWorkspace("c-type-mismatch");
		await writeWorkspaceFile(ws, "contracts.json", {
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
			manifests: {
				svc: { sourceHash: "man-svc", fields: { balance: "number" } },
			},
		});

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
			manifests: {
				svc: {
					sourceHash: "man-svc",
					fields: {
						inferredField: { type: "number", confidence: "inferred" },
					},
				},
			},
		});

		const context = await loadWorkspace(ws);

		expect(context.validationWarnings).toContainEqual(
			expect.objectContaining({ code: "LOW_CONFIDENCE_FIELD" }),
		);
		expect(context.validationErrors).toEqual([]);
		expect(context.isValid).toBe(true);
	});

	it("f: loader-level CONFIG_INVALID and semantic UNKNOWN_FIELD coexist in validationErrors (append, not replace)", async () => {
		const ws = await seedWorkspace("f-loader-plus-semantic");
		// ADR-0013 (Phase 3): predicates.json is retired. To test that loader-level
		// errors and semantic errors coexist, I use CONFIG_INVALID (invalid testFramework)
		// as the loader-level error and UNKNOWN_FIELD as the semantic error.
		await writeWorkspaceFile(ws, "config.json", {
			...SEEDED_CONFIG,
			testFramework: "jest",
		});
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

		const context = await loadWorkspace(ws);

		expect(context.validationErrors).toContainEqual(
			expect.objectContaining({
				code: "CONFIG_INVALID",
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
 * post-fix outcome contract: a structured INVALID_SHAPE loader error. The
 * tests must genuinely reject today with
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
};

function baseContracts(): ShapeContractFile {
	return {
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
		manifests: {
			Svc: { sourceHash: "man-svc", fields: { total: "number" } },
		},
	};
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
	return ws;
}

describe("loadWorkspace — malformed-shape workspace files never throw (ADR-0010)", () => {
	// ADR-0013 (Phase 3): predicates.json is retired. Only contracts.json and
	// manifests.json are shape-checked at the top level.
	it.each([
		{ file: "contracts.json", value: 42 },
		{ file: "manifests.json", value: "hello" },
	])(
		"records INVALID_SHAPE with field $file when top-level $file is a primitive (C1/C2) — never throws",
		async ({ file, value }) => {
			const overrides: ShapeOverrides = {};
			if (file === "contracts.json") {
				overrides.contracts = value;
			}
			if (file === "manifests.json") {
				overrides.manifests = value;
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

	it("never throws when a manifest typeRef nests 20000 levels deep (F2) — result keeps validationErrors/isValid", async () => {
		// F2: today the validator's recursive parseTypeRef overflows the call
		// stack at depth 20000 (RangeError: Maximum call stack size exceeded).
		// The fix may emit a structured error OR raise/lower the depth guard —
		// pin only never-throws plus the shape of the result.
		const DEPTH = 20000;
		const deepTypeRef = `${"list<".repeat(DEPTH)}number${">".repeat(DEPTH)}`;
		const manifests = {
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
 * robustness fix found three holes the 3.4a fixtures could not reach — none of
 * them mutated `operation.params`. Each test must genuinely reject today with
 * the raw TypeError/RangeError noted in its comment; the assertions below pin
 * the structured outcome the fix must produce (no lazy try/catch can satisfy
 * them).
 *
 * B1 — operation.params non-array / null element: findOperationParam
 *   (src/core/validator.ts) does `operation.params ?? []` then `.find(...)`,
 *   so `params: "x"`, `42`, `{}` → TypeError: params.find is not a function
 *   and `[null]` → TypeError: reading 'name'. (params: null coalesces to [] —
 *   it already passes, so it is not pinned.) Post-fix: a shape-guard check on
 *   operation.params (mirrors the per-entry predicates check) records
 *   INVALID_SHAPE with a field naming the params path.
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

/**
 * sourcePath persistence (VERSAILLES-21 F2, docs/contracts/workspace-context.contract.yaml
 * 2026-08-17): the manifests.json store entry shape now owns sourcePath (string;
 * never empty for covered entries; legacy entries lacking it preserved as-is),
 * and the loader surfaces it on ManifestsFile entries so the generate handler →
 * emitter modulePaths can derive real import paths. These tests pin the loader
 * side of the flow: a stored sourcePath must come back through the loaded
 * context untouched, and a legacy entry without one must load normally without
 * an invented path or an INVALID_SHAPE error. (Runtime pass-through already
 * holds; the fix extends the ManifestsFile TYPE with the optional sourcePath
 * field this contract documents.)
 */
describe("loadWorkspace — surfaces sourcePath on manifests store entries (VERSAILLES-21 F2)", () => {
	it("preserves sourcePath on a manifests store entry exactly as stored — never stripped or defaulted", async () => {
		const ws = await seedWorkspace("sp1-sourcepath-preserved");
		await writeWorkspaceFile(ws, "manifests.json", {
			manifests: {
				Order: {
					sourceHash: "man-order",
					fields: { status: "string" },
					sourcePath: "src/order.ts",
				},
			},
		});

		const context = await loadWorkspace(ws);

		expect(context.isValid).toBe(true);
		expect(context.validationErrors).toEqual([]);
		// The loaded entry carries sourcePath intact — the loader neither
		// strips it nor replaces it with an empty string.
		expect(context.manifests?.manifests.Order).toMatchObject({
			sourceHash: "man-order",
			fields: { status: "string" },
			sourcePath: "src/order.ts",
		});
	});

	it("loads a legacy manifest entry without sourcePath as-is — no INVALID_SHAPE error, no invented path", async () => {
		const ws = await seedWorkspace("sp2-legacy-no-sourcepath");
		await writeWorkspaceFile(ws, "manifests.json", {
			manifests: {
				Legacy: {
					sourceHash: "legacy-hash",
					fields: { note: "string" },
				},
			},
		});

		const context = await loadWorkspace(ws);

		expect(context.isValid).toBe(true);
		expect(context.validationErrors).toEqual([]);
		const legacy = context.manifests?.manifests.Legacy as Record<
			string,
			unknown
		>;
		expect(legacy).toEqual({
			sourceHash: "legacy-hash",
			fields: { note: "string" },
		});
		expect(legacy.sourcePath).toBeUndefined();
	});
});
