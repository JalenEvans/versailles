import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";
import type { ClauseKind, Node } from "../src/core/parser.js";
// The generator core (src/generator/) is implemented; these value imports
// resolve at runtime. The assertions below pin the generator contract the
// implementation must satisfy.
import {
	coverageManifest,
	emitSuite,
	planTestCases,
} from "../src/generator/index.js";
import type {
	CoverageManifest,
	EmitOptions,
	PlannedCase,
	PlannedSuite,
} from "../src/generator/index.js";
import type { LoaderWarning } from "../src/loader/workspace.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../src/loader/workspace.js";

/**
 * Non-silent unplannable-operation warnings (VERSAILLES-25, build-spec §9.1) —
 * pinned against docs/contracts/deterministic-generation.contract.yaml
 * (owns/ensures/must/must_not/assert, 2026-08-18) and
 * docs/specs/deterministic-generation.md ("Planned operations missing from
 * source warn, never emit dead calls").
 *
 * The V-25 bug (E2E-gate finding): a staged contract operation with no
 * matching method in the source manifest (e.g. staged Order.setSubtotal but
 * src/order.ts has no setSubtotal method, so the extracted methods metadata
 * records setTotal but NOT setSubtotal) silently emits the legacy static
 * options-object call `Order.setSubtotal({ amount: 1 })` → TypeError at
 * runtime — dead, unrunnable code with warnings: [].
 *
 * ── Contract reading (the exact condition pinned) ──────────────────────────
 *
 * The contract must_not says: "Must not emit the legacy static options-object
 * call (<Component>.<op>({ ...inputs })) for a planned operation that has no
 * matching method metadata and no resolvable source method — that is dead,
 * unrunnable code; it must surface a non-silent UNPLANNABLE_OPERATION warning
 * instead". The contract assert (line 159) frames the trigger as "a planned
 * operation with no matching method metadata and no resolvable source method
 * (e.g. staged Order.setSubtotal with no such method in the manifest)".
 *
 * "no matching method metadata" is read as: the component's manifest entry
 * CARRIES a `methods` key (we know about this component's source methods) and
 * the planned operation is NOT one of its keys. That absence is the
 * authoritative "no resolvable source method" signal — the extracted methods
 * map is the planner's only source-method knowledge, and an op missing from it
 * cannot be rendered as anything but dead code.
 *
 * Backward-compat reconciliation: a manifest entry with NO `methods` key at
 * all (full-legacy suite predating method metadata, F1) carries zero method
 * information, so "no matching method metadata" is vacuously false — there is
 * no metadata to not-match against. Warning for every op there would break the
 * byte-identical legacy output pinned by tests/generator.test.ts and
 * tests/emitters.test.ts ("keeps the legacy options-object static call when NO
 * methods metadata is present (backward compatible)"). The condition pinned
 * here therefore warns ONLY when the component has a methods map but the op is
 * missing from it, and leaves full-legacy suites silent with their historical
 * default emission.
 *
 * ── Module contract (what these tests require from src/generator/) ────────
 *
 * Same public surface as tests/generator.test.ts:
 *
 * ```ts
 * export declare function planTestCases(context: VersaillesContext): PlannedSuite;
 * export declare function coverageManifest(suite: PlannedSuite): CoverageManifest;
 * export declare function emitSuite(suite, framework, options?): EmittedFile[];
 * ```
 *
 * ── Design decisions these tests pin (documented for the implementer) ─────
 *
 * 1. Warning channel: exactly the F3 seam — the planned suite carries
 *    LoaderWarning { code: "UNPLANNABLE_OPERATION", field: <operation id>,
 *    detail: non-empty } in suite.warnings (same non-blocking tier as
 *    PREDICATE_UNPLANNABLE; the generate handler merges suite.warnings into
 *    CliResult.warnings, exit 0). `field` is the operation's dotted id
 *    ("Order.setSubtotal"), mirroring how PREDICATE_UNPLANNABLE carries the
 *    clause id.
 * 2. Cases skipped (contract can: "May skip emitting an unrenderable
 *    operation's cases (VERSAILLES-25) while still mapping its clause IDs in
 *    coverage.json so the coverage gap remains detectable"): the warned op
 *    contributes NO planned case (id prefix "<Component>.<op>." absent), and
 *    coverage.json maps its clause ids to EMPTY arrays — the existing
 *    zero-coverage representation (build-spec §9.3, pinned in tests/cli.test.ts
 *    W4). The metadata-covered sibling op keeps planning and emitting
 *    shape-aware calls (F1) — only the missing op is skipped.
 * 3. Emitted output: the generated file must not contain any invocation of
 *    the warned operation — no `Order.setSubtotal(` at all, and specifically
 *    no legacy static options-object call `Order.setSubtotal({ ... })`.
 * 4. Negative controls (backward-compat):
 *    a. Component methods metadata covering EVERY staged op → no warning.
 *    b. Component with NO methods key (legacy) → no warning, and the emitted
 *       output keeps the historical options-object call byte-identical.
 * 5. Determinism (ADR-0002): two plan runs over the same context produce
 *    identical suites and identical warnings.
 */

