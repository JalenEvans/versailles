import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { ClauseKind, Node } from "../packages/core/src/core/parser.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	PredicatesFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../packages/core/src/loader/workspace.js";
import { renderClausePredicate } from "../packages/engine/src/generator/codegen.js";
import {
	emitSuite,
	planPropertyBlocks,
	planTestCases,
} from "../packages/engine/src/generator/index.js";
import type {
	EmitOptions,
	PlannedSuite,
	PropertyDescriptor,
	PropertyPlan,
} from "../packages/engine/src/generator/index.js";

/**
 * Joint-sampling emitter layouts (VERSAILLES-165) — the byte-pinned contract
 * for the emitter rendering the joint strategies the planner now plans:
 *
 *   1. EQUALITY-MIRROR — a descriptor whose clause is a bothSideFieldRef
 *      equality `p1 == p2` with BOTH operands operation params (Center B1:
 *      the mirror is ONLY for the param-param subset). The mirror TARGET's
 *      ArbitrarySpec carries `mirrorOf: "<source>"`. The mirror is guaranteed
 *      by construction, so:
 *        - ONLY the SOURCE (non-mirror) params get arbitrary declarations.
 *        - The mirror TARGET is rendered INSIDE the fc.property callback as
 *          `const <target> = <source>;` — it is never sampled independently,
 *          never a callback param, never a filter subject, never a record key.
 *        - The equality oracle is NOT filtered (the mirror guarantees it) —
 *          but IS asserted after the call.
 *
 *   2. FIELD-BOUND (Center B1) — a descriptor whose clause is a bothSideFieldRef
 *      equality `p1 == p2` where at least ONE operand is a manifest FIELD (not
 *      an op param — e.g. `status == newStatus` with status a component
 *      field). The planner plans OP-PARAMS ONLY in descriptor.params (no field
 *      source spec, no mirrorOf). The emitter samples only the param
 *      arbitraries, binds the component instance inside the callback, calls
 *      with the params only, and asserts the oracle with the FIELD mapped to
 *      `instance.<field>` — a genuine post-state check, no mirror, no record:
 *        - NO mirror const (`const <field> = <param>;`), NO record, NO filter.
 *        - `const instance = new <Component>();` inside the callback; the call
 *          runs on the bound instance.
 *        - The assertion passes each oracle param the callback value when it is
 *          a callback param, else `instance.<field>`.
 *
 *   3. RECORD + BOUNDED FILTER — a descriptor whose guard oracle is a
 *      multi-param NON-mirror compound (a conjunction of numeric bounds /
 *      literal inequalities / boundable sum-difference couplings). The
 *      derived cross-param bounds (planner propagation) feed per-param record
 *      entries, the joint region is filtered at the RECORD level, and the
 *      callback DESTRUCTURES the record:
 *        - NO per-param arbitrary declarations (they live inline in the
 *          record), NO per-param `.filter(...)`.
 *        - The record filter composes ALL non-mirror guard oracles — each
 *          invoked with the params it references, joined `&&` in guard order.
 *        - Single-param oracles sharing the guard set with a multi-param
 *          non-mirror oracle do NOT get their own per-param filter — they
 *          participate in the composed record filter (the MIXED layout).
 *        - The block asserts its OWN clauses (destructured values).
 *
 * The emitter MUST keep every existing single-param pin green: the per-param
 * `.filter(...)` layout stays when ALL guard oracles are single-param (or the
 * only multi-param oracle is a MIRROR), rejects descriptors stay unchanged
 * (per-param arbitraries, NO filters/oracles), and `fc.assert(prop, { seed,
 * numRuns })` / traceability / determinism / enabled=false semantics are
 * untouched.
 *
 * ── SHIPPED (Center-review fix set) ───────────────────────────────────────
 * The three layouts above are the shipped joint-sampling surface: the
 * equality-mirror renders for param-param equalities, the field-bound layout
 * renders for field-operand equalities (B1), and the record + bounded filter
 * renders for coupled compounds. The planner's B2 (field-operand couplings)
 * / W1 (inverted derived bounds) / W4 (`or`-derived bounds) gates keep
 * unplannable shapes OUT of the descriptor stream, so the emitter never sees
 * a multi-param guard it cannot render — the old belt-and-suspenders throw is
 * no longer the expected path.
 */

// ── Fixture: a concrete suite + a joint property plan (hand-built, mirroring
// what planTestCases + planPropertyBlocks produce for the Chunk 1 planner). ──

const ACCOUNT = "AccountService";
const ORDER = "OrderService";

/**
 * Manifest method metadata threaded through the emitter seam exactly like the
 * generate handler's deriveMethods (VERSAILLES-20 F1). All joint ops are
 * INSTANCE methods with positional params — the pinned layouts' calls render
 * `new <Component>().<op>(<positional>)`.
 */
const JOINT_METHODS: EmitOptions["methods"] = {
	[ACCOUNT]: {
		setStatus: {
			static: false,
			params: ["status", "newStatus"],
			returnType: "boolean",
		},
	},
	[ORDER]: {
		placeOrder: { static: false, params: ["a", "b"], returnType: "number" },
		shipOrder: { static: false, params: ["a", "b"], returnType: "number" },
	},
};

/** A concrete PlannedSuite (the Phase-1/2 output shape, hand-built). */
function jointSuite(): PlannedSuite {
	return {
		clauseIds: [
			`${ACCOUNT}.setStatus.post0`,
			`${ORDER}.placeOrder.pre0`,
			`${ORDER}.shipOrder.pre0`,
			`${ORDER}.shipOrder.pre1`,
		],
		operations: [
			{
				component: ACCOUNT,
				operation: "setStatus",
				cases: [
					{
						id: `${ACCOUNT}.setStatus.postcondition-satisfaction-0`,
						kind: "postcondition-satisfaction",
						description:
							"valid input asserting postconditions AccountService.setStatus.post0",
						inputs: { status: "initial", newStatus: "initial" },
						expects: {
							outcome: "accept",
							postconditions: [`${ACCOUNT}.setStatus.post0`],
						},
						traces: [`${ACCOUNT}.setStatus.post0`],
					},
				],
			},
			{
				component: ORDER,
				operation: "placeOrder",
				cases: [
					{
						id: `${ORDER}.placeOrder.boundary-0`,
						kind: "boundary",
						description:
							"boundary-1 (reject): a=-1 falsifies OrderService.placeOrder.pre0",
						inputs: { a: -1, b: 0 },
						expects: { outcome: "reject", rejectionIdiom: "throws" },
						traces: [`${ORDER}.placeOrder.pre0`],
					},
				],
			},
			{
				component: ORDER,
				operation: "shipOrder",
				cases: [
					{
						id: `${ORDER}.shipOrder.boundary-0`,
						kind: "boundary",
						description:
							"boundary-1 (reject): a=-1 falsifies OrderService.shipOrder.pre0",
						inputs: { a: -1, b: 1 },
						expects: { outcome: "reject", rejectionIdiom: "throws" },
						traces: [`${ORDER}.shipOrder.pre0`],
					},
				],
			},
		],
		invariantCases: [],
	};
}

