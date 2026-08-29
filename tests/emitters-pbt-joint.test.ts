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
 * Joint-sampling emitter layouts (VERSAILLES-165, Chunk 2) — the byte-pinned
 * contract for the emitter rework that renders the two joint strategies the
 * Chunk 1 planner now plans:
 *
 *   1. EQUALITY-MIRROR — a descriptor whose clause is a bothSideFieldRef
 *      equality `p1 == p2` (the mirror TARGET's ArbitrarySpec carries
 *      `mirrorOf: "<source>"`). The mirror is guaranteed by construction, so:
 *        - ONLY the SOURCE (non-mirror) params get arbitrary declarations.
 *        - The mirror TARGET is rendered INSIDE the fc.property callback as
 *          `const <target> = <source>;` — it is never sampled independently,
 *          never a callback param, never a filter subject, never a record key.
 *        - The equality oracle is NOT filtered (the mirror guarantees it) —
 *          but IS asserted after the call.
 *
 *   2. RECORD + BOUNDED FILTER — a descriptor whose guard oracle is a
 *      multi-param NON-mirror compound (a conjunction of numeric bounds /
 *      literal inequalities / boundable sum-difference couplings). The
 *      derived cross-param bounds (Chunk 1 propagation) feed per-param record
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
 * The rework MUST keep every existing single-param pin green: the per-param
 * `.filter(...)` layout stays when ALL guard oracles are single-param (or the
 * only multi-param oracle is a MIRROR), rejects descriptors stay unchanged
 * (per-param arbitraries, NO filters/oracles), and `fc.assert(prop, { seed,
 * numRuns })` / traceability / determinism / enabled=false semantics are
 * untouched.
 *
 * ── RED TODAY ─────────────────────────────────────────────────────────────
 * The current renderPropertyBlock (vitest.ts) builds the guard set and then
 * refuses loudly when a guard oracle takes >1 callback params — the B1
 * belt-and-suspenders throw (`Refusing to emit: guard oracle ... takes 2
 * callback params`). It has NO mirror rendering (it declares an arbitrary for
 * every spec, mirror target included) and NO record rendering. So every
 * byte-pin below that emits a joint plan FAILS at emitSuite with that throw —
 * the Red proof that the Chunk 2 rework has not landed yet.
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

describe("emitSuite vitest — joint-sampling property layouts (VERSAILLES-165 Chunk 2)", () => {
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
			"\t\tconst AccountService_setStatus_post0 = (status, newStatus) => status === newStatus;",
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

	it("byte-pins the RECORD + BOUNDED FILTER layout — fc.record over the derived joint bounds, record-level filter, destructured callback", () => {
		const files = emitJoint();
		const order = orderFile(files);
		expect(order).toBeDefined();

		const block = [
			'\t// traces: "OrderService.placeOrder.pre0"',
			'\tit("OrderService.placeOrder.property-satisfies-0", () => {',
			"\t\tconst OrderService_placeOrder_pre0 = (a, b) => a >= 0 && b >= 0 && a + b <= 100;",
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
			"\t\tconst OrderService_shipOrder_pre0 = (a, b) => a >= 0 && b >= 0 && a + b <= 100;",
			"\t\tconst OrderService_shipOrder_pre1 = (b) => b >= 1 && b <= 100;",
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
			"\t\tconst OrderService_shipOrder_pre0 = (a, b) => a >= 0 && b >= 0 && a + b <= 100;",
			"\t\tconst OrderService_shipOrder_pre1 = (b) => b >= 1 && b <= 100;",
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
		// Mirror target: never filtered, never a record key.
		expect(account?.content).not.toContain("newStatus.filter(");
		expect(account?.content).not.toContain("newStatus:");
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
		// the joint layouts (which throw in the current emitter). After the
		// rework the rejects block must render byte-identically.
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
		expect(order?.content).not.toContain("(a) => a >= 10");
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
// as a filter. These gates extend W1 to the two joint strategies: the emitted
// equality-mirror block and the emitted record + bounded-filter block must
// EXECUTE green under the REAL vitest runner — exit 0, no hang, no
// "too many pre-conditions" (the derived bounds make the record's valid region
// healthy, unlike a naive filter over an unbounded joint domain).

const EXEC_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXEC_EMPTY_MANIFESTS: ManifestsFile = { version: "1.0", manifests: {} };
const EXEC_EMPTY_PREDICATES: PredicatesFile = {
	version: "1.0",
	predicates: {},
};

function execConfig(
	propertyBased: WorkspaceConfig["propertyBased"],
): WorkspaceConfig {
	return {
		grammarVersion: "1.0",
		schemaVersion: "1.0",
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
): VersaillesContext {
	return {
		config: execConfig(propertyBased),
		contracts,
		manifests: EXEC_EMPTY_MANIFESTS,
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
 * `status == newStatus` — the Chunk 1 planner wires the mirror (the real
 * probe: descriptor params [status, newStatus mirrorOf: "status"], oracle
 * `(status, newStatus) => status === newStatus`).
 */
function execMirrorContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
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
 * The record + bounded filter contract: the coupled compound
 * `a >= 0 and b >= 0 and a + b <= 100` — the Chunk 1 planner derives the
 * cross-param bounds {0, 100} on both params and routes the clause to the
 * record + bounded filter strategy (the real probe).
 */
function execRecordContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
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

/** Real OrderService source for the record W1 runnability pin. */
const EXEC_RECORD_SOURCE = `export class OrderService {
	placeOrder(a: number, b: number): number {
		if (a < 0 || b < 0 || a + b > 100) throw new Error("out of range");
		return a + b;
	}
}
`;

/** The REAL vitest runner (vitest.mjs under process.execPath — the established emitters.test.ts harness). */
function execVitestBin(): string {
	return join(EXEC_REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
}

describe("emitted joint-sampling properties RUN under the REAL vitest runner (W1, VERSAILLES-165 Chunk 2)", () => {
	it("executes an emitted EQUALITY-MIRROR property — exit 0 (Red today: the emitter throws on the 2-param mirror oracle before any file is written)", async () => {
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
			const run = spawnSync(process.execPath, [execVitestBin(), "run"], {
				cwd: root,
				encoding: "utf8",
			});
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

	it("executes an emitted RECORD + BOUNDED FILTER property — exit 0, no hang, no 'too many pre-conditions' (Red today: the emitter throws on the 2-param coupled oracle)", async () => {
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
			const run = spawnSync(process.execPath, [execVitestBin(), "run"], {
				cwd: root,
				encoding: "utf8",
			});
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
});