const ORDER = "Order";
const WARNED_OP = "setSubtotal";
const WARNED_OP_ID = "Order.setSubtotal";
const WARNED_CLAUSE = "Order.setSubtotal.pre0";
const COVERED_OP = "setTotal";
const COVERED_OP_ID = "Order.setTotal";

/**
 * Order stages TWO operations — setTotal (present in the manifest methods
 * metadata) and setSubtotal (the V-25 case: staged but missing from the
 * source's methods map). Both have a numeric precondition so both would
 * normally plan §9.1 boundary cases.
 */
function contractsFixture(): ContractsFile {
	return {
		version: "1.0",
		contracts: {
			[ORDER]: {
				invariants: [],
				operations: {
					[COVERED_OP]: {
						id: "Order.setTotal",
						params: [{ name: "amount", type: "number" }],
						preconditions: [{ id: "Order.setTotal.pre0", expr: "amount >= 0" }],
						postconditions: [],
						effects: [],
						sourceHash: "settotal-hash",
					},
					[WARNED_OP]: {
						id: WARNED_OP_ID,
						params: [{ name: "amount", type: "number" }],
						preconditions: [{ id: WARNED_CLAUSE, expr: "amount >= 0" }],
						postconditions: [],
						effects: [],
						sourceHash: "setsubtotal-hash",
					},
				},
			},
		},
	};
}

/**
 * V-25 manifest: the source records Order.setTotal but NOT Order.setSubtotal —
 * the staged operation has no matching method metadata and no resolvable
 * source method.
 */
function methodsMissingOpFixture(): ManifestsFile {
	return {
		version: "1.0",
		manifests: {
			[ORDER]: {
				sourceHash: "man-order",
				fields: { subtotal: "number", total: "number" },
				methods: {
					[COVERED_OP]: {
						static: false,
						params: ["amount"],
						returnType: "number",
					},
				},
			},
		},
	};
}

/** Negative control (a): methods metadata covers every staged op → no warning. */
function methodsCoverAllFixture(): ManifestsFile {
	return {
		version: "1.0",
		manifests: {
			[ORDER]: {
				sourceHash: "man-order",
				fields: { subtotal: "number", total: "number" },
				methods: {
					[COVERED_OP]: {
						static: false,
						params: ["amount"],
						returnType: "number",
					},
					[WARNED_OP]: {
						static: false,
						params: ["amount"],
						returnType: "number",
					},
				},
			},
		},
	};
}

/** Negative control (b): full-legacy entry — no methods key at all. */
function legacyManifestsFixture(): ManifestsFile {
	return {
		version: "1.0",
		manifests: {
			[ORDER]: {
				sourceHash: "man-order",
				fields: { subtotal: "number", total: "number" },
			},
		},
	};
}

function makeConfig(): WorkspaceConfig {
	return {
		grammarVersion: "1.0",
		schemaVersion: "1.0",
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: false },
	};
}

/**
 * Parses every fixture expr with the real parser so the context carries real
 * ASTs in parsedContracts (the shape the loader produces, build-spec §6).
 * Throws only on a fixture-authoring error — never a generator behaviour.
 */
function parseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (clauses: ContractClause[], kind: ClauseKind): void => {
		for (const clause of clauses) {
			const result = parseExpression(clause.expr, kind, clause.id);
			if (!result.ok) {
				throw new Error(
					`fixture parse failed for ${clause.id}: ${JSON.stringify(result.errors)}`,
				);
			}
			parsed[clause.id] = result.ast;
		}
	};
	for (const component of Object.values(contracts.contracts)) {
		walk(component.invariants ?? [], "invariants");
		for (const operation of Object.values(component.operations ?? {})) {
			walk(operation.preconditions ?? [], "preconditions");
			walk(operation.postconditions ?? [], "postconditions");
		}
	}
	return parsed;
}

/**
 * Builds a fully-loaded, isValid VersaillesContext in memory (no files, no
 * loader), mirroring the fixture approach in tests/generator.test.ts.
 */