/**
 * The rejects descriptor under joint sampling — UNCHANGED from the current
 * emitter: per-param arbitraries, NO filters, NO oracle consts, the configured
 * ADR-0007 idiom. Extracted so the stability pin below can emit a rejects-only
 * plan (the full joint plan today throws on the mirror/record layouts before
 * the rejects block renders — the rejects pin must isolate the rejects path).
 */
const JOINT_REJECTS_DESCRIPTOR: PropertyDescriptor = {
	id: `${ORDER}.placeOrder.property-rejects-0`,
	component: ORDER,
	operation: "placeOrder",
	params: [
		{
			param: "a",
			typeRef: "number",
			kind: "number",
			bounds: { min: 0, max: 9 },
		},
		{
			param: "b",
			typeRef: "number",
			kind: "number",
			bounds: { min: 0, max: 9 },
		},
	],
	clauses: [
		{
			clauseId: `${ORDER}.placeOrder.pre0`,
			code: "(a) => a >= 10",
		},
	],
	outcome: "rejects",
	rejectionIdiom: "throws",
	traces: [`${ORDER}.placeOrder.pre0`],
	seed: 42,
};

/**
 * The FIELD-BOUND descriptor (Center B1): a bothSideFieldRef equality
 * postcondition `status == newStatus` where `status` is a MANIFEST FIELD (the
 * only operation param is newStatus — the accountPbtContext fixture shape).
 * The planner plans OP-PARAMS ONLY: descriptor.params = [newStatus], NO field
 * source spec, NO mirrorOf. The emitter renders the field-bound layout — no
 * mirror const, no record, no filter; the assertion maps the field to
 * `instance.status` after the call.
 */
const FIELD_BOUND_DESCRIPTOR: PropertyDescriptor = {
	id: `${ACCOUNT}.setStatus.property-satisfies-0`,
	component: ACCOUNT,
	operation: "setStatus",
	params: [{ param: "newStatus", typeRef: "string", kind: "string" }],
	clauses: [
		{
			clauseId: `${ACCOUNT}.setStatus.post0`,
			code: "(status, newStatus) => status === newStatus",
		},
	],
	outcome: "satisfies",
	traces: [`${ACCOUNT}.setStatus.post0`],
	seed: 777,
};

/**
 * The full emitSuite options for the FIELD-BOUND descriptor — setStatus is an
 * INSTANCE method with the SINGLE op param newStatus (status is manifest
 * state, never an op param), matching the planner's field-bound wiring.
 */
function fieldBoundOptions(overrides: Partial<EmitOptions> = {}): EmitOptions {
	return {
		methods: {
			[ACCOUNT]: {
				setStatus: {
					static: false,
					params: ["newStatus"],
					returnType: "boolean",
				},
			},
		},
		propertyPlan: {
			descriptors: [FIELD_BOUND_DESCRIPTOR],
			strategies: {},
			warnings: [],
		},
		propertyNumRuns: 100,
		...overrides,
	};
}

function emitFieldBound(overrides: Partial<EmitOptions> = {}) {
	return emitSuite(jointSuite(), "vitest", fieldBoundOptions(overrides));
}

/**
 * The joint property plan the implementer's emitter must render. Order
 * mirrors the planner's deterministic per-operation traversal (preconditions
 * satisfies → postconditions satisfies → expected-rejection rejects, per
 * operation in component order).
 */
function jointPlan(): PropertyPlan {
	return {
		descriptors: [
			{
				// Equality-mirror (VERSAILLES-165): a bothSideFieldRef equality
				// postcondition. The mirror TARGET's spec carries
				// mirrorOf: "status" and NO independent arbitrary (bounds/
				// default stripped by buildMirrorParams); the SOURCE spec
				// precedes it in descriptor.params.
				id: `${ACCOUNT}.setStatus.property-satisfies-0`,
				component: ACCOUNT,
				operation: "setStatus",
				params: [
					{ param: "status", typeRef: "string", kind: "string" },
					{
						param: "newStatus",
						typeRef: "string",
						kind: "string",
						mirrorOf: "status",
					},
				],
				clauses: [
					{
						clauseId: `${ACCOUNT}.setStatus.post0`,
						code: "(status, newStatus) => status === newStatus",
					},
				],
				outcome: "satisfies",
				traces: [`${ACCOUNT}.setStatus.post0`],
				seed: 777,
			},
			{
				// Record + bounded filter: the coupled compound
				// `a >= 0 and b >= 0 and a + b <= 100`. Chunk 1 propagation
				// derives the cross-param bounds {0, 100} on BOTH params (the
				// probe of the real planner: lower[a]=lower[b]=0 from the
				// bounds, then a+b<=100 → upper[a]=100, upper[b]=100).
				id: `${ORDER}.placeOrder.property-satisfies-0`,
				component: ORDER,
				operation: "placeOrder",
				params: [
					{
						param: "a",
						typeRef: "number",
						kind: "number",
						bounds: { min: 0, max: 100 },
					},
					{
						param: "b",
						typeRef: "number",
						kind: "number",
						bounds: { min: 0, max: 100 },
					},
				],
				clauses: [
					{
						clauseId: `${ORDER}.placeOrder.pre0`,
						code: "(a, b) => a >= 0 && b >= 0 && a + b <= 100",
					},
				],
				outcome: "satisfies",
				traces: [`${ORDER}.placeOrder.pre0`],
				seed: 808,
			},
			{
				// Rejects under joint sampling stay UNCHANGED — per-param
				// arbitraries, NO filters, NO oracle consts, the configured
				// ADR-0007 idiom. (Stability pin: this block renders today.)
				...JOINT_REJECTS_DESCRIPTOR,
			},
			{
				// MIXED guard set — the operation carries BOTH a multi-param
				// non-mirror oracle (pre0) and a single-param compound (pre1).
				// Chunk 1 propagation: pre1's `b >= 1` raises lower[b] to 1, so
				// the coupling `a + b <= 100` derives upper[a] = 99 — the
				// record entries carry the derived bounds {0, 99} / {1, 100}.
				id: `${ORDER}.shipOrder.property-satisfies-0`,
				component: ORDER,
				operation: "shipOrder",
				params: [
					{
						param: "a",
						typeRef: "number",
						kind: "number",
						bounds: { min: 0, max: 99 },
					},
					{
						param: "b",
						typeRef: "number",
						kind: "number",
						bounds: { min: 1, max: 100 },
					},
				],
				clauses: [
					{
						clauseId: `${ORDER}.shipOrder.pre0`,
						code: "(a, b) => a >= 0 && b >= 0 && a + b <= 100",
					},
				],
				outcome: "satisfies",
				traces: [`${ORDER}.shipOrder.pre0`],
				seed: 909,
			},
			{
				// The SINGLE-param sibling. The record layout still applies:
				// the multi-param NON-mirror pre0 is in this block's guard set,
				// so "record layout triggers when ANY guard oracle is
				// multi-param AND non-mirror". pre1 gets NO individual
				// `.filter(...)` — it participates in the composed record
				// filter `pre0(a, b) && pre1(b)`. The block asserts its OWN
				// clause (pre1).
				id: `${ORDER}.shipOrder.property-satisfies-1`,
				component: ORDER,
				operation: "shipOrder",
				params: [
					{
						param: "a",
						typeRef: "number",
						kind: "number",
						bounds: { min: 0, max: 99 },
					},
					{
						param: "b",
						typeRef: "number",
						kind: "number",
						bounds: { min: 1, max: 100 },
					},
				],
				clauses: [
					{
						clauseId: `${ORDER}.shipOrder.pre1`,
						code: "(b) => b >= 1 && b <= 100",
					},
				],
				outcome: "satisfies",
				traces: [`${ORDER}.shipOrder.pre1`],
				seed: 111,
			},
		],
		strategies: {},
		warnings: [],
	};
}

/** The full emitSuite options the enabled=true joint pins pass. */
function jointOptions(overrides: Partial<EmitOptions> = {}): EmitOptions {
	return {
		methods: JOINT_METHODS,
		propertyPlan: jointPlan(),
		propertyNumRuns: 100,
		...overrides,
	};
}

function emitJoint(overrides: Partial<EmitOptions> = {}) {
	return emitSuite(jointSuite(), "vitest", jointOptions(overrides));
}

function accountFile(files: ReturnType<typeof emitSuite>) {
	return files.find((file) => file.path.endsWith("AccountService.test.ts"));
}

function orderFile(files: ReturnType<typeof emitSuite>) {
	return files.find((file) => file.path.endsWith("OrderService.test.ts"));
}

describe("emitSuite vitest — joint-sampling property layouts (VERSAILLES-165, shipped)", () => {
	it("enabled=false backward-compat pin: the joint suite with no propertyPlan (or empty plan) is byte-identical to the no-plan baseline — no fast-check surface", () => {
		const suite = jointSuite();
		const baseline = emitSuite(suite, "vitest");
		expect(baseline.length).toBeGreaterThan(0);
		// No plan → byte-identical (the emitter ignores the absent plan).
		expect(emitSuite(suite, "vitest", {})).toEqual(baseline);
		// Empty plan → byte-identical (no descriptors ⇒ no property blocks).
		const emptyPlan: PropertyPlan = {
			descriptors: [],
			strategies: {},
			warnings: [],
		};
		expect(emitSuite(suite, "vitest", { propertyPlan: emptyPlan })).toEqual(
			baseline,
		);
		// The disabled output has no PBT surface at all.
		for (const file of baseline) {
			expect(file.content).not.toContain("fast-check");
			expect(file.content).not.toContain("fc.assert");
			expect(file.content).not.toContain("fc.");
		}
	});

	it("byte-pins the EQUALITY-MIRROR layout — only the source arbitrary, `const newStatus = status;` in the callback, oracle asserted not filtered", () => {
		const files = emitJoint();
		const account = accountFile(files);
		expect(account).toBeDefined();

		const block = [
			'\t// traces: "AccountService.setStatus.post0"',
			'\tit("AccountService.setStatus.property-satisfies-0", () => {',
			"\t\tconst status = fc.string();",
			"\t\tconst AccountService_setStatus_post0 = (status: string, newStatus: string) => status === newStatus;",
			"\t\tconst prop = fc.property(status, (status) => {",
			"\t\t\tconst newStatus = status;",
			"\t\t\tnew AccountService().setStatus(status, newStatus);",
			"\t\t\texpect(AccountService_setStatus_post0(status, newStatus)).toBe(true);",
			"\t\t});",
			"\t\tfc.assert(prop, { seed: 777, numRuns: 100 });",
			"\t});",
			"",
		].join("\n");
		expect(account?.content).toContain(block);
	});

	it("byte-pins the FIELD-BOUND layout (Center B1) — only the op-param arbitrary, the component instance bound, the field mapped to instance.status in the assertion, no mirror/record/filter", () => {
		const files = emitFieldBound();
		const account = accountFile(files);
		expect(account).toBeDefined();

		const block = [
			'\t// traces: "AccountService.setStatus.post0"',
			'\tit("AccountService.setStatus.property-satisfies-0", () => {',
			"\t\tconst newStatus = fc.string();",
			// status is a MANIFEST FIELD (not an op param) — with no field model
			// in this fixture its lambda param stays untyped; the op param
			// newStatus is typed unconditionally (ADR-0021).
			"\t\tconst AccountService_setStatus_post0 = (status, newStatus: string) => status === newStatus;",
			"\t\tconst prop = fc.property(newStatus, (newStatus) => {",
			"\t\t\tconst instance = new AccountService();",
			"\t\t\tinstance.setStatus(newStatus);",
			"\t\t\texpect(AccountService_setStatus_post0(instance.status, newStatus)).toBe(true);",
			"\t\t});",
			"\t\tfc.assert(prop, { seed: 777, numRuns: 100 });",
			"\t});",
			"",
		].join("\n");
		expect(account?.content).toContain(block);
	});

	it("rendering-rule pins for the FIELD-BOUND layout: the manifest field is never sampled/mirrored/recorded, no record, no filter, no mirror const (Center B1)", () => {
		const files = emitFieldBound();
		const account = accountFile(files);
		expect(account).toBeDefined();

		// The field `status` is NEVER declared as an arbitrary, NEVER mirrored
		// (`const status = newStatus;`), NEVER a record key, NEVER filtered.
		expect(account?.content).not.toContain("const status = fc.string();");
		expect(account?.content).not.toContain("\t\t\tconst status = newStatus;");
		expect(account?.content).not.toContain("status.filter(");
		expect(account?.content).not.toContain("status:");
		// No record layout, no record filter for the field-bound block.
		expect(account?.content).not.toContain("fc.record(");
		expect(account?.content).not.toContain(".filter(({");
		// The call runs on the bound instance with the op param only.
		expect(account?.content).toContain("instance.setStatus(newStatus);");
		// The assertion maps the field to the bound instance's state.
		expect(account?.content).toContain(
			"expect(AccountService_setStatus_post0(instance.status, newStatus)).toBe(true);",
		);
	});

	it("byte-pins the RECORD + BOUNDED FILTER layout — fc.record over the derived joint bounds, record-level filter, destructured callback", () => {
		const files = emitJoint();
		const order = orderFile(files);
		expect(order).toBeDefined();

		const block = [
			'\t// traces: "OrderService.placeOrder.pre0"',
			'\tit("OrderService.placeOrder.property-satisfies-0", () => {',
			"\t\tconst OrderService_placeOrder_pre0 = (a: number, b: number) => a >= 0 && b >= 0 && a + b <= 100;",
			"\t\tconst prop = fc.property(",
			"\t\t\tfc.record({ a: fc.integer({ min: 0, max: 100 }), b: fc.integer({ min: 0, max: 100 }) })",
			"\t\t\t\t.filter(({ a, b }) => OrderService_placeOrder_pre0(a, b)),",
			"\t\t\t({ a, b }) => {",
			"\t\t\t\tnew OrderService().placeOrder(a, b);",
			"\t\t\t\texpect(OrderService_placeOrder_pre0(a, b)).toBe(true);",
			"\t\t\t}",
			"\t\t);",
			"\t\tfc.assert(prop, { seed: 808, numRuns: 100 });",
			"\t});",
			"",
		].join("\n");
		expect(order?.content).toContain(block);
	});

	it("byte-pins the MIXED guard-set layout — the single-param sibling STILL renders the record layout (the multi-param non-mirror pre0 is in its guard set) with the COMPOSED filter", () => {
		const files = emitJoint();
		const order = orderFile(files);
		expect(order).toBeDefined();

		// pre0's block: multi-param oracle, composed filter pre0 && pre1,
		// asserts pre0. The record entries carry the cross-param-derived
		// bounds a {0, 99}, b {1, 100}.
		const pre0Block = [
			'\t// traces: "OrderService.shipOrder.pre0"',
			'\tit("OrderService.shipOrder.property-satisfies-0", () => {',
			"\t\tconst OrderService_shipOrder_pre0 = (a: number, b: number) => a >= 0 && b >= 0 && a + b <= 100;",
			"\t\tconst OrderService_shipOrder_pre1 = (b: number) => b >= 1 && b <= 100;",
			"\t\tconst prop = fc.property(",
			"\t\t\tfc.record({ a: fc.integer({ min: 0, max: 99 }), b: fc.integer({ min: 1, max: 100 }) })",
			"\t\t\t\t.filter(({ a, b }) => OrderService_shipOrder_pre0(a, b) && OrderService_shipOrder_pre1(b)),",
			"\t\t\t({ a, b }) => {",
			"\t\t\t\tnew OrderService().shipOrder(a, b);",
			"\t\t\t\texpect(OrderService_shipOrder_pre0(a, b)).toBe(true);",
			"\t\t\t}",
			"\t\t);",
			"\t\tfc.assert(prop, { seed: 909, numRuns: 100 });",
			"\t});",
			"",
		].join("\n");
		expect(order?.content).toContain(pre0Block);

		// pre1's block: SINGLE-param oracle, but the guard set contains the
		// multi-param non-mirror pre0 → the record layout applies. pre1 gets
		// NO individual .filter(...) — it is composed into the record filter
		// (invoked with the params it references, `pre1(b)`); the block
		// asserts its OWN clause.
		const pre1Block = [
			'\t// traces: "OrderService.shipOrder.pre1"',
			'\tit("OrderService.shipOrder.property-satisfies-1", () => {',
			"\t\tconst OrderService_shipOrder_pre0 = (a: number, b: number) => a >= 0 && b >= 0 && a + b <= 100;",
			"\t\tconst OrderService_shipOrder_pre1 = (b: number) => b >= 1 && b <= 100;",
			"\t\tconst prop = fc.property(",
			"\t\t\tfc.record({ a: fc.integer({ min: 0, max: 99 }), b: fc.integer({ min: 1, max: 100 }) })",
			"\t\t\t\t.filter(({ a, b }) => OrderService_shipOrder_pre0(a, b) && OrderService_shipOrder_pre1(b)),",
			"\t\t\t({ a, b }) => {",
			"\t\t\t\tnew OrderService().shipOrder(a, b);",
			"\t\t\t\texpect(OrderService_shipOrder_pre1(b)).toBe(true);",
			"\t\t\t}",
			"\t\t);",
			"\t\tfc.assert(prop, { seed: 111, numRuns: 100 });",
			"\t});",
			"",
		].join("\n");
		expect(order?.content).toContain(pre1Block);
	});

	it("rendering-rule pins: mirror target is never declared/filtered/recorded, mirror-satisfied oracle never filters, record blocks carry no per-param declarations or per-param filters", () => {
		const files = emitJoint();
		const account = accountFile(files);
		const order = orderFile(files);
		expect(account).toBeDefined();
		expect(order).toBeDefined();

		// Mirror target: NO independent arbitrary declaration.
		expect(account?.content).not.toContain("const newStatus = fc.string();");
		// Mirror target: never filtered, never a record key. (ADR-0021: the
		// mirror oracle's op-param lambda params are now typed — `(status:
		// string, newStatus: string)` — so the "newStatus:" substring appears
		// in the type annotation; the record-key intent is covered by the
		// fc.record( and newStatus.filter( pins above.)
		expect(account?.content).not.toContain("newStatus.filter(");
		expect(account?.content).not.toContain("newStatus: fc.");
		// Mirror-satisfied oracle: never a filter — the source passes bare.
		expect(account?.content).not.toContain("status.filter(");
		// The mirror block is not a record layout.
		expect(account?.content).not.toContain("fc.record(");

		// Record layout: no per-param arbitrary declarations for the record
		// bounds (the rejects block's {0, 9} declarations are a different
		// string — see the rejects pin below).
		expect(order?.content).not.toContain(
			"const a = fc.integer({ min: 0, max: 100 });",
		);
		expect(order?.content).not.toContain(
			"const b = fc.integer({ min: 0, max: 100 });",
		);
		expect(order?.content).not.toContain(
			"const a = fc.integer({ min: 0, max: 99 });",
		);
		expect(order?.content).not.toContain(
			"const b = fc.integer({ min: 1, max: 100 });",
		);
		// Record layout: no per-param filters anywhere.
		expect(order?.content).not.toContain("a.filter(");
		expect(order?.content).not.toContain("b.filter(");
	});

	it("rejects descriptors stay UNCHANGED under joint sampling — per-param arbitraries, NO filters, NO oracle consts, the configured throws idiom (stability pin)", () => {
		// Emit a REJECTS-ONLY plan so this pin isolates the rejects path from
		// the joint layouts (which the mirror/record/field-bound pins exercise
		// separately). Rejects must render byte-identically.
		const rejectsPlan: PropertyPlan = {
			descriptors: [JOINT_REJECTS_DESCRIPTOR],
			strategies: {},
			warnings: [],
		};
		const files = emitSuite(jointSuite(), "vitest", {
			methods: JOINT_METHODS,
			propertyPlan: rejectsPlan,
			propertyNumRuns: 100,
		});
		const order = orderFile(files);
		expect(order).toBeDefined();

		const block = [
			'\t// traces: "OrderService.placeOrder.pre0"',
			'\tit("OrderService.placeOrder.property-rejects-0", () => {',
			"\t\tconst a = fc.integer({ min: 0, max: 9 });",
			"\t\tconst b = fc.integer({ min: 0, max: 9 });",
			"\t\tconst prop = fc.property(a, b, (a, b) => {",
			"\t\t\texpect(() => new OrderService().placeOrder(a, b)).toThrow();",
			"\t\t});",
			"\t\tfc.assert(prop, { seed: 42, numRuns: 100 });",
			"\t});",
			"",
		].join("\n");
		expect(order?.content).toContain(block);
		// The rejects clause oracle is never embedded as a dead const.
		// ADR-0021: a dead const would carry the typed op-param head
		// `(a: number) => a >= 10` — the negative pin checks the typed form.
		expect(order?.content).not.toContain("(a: number) => a >= 10");
		// The rejects block has no filter surface.
		expect(order?.content).not.toContain(
			"fc.record({ a: fc.integer({ min: 0, max: 9 })",
		);
	});

	it("fc.assert options unchanged across the joint layouts — descriptor seeds + configured numRuns render exactly (space after the comma)", () => {
		const files = emitJoint({ propertyNumRuns: 250 });
		const account = accountFile(files);
		const order = orderFile(files);
		expect(account).toBeDefined();
		expect(order).toBeDefined();

		expect(account?.content).toContain(
			"fc.assert(prop, { seed: 777, numRuns: 250 });",
		);
		expect(order?.content).toContain(
			"fc.assert(prop, { seed: 808, numRuns: 250 });",
		);
		expect(order?.content).toContain(
			"fc.assert(prop, { seed: 42, numRuns: 250 });",
		);
		expect(order?.content).toContain(
			"fc.assert(prop, { seed: 909, numRuns: 250 });",
		);
		expect(order?.content).toContain(
			"fc.assert(prop, { seed: 111, numRuns: 250 });",
		);

		// Default 100 when propertyNumRuns is absent (build-spec §9.6).
		const defaulted = emitJoint({ propertyNumRuns: undefined });
		const orderDefaulted = orderFile(defaulted);
		expect(orderDefaulted?.content).toContain(
			"fc.assert(prop, { seed: 808, numRuns: 100 });",
		);
	});

	it("determinism: same joint suite + same joint plan → byte-identical emitted files (ADR-0002)", () => {
		const first = emitJoint();
		const second = emitJoint();
		expect(second).toEqual(first);
		expect(second.map((file) => file.content)).toEqual(
			first.map((file) => file.content),
		);
	});

	it("mixed guard set (field-bound equality + mirror sibling): the field-bound descriptor IS emitted with the field-bound layout and the mirror sibling is a warning — the emitter NEVER crashes (Center re-review reachable crash)", async () => {
		// The REAL pipeline, not a hand-built plan: planTestCases →
		// planPropertyBlocks → emitSuite. The operation merge(a, b) carries
		// pre0 `f == a` (f a manifest field — field-bound, PLANNED) and pre1
		// `a == b` (param-param mirror). The mirror descriptor's layout would
		// need to filter with the field-referencing sibling `f == a`, and a
		// field can never be destructured from the record — the record filter
		// comes out EMPTY and the emitter throws ("empty record filter", the
		// reachable crash). The ratified fix: the field-bound descriptor stays
		// planned, the mirror is a PROPERTY_UNPLANNABLE warning, and the emit
		// succeeds.
		const ctx = execMixedContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		// Planner pin: the mirror sibling is a warning; the field-bound clause
		// is NOT.
		const mirrorWarning = plan.warnings.find(
			(w) => w.field === "MergeService.merge.pre1",
		);
		expect(mirrorWarning).toBeDefined();
		expect(mirrorWarning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(mirrorWarning?.detail.length).toBeGreaterThan(0);
		expect(
			plan.warnings.some((w) => w.field === "MergeService.merge.pre0"),
		).toBe(false);

		// Emit must NOT crash, and the field-bound block must render.
		const files = emitSuite(suite, "vitest", {
			methods: {
				MergeService: {
					merge: {
						static: false,
						params: ["a", "b"],
						returnType: "number",
					},
				},
			},
			propertyPlan: plan,
			propertyNumRuns: 100,
		});
		const merge = files.find((file) =>
			file.path.endsWith("MergeService.test.ts"),
		);
		expect(merge).toBeDefined();

		// The field-bound descriptor IS emitted — op-param arbitraries only,
		// the component instance bound, the field mapped to instance.f in the
		// assertion, no mirror const, no record, no filter.
		expect(merge?.content).toContain(
			'\tit("MergeService.merge.property-satisfies-0", () => {',
		);
		expect(merge?.content).toContain("const a = fc.string();");
		expect(merge?.content).toContain("const b = fc.string();");
		expect(merge?.content).toContain(
			"const MergeService_merge_pre0 = (f, a: string) => f === a;",
		);
		expect(merge?.content).toContain(
			"const prop = fc.property(a, b, (a, b) => {",
		);
		expect(merge?.content).toContain(
			"\t\t\tconst instance = new MergeService();",
		);
		expect(merge?.content).toContain("instance.merge(a, b);");
		expect(merge?.content).toContain(
			"expect(MergeService_merge_pre0(instance.f, a)).toBe(true);",
		);

		// The mirror sibling is NOT emitted — no mirror block, no mirror const,
		// no record/filter surface for it.
		expect(merge?.content).not.toContain(
			'"MergeService.merge.property-satisfies-1"',
		);
		expect(merge?.content).not.toContain(
			"const MergeService_merge_pre1 = (a: string, b: string) => a === b;",
		);
		expect(merge?.content).not.toContain("fc.record(");
	});
});

// ── Fixture type shape self-check (keeps the hand-built IR honest) ─────────
// These asserts freeze the joint fixture so a Chunk 1/3 IR reshape fails HERE
// instead of silently testing a stale shape.

describe("emitters-pbt-joint fixture integrity", () => {
	it("the equality-mirror descriptor carries mirrorOf on the TARGET only, with the SOURCE spec first", () => {
		const mirror = jointPlan().descriptors.find(
			(descriptor) => descriptor.operation === "setStatus",
		);
		expect(mirror).toBeDefined();
		expect(mirror?.params.map((spec) => spec.param)).toEqual([
			"status",
			"newStatus",
		]);
		expect(mirror?.params[0].mirrorOf).toBeUndefined();
		expect(mirror?.params[1].mirrorOf).toBe("status");
		// The mirror oracle is the 2-param codegen'd equality.
		expect(mirror?.clauses[0].code).toBe(
			"(status, newStatus) => status === newStatus",
		);
	});

	it("the record descriptor carries the derived cross-param bounds the Chunk 1 planner produces ({0, 100} on both)", () => {
		const record = jointPlan().descriptors.find(
			(descriptor) =>
				descriptor.operation === "placeOrder" &&
				descriptor.outcome === "satisfies",
		);
		expect(record).toBeDefined();
		expect(record?.params).toEqual([
			{
				param: "a",
				typeRef: "number",
				kind: "number",
				bounds: { min: 0, max: 100 },
			},
			{
				param: "b",
				typeRef: "number",
				kind: "number",
				bounds: { min: 0, max: 100 },
			},
		]);
	});

	it("the mixed descriptors carry the cross-param-derived bounds ({0, 99} / {1, 100}) the Chunk 1 planner produces when pre1 raises b's lower bound", () => {
		const ship = jointPlan().descriptors.filter(
			(descriptor) => descriptor.operation === "shipOrder",
		);
		expect(ship).toHaveLength(2);
		for (const descriptor of ship) {
			expect(descriptor.params).toEqual([
				{
					param: "a",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 99 },
				},
				{
					param: "b",
					typeRef: "number",
					kind: "number",
					bounds: { min: 1, max: 100 },
				},
			]);
		}
		// The guard set really mixes a 2-param oracle and a 1-param oracle.
		expect(
			ship.some((d) => d.clauses.some((c) => c.code.includes("(a, b) =>"))),
		).toBe(true);
		expect(
			ship.some((d) => d.clauses.some((c) => c.code.includes("(b) =>"))),
		).toBe(true);
	});
});