function makeContext(manifests: ManifestsFile): VersaillesContext {
	const contracts = contractsFixture();
	return {
		config: makeConfig(),
		contracts,
		manifests,
		predicates: { version: "1.0", predicates: {} },
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

function allCases(suite: PlannedSuite): PlannedCase[] {
	return [
		...suite.operations.flatMap((group) => group.cases),
		...suite.invariantCases,
	];
}

/** suite.warnings typed through the planned seam (see generator-predicate.test.ts). */
function suiteWarnings(suite: PlannedSuite): LoaderWarning[] {
	return (
		(suite as PlannedSuite & { warnings?: LoaderWarning[] }).warnings ?? []
	);
}

/**
 * Mirrors deriveMethods (src/cli/handlers/generate.ts): the emitter-options
 * methods map contains a component only when its manifest entry carries a
 * `methods` key — absent for full-legacy entries.
 */
function emitterMethods(manifests: ManifestsFile): EmitOptions["methods"] {
	const methods: EmitOptions["methods"] = {};
	for (const [component, entry] of Object.entries(manifests.manifests)) {
		if (entry.methods !== undefined) {
			methods[component] = entry.methods;
		}
	}
	return methods;
}

describe("planTestCases — UNPLANNABLE_OPERATION for a staged op missing from source method metadata (§9.1, VERSAILLES-25)", () => {
	it("surfaces an UNPLANNABLE_OPERATION warning when the component's methods metadata covers other ops but not the staged op — never silent", () => {
		const suite = planTestCases(makeContext(methodsMissingOpFixture()));

		const warnings = suiteWarnings(suite);
		expect(warnings).toContainEqual(
			expect.objectContaining({
				code: "UNPLANNABLE_OPERATION",
				field: WARNED_OP_ID,
			}),
		);
		const warning = warnings.find((w) => w.field === WARNED_OP_ID);
		expect(warning?.code).toBe("UNPLANNABLE_OPERATION");
		expect(warning?.detail.length).toBeGreaterThan(0);
	});

	it("skips the warned operation's cases — no planned case for the missing op (contract can: skip while keeping the coverage gap detectable)", () => {
		const suite = planTestCases(makeContext(methodsMissingOpFixture()));

		const warnedOpCases = allCases(suite).filter((case_) =>
			case_.id.startsWith(`${WARNED_OP_ID}.`),
		);
		expect(warnedOpCases).toEqual([]);

		// The metadata-covered sibling op keeps planning normally — only the
		// missing op is skipped.
		expect(
			allCases(suite).some((case_) => case_.id.startsWith("Order.setTotal.")),
		).toBe(true);
	});

	it("keeps the warned op's clause ids in coverage.json as a detectable zero-coverage gap (§9.3)", () => {
		const suite = planTestCases(makeContext(methodsMissingOpFixture()));
		const manifest: CoverageManifest = coverageManifest(suite);

		// The clause id stays mapped — as an EMPTY array, the existing
		// zero-coverage representation (build-spec §9.3, W4). The gap is
		// detectable, never hidden.
		expect(manifest.coverage[WARNED_CLAUSE]).toBeDefined();
		expect(manifest.coverage[WARNED_CLAUSE]).toEqual([]);

		// The metadata-covered sibling's clause is genuinely covered.
		expect(manifest.coverage["Order.setTotal.pre0"].length).toBeGreaterThan(0);
	});

	it("never emits the legacy static options-object call for the warned operation — no invocation at all in the generated surface", () => {
		const manifests = methodsMissingOpFixture();
		const suite = planTestCases(makeContext(manifests));
		const files = emitSuite(suite, "vitest", {
			methods: emitterMethods(manifests),
		});
		const order = files.find((file) => file.path.endsWith("Order.test.ts"));
		expect(order).toBeDefined();

		// The V-25 must_not: no static options-object call, and no invocation
		// of the missing op in ANY shape (the case is skipped).
		expect(order?.content).not.toContain(`${WARNED_OP_ID}(`);
		expect(order?.content).not.toContain("setSubtotal({");

		// The metadata-covered sibling still renders shape-aware (F1):
		// instance call with positional params, never an options object.
		expect(order?.content).toContain("new Order().setTotal(");
		expect(order?.content).not.toContain("Order.setTotal({");
	});
});

describe("planTestCases — negative controls: no UNPLANNABLE_OPERATION when metadata covers the op or is absent (backward compat)", () => {
	it("does not warn when the component's methods metadata covers every staged operation", () => {
		const suite = planTestCases(makeContext(methodsCoverAllFixture()));

		expect(suiteWarnings(suite)).toEqual([]);
		// The op is fully plannable — its cases are still planned.
		expect(
			allCases(suite).some((case_) => case_.id.startsWith(`${WARNED_OP_ID}.`)),
		).toBe(true);
	});

	it("legacy backward-compat: a component with NO methods key stays warning-free and keeps the legacy options-object emission byte-identical", () => {
		const suite = planTestCases(makeContext(legacyManifestsFixture()));

		// No warning for a full-legacy suite — "no matching method metadata"
		// is vacuously false when the component carries no methods map at all.
		expect(suiteWarnings(suite)).toEqual([]);
		expect(
			allCases(suite).some((case_) => case_.id.startsWith(`${WARNED_OP_ID}.`)),
		).toBe(true);

		// Byte-identical legacy output: the historical static options-object
		// call with a toBeDefined assertion (existing pins in
		// tests/generator.test.ts and tests/emitters.test.ts depend on this).
		const files = emitSuite(suite, "vitest");
		const order = files.find((file) => file.path.endsWith("Order.test.ts"));
		expect(order).toBeDefined();
		expect(order?.content).toContain("Order.setSubtotal({ amount: 0 })");
		expect(order?.content).toContain("expect(result).toBeDefined()");
	});
});

describe("planTestCases — UNPLANNABLE_OPERATION determinism (ADR-0002)", () => {
	it("two plan runs over the same unplannable-op context produce identical suites and identical warnings", () => {
		const first = planTestCases(makeContext(methodsMissingOpFixture()));
		const second = planTestCases(makeContext(methodsMissingOpFixture()));

		expect(second).toEqual(first);
		expect(suiteWarnings(first)).toContainEqual(
			expect.objectContaining({
				code: "UNPLANNABLE_OPERATION",
				field: WARNED_OP_ID,
			}),
		);
	});
});

// ── W3 (Center review finding): a zero-method component's EMPTY methods map
// must warn for every staged op ─────────────────────────────────────────────
// workspace-context.contract.yaml + manifest-extraction.contract.yaml
// (2026-08-18, VERSAILLES-25 follow-up): the extractor records `methods: {}`
// for a component with no methods (the same always-present shape as fields),
// and the store must PERSIST that empty map — an empty map still KNOWS the
// component has zero methods, so EVERY staged op is missing from it and must
// surface UNPLANNABLE_OPERATION (never a dead static options-object call).
// Only a preserved legacy entry with NO `methods` key stays silent (the
// existing backward-compat pin above).
//
// This suite pins the planner seam: given a context whose component entry
// CARRIES methods: {} (what the loader surfaces once the store write is
// fixed), the planner warns for every staged op. It is the planner-side guard
// for the W3 store-write fix pinned in tests/cli.test.ts; the genuinely Red
// tests for the current implementation are the STORE WRITE (extract.ts drops
// the empty map) and the extract→generate chain — both in tests/cli.test.ts.

/** W3 fixture: a component whose methods map is EMPTY — zero methods known. */
function zeroMethodManifestsFixture(): ManifestsFile {
	return {
		version: "1.0",
		manifests: {
			[ORDER]: {
				sourceHash: "man-order-zero",
				fields: { subtotal: "number", total: "number" },
				methods: {},
			},
		},
	};
}

describe("planTestCases — a component with an EMPTY methods map warns for every staged op (W3, VERSAILLES-25 follow-up)", () => {
	it("surfaces UNPLANNABLE_OPERATION for every staged op when methods is an empty map — never silent, never a dead static call", () => {
		const suite = planTestCases(makeContext(zeroMethodManifestsFixture()));

		// An empty map is authoritative "knows zero methods": BOTH staged ops
		// (setTotal AND setSubtotal) are missing from it → both warn.
		const warnings = suiteWarnings(suite);
		expect(warnings).toContainEqual(
			expect.objectContaining({
				code: "UNPLANNABLE_OPERATION",
				field: WARNED_OP_ID,
			}),
		);
		expect(warnings).toContainEqual(
			expect.objectContaining({
				code: "UNPLANNABLE_OPERATION",
				field: COVERED_OP_ID,
			}),
		);

		// No planned case for any staged op — nothing to emit.
		expect(
			allCases(suite).filter((case_) => case_.id.startsWith("Order.")),
		).toEqual([]);

		// No invocation of either op in ANY emitted surface (must_not).
		const files = emitSuite(suite, "vitest", {
			methods: emitterMethods(zeroMethodManifestsFixture()),
		});
		for (const file of files) {
			expect(file.content).not.toContain(`${COVERED_OP}(`);
			expect(file.content).not.toContain(`${WARNED_OP}(`);
		}
	});
});