// ── W1 (extended): real-runner execution gates for the joint layouts ───────
// The Chunk 1 W1 gate in emitters-pbt.test.ts proves the SINGLE-param layout
// runs and that a RETAINED-unplannable multi-param descriptor is never emitted
// as a filter. These gates extend W1 to the joint strategies: the emitted
// equality-mirror block, the emitted FIELD-BOUND block (Center B1 — a genuine
// post-state check: the field is read off the bound instance after the call),
// and the emitted record + bounded-filter block must EXECUTE green under the
// REAL vitest runner — exit 0, no hang, no "too many pre-conditions" (the
// derived bounds make the record's valid region healthy, unlike a naive filter
// over an unbounded joint domain).

const EXEC_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXEC_EMPTY_MANIFESTS: ManifestsFile = { manifests: {} };
const EXEC_EMPTY_PREDICATES: PredicatesFile = {
	predicates: {},
};

function execConfig(
	propertyBased: WorkspaceConfig["propertyBased"],
): WorkspaceConfig {
	return {
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: false },
		propertyBased,
	};
}

/** Parses every fixture expr with the real parser (loader-shaped context). */
function execParseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (clauses: ContractClause[], kind: ClauseKind): void => {
		for (const clause of clauses) {
			const result = parseExpression(clause.expr, kind, clause.id);
			if ("errors" in result) {
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

function execContext(
	contracts: ContractsFile,
	propertyBased: WorkspaceConfig["propertyBased"],
	manifests: ManifestsFile = EXEC_EMPTY_MANIFESTS,
): VersaillesContext {
	return {
		config: execConfig(propertyBased),
		contracts,
		manifests,
		predicates: EXEC_EMPTY_PREDICATES,
		parsedContracts: execParseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

/**
 * The equality-mirror contract: a bothSideFieldRef equality postcondition
 * `status == newStatus` with BOTH operands operation params — the planner
 * wires the mirror (descriptor params [status, newStatus mirrorOf: "status"],
 * oracle `(status, newStatus) => status === newStatus`).
 */
function execMirrorContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			AccountService: {
				invariants: [],
				operations: {
					setStatus: {
						id: "AccountService.setStatus",
						params: [
							{ name: "status", type: "string" },
							{ name: "newStatus", type: "string" },
						],
						preconditions: [],
						postconditions: [
							{
								id: "AccountService.setStatus.post0",
								expr: "status == newStatus",
							},
						],
						effects: [],
						sourceHash: "exec-mirror-hash",
					},
				},
			},
		},
	};
	return execContext(contracts, { enabled: true, numRuns: 100 });
}

/**
 * The FIELD-BOUND contract (Center B1): a bothSideFieldRef equality
 * postcondition `status == newStatus` where `status` is a MANIFEST FIELD (the
 * only operation param is newStatus). The planner plans OP-PARAMS ONLY —
 * descriptor params [newStatus], no mirrorOf, no field source spec — and the
 * emitter renders the field-bound layout; the field is read off the bound
 * instance (`instance.status`) AFTER the call, so the property is a genuine
 * post-state check.
 */
function execFieldBoundContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			AccountService: {
				invariants: [],
				operations: {
					setStatus: {
						id: "AccountService.setStatus",
						params: [{ name: "newStatus", type: "string" }],
						preconditions: [],
						postconditions: [
							{
								id: "AccountService.setStatus.post0",
								expr: "status == newStatus",
							},
						],
						effects: [{ field: "status", kind: "mutate" }],
						sourceHash: "exec-fieldbound-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			AccountService: {
				sourceHash: "man-exec-fieldbound",
				fields: { status: "string" },
			},
		},
	};
	return execContext(contracts, { enabled: true, numRuns: 100 }, manifests);
}

/**
 * The record + bounded filter contract: the coupled compound
 * `a >= 0 and b >= 0 and a + b <= 100` — the Chunk 1 planner derives the
 * cross-param bounds {0, 100} on both params and routes the clause to the
 * record + bounded filter strategy (the real probe).
 */
function execRecordContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					placeOrder: {
						id: "OrderService.placeOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{
								id: "OrderService.placeOrder.pre0",
								expr: "a >= 0 and b >= 0 and a + b <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "exec-record-hash",
					},
				},
			},
		},
	};
	return execContext(contracts, { enabled: true, numRuns: 100 });
}

/** Real AccountService source for the mirror W1 runnability pin. */
const EXEC_MIRROR_SOURCE = `export class AccountService {
	setStatus(status: string, newStatus: string): boolean {
		if (status !== newStatus) throw new Error("status mismatch");
		return true;
	}
}
`;

/**
 * Real AccountService source for the FIELD-BOUND W1 runnability pin (Center
 * B1): setStatus takes ONLY the op param newStatus and mutates the manifest
 * field `status` to match — so the emitted `expect(...(instance.status,
 * newStatus)).toBe(true)` genuine post-state check holds for every sampled
 * newStatus (the source accepts all strings).
 */
const EXEC_FIELD_BOUND_SOURCE = `export class AccountService {
	status: string = "initial";
	setStatus(newStatus: string): boolean {
		this.status = newStatus;
		return true;
	}
}
`;

/**
 * The MIXED guard-set contract (Center re-review crash): operation
 * `merge(a: string, b: string)` with preconditions `f == a` (f a manifest
 * FIELD — the field-bound layout, PLANNED) AND `a == b` (a param-param
 * mirror). The mirror descriptor's layout would need to filter with the
 * field-referencing sibling, which can never be destructured from the record —
 * the record filter comes out EMPTY and the emitter throws. The ratified fix:
 * the field-bound descriptor stays planned; the mirror sibling is a
 * PROPERTY_UNPLANNABLE warning.
 */
function execMixedContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			MergeService: {
				invariants: [],
				operations: {
					merge: {
						id: "MergeService.merge",
						params: [
							{ name: "a", type: "string" },
							{ name: "b", type: "string" },
						],
						preconditions: [
							{ id: "MergeService.merge.pre0", expr: "f == a" },
							{ id: "MergeService.merge.pre1", expr: "a == b" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "exec-mixed-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			MergeService: {
				sourceHash: "man-exec-mixed",
				fields: { f: "string" },
			},
		},
	};
	return execContext(contracts, { enabled: true, numRuns: 100 }, manifests);
}

/** Real OrderService source for the record W1 runnability pin. */
const EXEC_RECORD_SOURCE = `export class OrderService {
	placeOrder(a: number, b: number): number {
		if (a < 0 || b < 0 || a + b > 100) throw new Error("out of range");
		return a + b;
	}
}
`;

/**
 * Real MergeService source for the MIXED W1 runnability pin (Center
 * re-review): merge takes the two op params and mutates the manifest field
 * `f` to match the first param — so the emitted field-bound
 * `expect(...(instance.f, a)).toBe(true)` post-state check holds for every
 * sampled a (the mirror sibling `a == b` is unplannable and never emitted, so
 * no `a === b` constraint applies to the source).
 */
const EXEC_MIXED_SOURCE = `export class MergeService {
	f: string = "initial";
	merge(a: string, b: string): number {
		this.f = a;
		return 1;
	}
}
`;

/** The REAL vitest runner (vitest.mjs under process.execPath — the established emitters.test.ts harness). */
function execVitestBin(): string {
	return join(EXEC_REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
}

/**
 * The hardened W1 execution helper — spawns the REAL vitest runner in the
 * temp workspace. The transient flake this guards against: the spawned runner
 * occasionally dies on startup (spawn timeout / no summary emitted) while the
 * generated property itself is fine. A GENUINE test failure always prints the
 * "Test Files ... failed" summary, so:
 *   - exit 0 → success, return immediately;
 *   - a run that produced NO vitest summary (or was killed by the timeout) is
 *     a harness flake → retry (up to attempts);
 *   - a run that SUMMARIZED a failure is a real failure → never retried, the
 *     assertion below reports it.
 */
function execVitestRun(
	root: string,
	attempts = 3,
): { status: number | null; stdout: string; stderr: string } {
	let last: { status: number | null; stdout: string; stderr: string } = {
		status: null,
		stdout: "",
		stderr: "",
	};
	for (let attempt = 0; attempt < attempts; attempt++) {
		const run = spawnSync(process.execPath, [execVitestBin(), "run"], {
			cwd: root,
			encoding: "utf8",
			// 60s spawn budget — a cold vitest boot under load can exceed the
			// default; an exceeded budget (status null) is a flake, not a
			// property failure (a real failure summarizes well within 60s).
			timeout: 60_000,
		});
		last = {
			status: run.status,
			stdout: run.stdout ?? "",
			stderr: run.stderr ?? "",
		};
		if (run.status === 0) {
			return last;
		}
		const summarized = /\d+ failed/.test(last.stdout);
		if (!summarized && attempt < attempts - 1) {
			continue;
		}
		return last;
	}
	return last;
}

describe("emitted joint-sampling properties RUN under the REAL vitest runner (W1, VERSAILLES-165, shipped)", () => {
	it("executes an emitted EQUALITY-MIRROR property — exit 0 (param-param equality, Center B1: the mirror stays the param-param strategy)", async () => {
		const ctx = execMirrorContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		// Planner pin: the equality-mirror IS planned — the TARGET carries
		// mirrorOf, no warning, the codegen'd oracle is the strict equality.
		expect(plan.warnings).toEqual([]);
		expect(plan.descriptors).toHaveLength(1);
		const target = plan.descriptors[0].params.find(
			(spec) => spec.param === "newStatus",
		);
		expect(target?.mirrorOf).toBe("status");
		expect(plan.descriptors[0].clauses[0].code).toBe(
			"(status, newStatus) => status === newStatus",
		);

		const root = await mkdtemp(join(tmpdir(), "versailles-pbt-mirror-exec-"));
		try {
			// fast-check must resolve from the generated file's directory — the
			// node_modules symlink to the repo root (same resolution the
			// committed examples/order-service workspace gets from its own
			// node_modules).
			await symlink(
				join(EXEC_REPO_ROOT, "node_modules"),
				join(root, "node_modules"),
				"dir",
			);
			await writeFile(
				join(root, "account.ts"),
				`${EXEC_MIRROR_SOURCE}\n`,
				"utf8",
			);

			const files = emitSuite(suite, "vitest", {
				generatedDir: ".",
				modulePaths: { AccountService: "./account" },
				methods: {
					AccountService: {
						setStatus: {
							static: false,
							params: ["status", "newStatus"],
							returnType: "boolean",
						},
					},
				},
				propertyPlan: plan,
				propertyNumRuns: 100,
			});
			const account = files.find((file) =>
				file.path.endsWith("AccountService.test.ts"),
			);
			expect(account).toBeDefined();

			// The string pin: the MIRROR layout — the target has no arbitrary,
			// the mirror is derived inside the callback, the equality oracle is
			// asserted (not filtered).
			expect(account?.content).toContain(
				"const prop = fc.property(status, (status) => {",
			);
			expect(account?.content).toContain("\t\t\tconst newStatus = status;");
			expect(account?.content).toContain(
				"expect(AccountService_setStatus_post0(status, newStatus)).toBe(true);",
			);
			expect(account?.content).not.toContain("const newStatus = fc.string();");
			expect(account?.content).not.toContain("newStatus.filter(");

			await writeFile(
				join(root, "AccountService.test.ts"),
				account?.content ?? "",
				"utf8",
			);

			// EXECUTE under the real vitest runner — the W1 gate that string
			// pins alone cannot provide. The mirror must run 100 seeded runs
			// green (the oracle holds by construction — zero filter sparsity).
			const run = execVitestRun(root);
			expect(
				run.status,
				`emitted equality-mirror property did not run clean:\n${run.stdout}\n${run.stderr}`,
			).toBe(0);
			// The runner SUMMARY must independently show zero failures.
			expect(run.stdout).not.toMatch(/\d+ failed/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("executes an emitted RECORD + BOUNDED FILTER property — exit 0, no hang, no 'too many pre-conditions'", async () => {
		const ctx = execRecordContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		// Planner pin: the coupled compound IS planned — the derived bounds
		// land in BOTH params, no warning.
		expect(plan.warnings).toEqual([]);
		expect(plan.descriptors).toHaveLength(1);
		const a = plan.descriptors[0].params.find((spec) => spec.param === "a");
		const b = plan.descriptors[0].params.find((spec) => spec.param === "b");
		expect(a?.bounds).toEqual({ min: 0, max: 100 });
		expect(b?.bounds).toEqual({ min: 0, max: 100 });
		expect(plan.descriptors[0].clauses[0].code).toBe(
			"(a, b) => a >= 0 && b >= 0 && a + b <= 100",
		);
		// The codegen'd oracle is the exact filter predicate (codegen.ts pin).
		const pre0Ast = ctx.parsedContracts["OrderService.placeOrder.pre0"];
		expect(pre0Ast).toBeDefined();
		expect(renderClausePredicate(pre0Ast)).toBe(
			"(a, b) => a >= 0 && b >= 0 && a + b <= 100",
		);

		const root = await mkdtemp(join(tmpdir(), "versailles-pbt-record-exec-"));
		try {
			await symlink(
				join(EXEC_REPO_ROOT, "node_modules"),
				join(root, "node_modules"),
				"dir",
			);
			await writeFile(
				join(root, "order.ts"),
				`${EXEC_RECORD_SOURCE}\n`,
				"utf8",
			);

			const files = emitSuite(suite, "vitest", {
				generatedDir: ".",
				modulePaths: { OrderService: "./order" },
				methods: {
					OrderService: {
						placeOrder: {
							static: false,
							params: ["a", "b"],
							returnType: "number",
						},
					},
				},
				propertyPlan: plan,
				propertyNumRuns: 100,
			});
			const order = files.find((file) =>
				file.path.endsWith("OrderService.test.ts"),
			);
			expect(order).toBeDefined();

			// The string pin: the RECORD layout — the joint region is bounded
			// by the derived per-param bounds, filtered at the record level,
			// destructured in the callback. No per-param declarations, no
			// per-param filters.
			expect(order?.content).toContain(
				"fc.record({ a: fc.integer({ min: 0, max: 100 }), b: fc.integer({ min: 0, max: 100 }) })",
			);
			expect(order?.content).toContain(
				".filter(({ a, b }) => OrderService_placeOrder_pre0(a, b))",
			);
			expect(order?.content).toContain("\t\t\t({ a, b }) => {");
			expect(order?.content).not.toContain(
				"const a = fc.integer({ min: 0, max: 100 });",
			);
			expect(order?.content).not.toContain("a.filter(");

			await writeFile(
				join(root, "OrderService.test.ts"),
				order?.content ?? "",
				"utf8",
			);

			// EXECUTE under the real vitest runner. The bounded record +
			// composed filter must run 100 seeded runs green WITHOUT hanging or
			// exhausting fast-check's skip budget — the derived bounds make the
			// valid region ~50% of the joint box, so "too many pre-conditions"
			// is impossible.
			const run = execVitestRun(root);
			expect(
				run.status,
				`emitted record + bounded filter property did not run clean:\n${run.stdout}\n${run.stderr}`,
			).toBe(0);
			// The runner SUMMARY must independently show zero failures — and
			// the fast-check skip-budget failure mode must be absent.
			expect(run.stdout).not.toMatch(/\d+ failed/);
			expect(run.stdout).not.toContain("too many pre-conditions");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("executes an emitted FIELD-BOUND property — exit 0, the genuine post-state check holds on the real instance (Center B1)", async () => {
		const ctx = execFieldBoundContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		// Planner pin: the field-operand equality IS planned via the
		// FIELD-BOUND layout — OP-PARAMS ONLY ([newStatus]), NO mirrorOf, NO
		// field source spec, no warning.
		expect(plan.warnings).toEqual([]);
		expect(plan.descriptors).toHaveLength(1);
		const params = plan.descriptors[0].params.map((spec) => spec.param);
		expect(params).toEqual(["newStatus"]);
		expect(
			plan.descriptors[0].params.some((spec) => spec.mirrorOf !== undefined),
		).toBe(false);
		expect(plan.descriptors[0].clauses[0].code).toBe(
			"(status, newStatus) => status === newStatus",
		);

		const root = await mkdtemp(
			join(tmpdir(), "versailles-pbt-fieldbound-exec-"),
		);
		try {
			await symlink(
				join(EXEC_REPO_ROOT, "node_modules"),
				join(root, "node_modules"),
				"dir",
			);
			await writeFile(
				join(root, "account.ts"),
				`${EXEC_FIELD_BOUND_SOURCE}\n`,
				"utf8",
			);

			const files = emitSuite(suite, "vitest", {
				generatedDir: ".",
				modulePaths: { AccountService: "./account" },
				methods: {
					AccountService: {
						setStatus: {
							static: false,
							params: ["newStatus"],
							returnType: "boolean",
						},
					},
				},
				propertyPlan: plan,
				propertyNumRuns: 100,
			});
			const account = files.find((file) =>
				file.path.endsWith("AccountService.test.ts"),
			);
			expect(account).toBeDefined();

			// The string pin: the FIELD-BOUND layout — the op-param arbitrary
			// only, the component instance bound inside the callback, the call
			// with the sampled param only, and the assertion mapping the field
			// to instance.status (a genuine post-state check).
			expect(account?.content).toContain(
				"const prop = fc.property(newStatus, (newStatus) => {",
			);
			expect(account?.content).toContain(
				"\t\t\tconst instance = new AccountService();",
			);
			expect(account?.content).toContain("instance.setStatus(newStatus);");
			expect(account?.content).toContain(
				"expect(AccountService_setStatus_post0(instance.status, newStatus)).toBe(true);",
			);
			expect(account?.content).not.toContain("const status = fc.string();");
			expect(account?.content).not.toContain("fc.record(");

			await writeFile(
				join(root, "AccountService.test.ts"),
				account?.content ?? "",
				"utf8",
			);

			// EXECUTE under the real vitest runner. The emitted field-bound
			// block samples newStatus, calls the real setStatus (which mutates
			// this.status = newStatus), and asserts the oracle on the POST-state
			// — 100 seeded runs must pass, proving the field-bound layout is a
			// genuine runnable post-state check, not a vacuous filter.
			const run = execVitestRun(root);
			expect(
				run.status,
				`emitted field-bound property did not run clean:\n${run.stdout}\n${run.stderr}`,
			).toBe(0);
			expect(run.stdout).not.toMatch(/\d+ failed/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("executes the MIXED guard-set case's emitted FIELD-BOUND property — exit 0, the field-referencing post-state check holds on the real instance (Center re-review crash closed)", async () => {
		const ctx = execMixedContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		// Planner pin: the field-bound clause pre0 IS planned; the mirror
		// sibling pre1 is PROPERTY_UNPLANNABLE — exactly ONE descriptor, the
		// field-bound one, OP-PARAMS ONLY ([a, b], no mirrorOf).
		expect(
			plan.warnings.some((w) => w.field === "MergeService.merge.pre1"),
		).toBe(true);
		expect(
			plan.warnings.some((w) => w.field === "MergeService.merge.pre0"),
		).toBe(false);
		const fieldBound = plan.descriptors.find(
			(d) => d.id === "MergeService.merge.property-satisfies-0",
		);
		expect(fieldBound).toBeDefined();
		expect(fieldBound?.params.map((spec) => spec.param)).toEqual(["a", "b"]);
		expect(fieldBound?.params.some((spec) => spec.mirrorOf !== undefined)).toBe(
			false,
		);
		expect(
			plan.descriptors.some((d) =>
				d.traces.includes("MergeService.merge.pre1"),
			),
		).toBe(false);
		expect(fieldBound?.clauses[0].code).toBe("(f, a) => f === a");

		const root = await mkdtemp(join(tmpdir(), "versailles-pbt-mixed-exec-"));
		try {
			await symlink(
				join(EXEC_REPO_ROOT, "node_modules"),
				join(root, "node_modules"),
				"dir",
			);
			await writeFile(join(root, "merge.ts"), `${EXEC_MIXED_SOURCE}\n`, "utf8");

			const files = emitSuite(suite, "vitest", {
				generatedDir: ".",
				modulePaths: { MergeService: "./merge" },
				methods: {
					MergeService: {
						merge: {
							static: false,
							params: ["a", "b"],
							returnType: "number",
						},
					},
				},
				propertyPlan: plan,
				propertyNumRuns: 100,
			});
			const merge = files.find((file) =>
				file.path.endsWith("MergeService.test.ts"),
			);
			expect(merge).toBeDefined();

			// The string pin: the FIELD-BOUND layout for the field-bound
			// descriptor — op-param arbitraries, the component instance bound,
			// the call with the sampled params, the field mapped to instance.f.
			expect(merge?.content).toContain(
				"const prop = fc.property(a, b, (a, b) => {",
			);
			expect(merge?.content).toContain(
				"\t\t\tconst instance = new MergeService();",
			);
			expect(merge?.content).toContain("instance.merge(a, b);");
			expect(merge?.content).toContain(
				"expect(MergeService_merge_pre0(instance.f, a)).toBe(true);",
			);
			// The mirror sibling is never emitted — no mirror block.
			expect(merge?.content).not.toContain(
				'"MergeService.merge.property-satisfies-1"',
			);

			await writeFile(
				join(root, "MergeService.test.ts"),
				merge?.content ?? "",
				"utf8",
			);

			// EXECUTE under the real vitest runner. The emitted field-bound
			// block samples a and b, calls the real merge (which mutates
			// this.f = a), and asserts the oracle on the POST-state — 100
			// seeded runs must pass, proving the mixed case's field-bound
			// descriptor is a genuine runnable post-state check, not a crash.
			const run = execVitestRun(root);
			expect(
				run.status,
				`emitted mixed field-bound property did not run clean:\n${run.stdout}\n${run.stderr}`,
			).toBe(0);
			expect(run.stdout).not.toMatch(/\d+ failed/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
