/**
 * Property-block planning (ADR-0017, build-spec §9.6; split per ADR-0020): the
 * seeded PBT machinery. A pure function of the ALREADY-PLANNED concrete suite
 * (for the full source clause-id stream) plus the loaded context (for param
 * typeRefs, effects, enum members, parsed clause ASTs, the predicates registry,
 * and config.propertyBased). Same inputs → identical
 * descriptors/strategies/warnings (ADR-0002, re-scoped to generation-time by
 * ADR-0017).
 *
 * Per-clause strategy gating (selectStrategy, Chunk 4): "example" → NO
 * property block (the concrete §9.1/§9.2 cases fully cover it); "property"
 * and "property-with-falsifier" → an ACCEPT-side satisfies block is planned
 * (the deterministic example falsifier of a predicateCall precondition is
 * retained in the concrete suite). Effects-overlap invariants → an
 * invariant-preserving block. Expected-rejection (enabled) → a rejects block
 * tracing the §9.2 sweep's deterministic first-hit set (violated invariants +
 * satisfied postconditions) with the configured rejection idiom (ADR-0007).
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractOperation,
	LoaderWarning,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import {
	INVERTED_NUMERIC_OP,
	type NumericOp,
	collectFieldRefs,
	fieldRefName,
	isNumericOp,
	operationOverlapsInvariant,
	resolveClauseShape,
} from "./clause-analysis.js";
import { renderClausePredicate } from "./codegen.js";
import { planExpectedRejection } from "./concrete-cases.js";
import { defaultValue, enumMembers } from "./input-synthesis.js";
import type {
	ArbitrarySpec,
	PlannedSuite,
	PropertyClause,
	PropertyDescriptor,
	PropertyOutcome,
	PropertyPlan,
} from "./ir.js";
import { oracleParamsOf } from "./oracle.js";
import { derivePropertySeed } from "./seed.js";
import type { StrategyMap } from "./strategy.js";
import { selectStrategy } from "./strategy.js";

/** Per-clause planning metadata — which operation/component owns a clause. */
export type PropertyClauseMeta = {
	component: string;
	operationName: string | null;
	operation: ContractOperation | null;
	surface: "precondition" | "postcondition" | "invariant";
};

/** Per-param ArbitrarySpec derivation result; unplannable names the culprit. */
type ArbitrarySpecResult = {
	specs: ArbitrarySpec[];
	unplannable: string | null;
};

/**
 * Builds the per-clause metadata lookup with the same component → operation →
 * clauses traversal planTestCases uses, so every source clause id in
 * suite.clauseIds resolves to its surface and owning operation.
 */
export function collectClauseMeta(
	context: VersaillesContext,
): Record<string, PropertyClauseMeta> {
	const meta: Record<string, PropertyClauseMeta> = {};
	for (const [componentName, component] of Object.entries(
		context.contracts?.contracts ?? {},
	)) {
		for (const invariant of component.invariants ?? []) {
			meta[invariant.id] = {
				component: componentName,
				operationName: null,
				operation: null,
				surface: "invariant",
			};
		}
		for (const [operationName, operation] of Object.entries(
			component.operations ?? {},
		)) {
			for (const pre of operation.preconditions ?? []) {
				meta[pre.id] = {
					component: componentName,
					operationName,
					operation,
					surface: "precondition",
				};
			}
			for (const post of operation.postconditions ?? []) {
				meta[post.id] = {
					component: componentName,
					operationName,
					operation,
					surface: "postcondition",
				};
			}
		}
	}
	return meta;
}

/**
 * Builds the per-param { min, max } bounds map from the raw per-variable
 * lower/upper records (the shape the ArbitrarySpec bounds field requires —
 * build-spec §9.6). Only params with BOTH bounds resolved carry a bounds
 * object; the map is what buildArbitrarySpecs consumes AFTER cross-param
 * propagation has extended the records (VERSAILLES-165).
 */
function numericBoundsFromRecords(
	operation: ContractOperation,
	lower: Record<string, number>,
	upper: Record<string, number>,
): Record<string, { min: number; max: number }> {
	const out: Record<string, { min: number; max: number }> = {};
	for (const param of operation.params ?? []) {
		if (param.type.trim() !== "number") {
			continue;
		}
		const lo = lower[param.name];
		const hi = upper[param.name];
		if (lo !== undefined && hi !== undefined) {
			out[param.name] = { min: lo, max: hi };
		}
	}
	return out;
}

/**
 * Recurses an AST collecting per-variable numeric lower/upper bounds from
 * every numeric comparison inside `and`-chain leaves and top-level numeric
 * leaves. Center W4: `or` subtrees are SKIPPED entirely — an `or` disjunct
 * does not imply either side holds (`a >= 0 or b >= 0` bounds neither a nor b
 * individually), so `or`-derived bounds would feed unsound values into
 * cross-param propagation. `literal OP field` compares are normalized to
 * `field invertedOP literal` before the bound is applied.
 */
function collectNumericBounds(
	node: Node,
	lower: Record<string, number>,
	upper: Record<string, number>,
): void {
	if (node.type === "and") {
		collectNumericBounds(node.left, lower, upper);
		collectNumericBounds(node.right, lower, upper);
		return;
	}
	if (node.type === "or") {
		// W4: never collect from a disjunct — see the docstring.
		return;
	}
	if (node.type !== "compare" || !isNumericOp(node.op)) {
		return;
	}
	const inverted: Record<NumericOp, NumericOp> = {
		">": "<",
		"<": ">",
		">=": "<=",
		"<=": ">=",
	};
	let left = node.left;
	let right = node.right;
	let op = node.op;
	const leftVar = fieldRefName(left);
	const rightVar = fieldRefName(right);
	if (leftVar === null && rightVar !== null && isNumericOp(op)) {
		left = right;
		right = node.left;
		op = inverted[op];
	}
	const variable = fieldRefName(left);
	if (
		variable === null ||
		right.type !== "literal" ||
		typeof right.value !== "number"
	) {
		return;
	}
	const b = right.value;
	if (op === ">=") {
		lower[variable] = Math.max(lower[variable] ?? Number.NEGATIVE_INFINITY, b);
	} else if (op === ">") {
		lower[variable] = Math.max(
			lower[variable] ?? Number.NEGATIVE_INFINITY,
			b + 1,
		);
	} else if (op === "<=") {
		upper[variable] = Math.min(upper[variable] ?? Number.POSITIVE_INFINITY, b);
	} else {
		upper[variable] = Math.min(
			upper[variable] ?? Number.POSITIVE_INFINITY,
			b - 1,
		);
	}
}

/**
 * Derives the per-param ArbitrarySpec list for an operation from its param
 * typeRefs, enum members, and the compound-aware numeric bounds. list<X> →
 * inner kind + default []; optional<X> → inner kind + the inner type's
 * deterministic default. A component-typed (or otherwise unrepresentable) param
 * has no ArbitrarySpec kind, so the whole operation's property blocks are
 * unplannable (the clause's valid region cannot become filterable arbitraries).
 * Center W1: an INVERTED derived bound (min > max — contradictory leaves like
 * `x >= 10 and x <= 5`, or cross-param propagation that over-constrains a
 * coupling) makes the region unsatisfiable — fc.integer({ min, max }) with
 * min > max throws at runtime, so the operation's descriptors are
 * PROPERTY_UNPLANNABLE instead of emitting a broken arbitrary.
 */
function buildArbitrarySpecs(
	operation: ContractOperation,
	bounds: Record<string, { min: number; max: number }>,
): ArbitrarySpecResult {
	const specs: ArbitrarySpec[] = [];
	for (const param of operation.params ?? []) {
		const paramBounds = bounds[param.name];
		if (paramBounds !== undefined && paramBounds.min > paramBounds.max) {
			return {
				specs: [],
				unplannable: `"${param.name}" (derived bounds { min: ${paramBounds.min}, max: ${paramBounds.max}} are inverted — the valid region is unsatisfiable)`,
			};
		}
		const spec = arbitrarySpecForType(
			param.name,
			param.type,
			bounds[param.name],
		);
		if (spec === null) {
			return {
				specs: [],
				unplannable: `"${param.name}" (type "${param.type}")`,
			};
		}
		specs.push(spec);
	}
	return { specs, unplannable: null };
}

/**
 * Maps one param typeRef to its ArbitrarySpec (kind = the fast-check arbitrary
 * family the emitter renders). Returns null for typeRefs with no kind
 * (component-typed and other unrepresentable types).
 */
function arbitrarySpecForType(
	param: string,
	typeRef: string,
	bounds: { min: number; max: number } | undefined,
): ArbitrarySpec | null {
	const trimmed = typeRef.trim();
	if (trimmed === "number") {
		return {
			param,
			typeRef,
			kind: "number",
			...(bounds === undefined ? {} : { bounds }),
		};
	}
	if (trimmed === "string") {
		return { param, typeRef, kind: "string" };
	}
	if (trimmed === "boolean") {
		return { param, typeRef, kind: "boolean" };
	}
	if (/^enum<(.+)>$/.test(trimmed)) {
		return {
			param,
			typeRef,
			kind: "enum",
			members: enumMembers(trimmed) ?? [],
		};
	}
	if (trimmed.startsWith("list<")) {
		const inner = trimmed.slice("list<".length, -1);
		const innerSpec = arbitrarySpecForType(param, inner, undefined);
		if (innerSpec === null) {
			return null;
		}
		return { ...innerSpec, typeRef, default: [] };
	}
	if (trimmed.startsWith("optional<")) {
		const inner = trimmed.slice("optional<".length, -1);
		const innerSpec = arbitrarySpecForType(param, inner, undefined);
		if (innerSpec === null) {
			return null;
		}
		return { ...innerSpec, typeRef, default: defaultValue(inner) };
	}
	return null;
}

/**
 * Equality-mirror detection: a top-level `compare` with op `==` and BOTH sides
 * single-segment fieldRefs (`p1 == p2`) routes to the equality-mirror strategy
 * — the SOURCE (the left operand) is generated from its arbitrary and the value
 * is mirrored to the TARGET (the right operand). Returns null for any
 * non-mirror shape: `!=`/`!==` (mirroring would assert the OPPOSITE of what the
 * oracle asserts), a compare with an arithmetic side, a compound, a
 * self-equality (`p1 == p1` — degenerate single-param, not a mirror), or an
 * equality whose operands are NOT both operation params (Center B1): the SOURCE
 * is sampled from its own arbitrary, so a manifest-FIELD operand (e.g. `status
 * == newStatus` where `status` is a field, not an op param) has no arbitrary to
 * sample from. Field-operand equalities route to the emitter's FIELD-BOUND
 * layout (B1) instead — no mirror, no field-source spec; the descriptor
 * carries op-params only and the field maps to `instance.<field>` after the
 * call.
 */
function equalityMirrorInfo(
	ast: Node,
	opParamNames: Set<string>,
): { source: string; target: string } | null {
	if (ast.type !== "compare" || ast.op !== "==") {
		return null;
	}
	const left = fieldRefName(ast.left);
	const right = fieldRefName(ast.right);
	if (left === null || right === null || left === right) {
		return null;
	}
	if (!opParamNames.has(left) || !opParamNames.has(right)) {
		return null;
	}
	return { source: left, target: right };
}

/**
 * True for a top-level `==` compare whose BOTH sides are single-segment
 * fieldRefs — the equality-FAMILY shape (Center B1). The equality-mirror
 * strategy only covers the op-param × op-param subset (equalityMirrorInfo); a
 * field-operand equality in this family is still PLANNED (never
 * PROPERTY_UNPLANNABLE) — the emitter's FIELD-BOUND layout renders it.
 */
function bothSideFieldRefEquality(ast: Node): boolean {
	return (
		ast.type === "compare" &&
		ast.op === "==" &&
		fieldRefName(ast.left) !== null &&
		fieldRefName(ast.right) !== null
	);
}

/**
 * The manifest-FIELD operands of a bothSideFieldRef equality — the operands
 * that are NOT operation params (Center re-review). `status == newStatus`
 * with `status` a manifest field and `newStatus` the only op param →
 * ["status"]; `status == balance` with BOTH operands manifest fields →
 * ["status", "balance"] (zero op params — no arbitrary can drive the
 * property, the Fix-2 zero-param case). Returns [] for any non-equality AST
 * or an equality whose operands are all op params (the mirror subset).
 */
function fieldBoundFieldOperands(
	ast: Node,
	opParamNames: Set<string>,
): string[] {
	// Narrow the Node union to the compare shape before touching .left/.right
	// (bothSideFieldRefEquality returns a plain boolean, not a type guard).
	if (
		ast.type !== "compare" ||
		ast.op !== "==" ||
		fieldRefName(ast.left) === null ||
		fieldRefName(ast.right) === null
	) {
		return [];
	}
	const left = fieldRefName(ast.left);
	const right = fieldRefName(ast.right);
	const fields: string[] = [];
	if (left !== null && !opParamNames.has(left)) {
		fields.push(left);
	}
	if (right !== null && !opParamNames.has(right)) {
		fields.push(right);
	}
	return fields;
}

/** A normalized sum/difference coupling leaf `p1 ± p2 <op> C`. */
type CouplingLeaf = {
	arithOp: "+" | "-";
	p1: string;
	p2: string;
	/** The compare op, normalized to arithmetic-side-left orientation. */
	op: string;
	C: number;
};

/**
 * Normalizes a compare node into a coupling leaf: one side an `arithmetic`
 * node `p1 + p2` / `p1 - p2` (both operands single-segment fieldRefs), the
 * other side a numeric literal. Literal-left compares (`C >= p1 + p2`) are
 * inverted to arithmetic-left. Returns null when the compare is not a
 * two-fieldRef sum/difference against a numeric literal. `==`/`!=` couplings
 * are still returned (op preserved) so the caller can reject them as
 * equality-of-sums — they are never propagated (measure-zero).
 */
function couplingLeaf(node: Node): CouplingLeaf | null {
	if (node.type !== "compare") {
		return null;
	}
	let arithSide = node.left;
	let litSide = node.right;
	let op: string = node.op;
	if (arithSide.type !== "arithmetic" && litSide.type === "arithmetic") {
		arithSide = litSide;
		litSide = node.left;
		op = INVERTED_NUMERIC_OP[op] ?? op;
	}
	if (arithSide.type !== "arithmetic" || litSide.type !== "literal") {
		return null;
	}
	if (typeof litSide.value !== "number") {
		return null;
	}
	if (arithSide.op !== "+" && arithSide.op !== "-") {
		return null;
	}
	const p1 = fieldRefName(arithSide.left);
	const p2 = fieldRefName(arithSide.right);
	if (p1 === null || p2 === null) {
		return null;
	}
	return { arithOp: arithSide.op, p1, p2, op, C: litSide.value };
}

/**
 * Cross-param bound propagation (VERSAILLES-165): for a sum/difference
 * coupling leaf `p1 ± p2 <op> C` against the operation's KNOWN per-param
 * bounds, derives the tightest bound the OTHER side's known bound implies:
 *
 *   p1 + p2 <= C  (or < C)  with L1 ≤ p1, L2 ≤ p2 → p1 ≤ C − L2, p2 ≤ C − L1
 *   p1 + p2 >= C  (or > C)  with U1 ≥ p1, U2 ≥ p2 → p1 ≥ C − U2, p2 ≥ C − U1
 *   p1 − p2 <= C  (or < C)  with U2 ≥ p2, L1 ≤ p1 → p1 ≤ C + U2, p2 ≥ L1 − C
 *   p1 − p2 >= C  (or > C)  with L2 ≤ p2, U1 ≥ p1 → p1 ≥ C + L2, p2 ≤ U1 − C
 *
 * Strict ops follow the numericConstraintBounds convention (`< C` → the
 * exclusive boundary C−1, `> C` → C+1). Mutates `lower`/`upper` in place;
 * returns false when any needed operand bound is missing (the joint space is
 * unbounded there, so the coupling is unboundable).
 */
function propagateCouplingBound(
	leaf: CouplingLeaf,
	lower: Record<string, number>,
	upper: Record<string, number>,
): boolean {
	if (!isNumericOp(leaf.op)) {
		return false;
	}
	let C = leaf.C;
	if (leaf.op === "<") {
		C -= 1;
	} else if (leaf.op === ">") {
		C += 1;
	}
	const { p1, p2, arithOp } = leaf;
	if (arithOp === "+") {
		if (leaf.op === "<=" || leaf.op === "<") {
			const L1 = lower[p1];
			const L2 = lower[p2];
			if (L1 === undefined || L2 === undefined) {
				return false;
			}
			upper[p1] = Math.min(upper[p1] ?? Number.POSITIVE_INFINITY, C - L2);
			upper[p2] = Math.min(upper[p2] ?? Number.POSITIVE_INFINITY, C - L1);
			return true;
		}
		const U1 = upper[p1];
		const U2 = upper[p2];
		if (U1 === undefined || U2 === undefined) {
			return false;
		}
		lower[p1] = Math.max(lower[p1] ?? Number.NEGATIVE_INFINITY, C - U2);
		lower[p2] = Math.max(lower[p2] ?? Number.NEGATIVE_INFINITY, C - U1);
		return true;
	}
	// difference: p1 − p2
	if (leaf.op === "<=" || leaf.op === "<") {
		const U2 = upper[p2];
		const L1 = lower[p1];
		if (U2 === undefined || L1 === undefined) {
			return false;
		}
		upper[p1] = Math.min(upper[p1] ?? Number.POSITIVE_INFINITY, C + U2);
		lower[p2] = Math.max(lower[p2] ?? Number.NEGATIVE_INFINITY, L1 - C);
		return true;
	}
	const L2 = lower[p2];
	const U1 = upper[p1];
	if (L2 === undefined || U1 === undefined) {
		return false;
	}
	lower[p1] = Math.max(lower[p1] ?? Number.NEGATIVE_INFINITY, C + L2);
	upper[p2] = Math.min(upper[p2] ?? Number.POSITIVE_INFINITY, U1 - C);
	return true;
}

/**
 * Accepts/rejects the leaves of a multi-param guard for the record + bounded
 * filter strategy (VERSAILLES-165): a conjunction (`and`-chain) of numeric
 * bounds (`field op literal`), literal equalities/inequalities (filterable at
 * the record level), and sum/difference couplings (cross-param propagated).
 * Any other leaf — `or`/`not`/predicateCall nodes, fieldRef-vs-fieldRef
 * compares, equality-of-sums, a coupling referencing a manifest-FIELD operand
 * (Center B2), or an unboundable coupling — makes the guard unplannable.
 * Mutates `lower`/`upper` with the derived coupling bounds so the propagation
 * feeds the per-param bounds BEFORE buildArbitrarySpecs consumes them. Returns
 * null when every leaf is acceptable, else a human-readable reason.
 */
function recordLeafFailure(
	node: Node,
	lower: Record<string, number>,
	upper: Record<string, number>,
	opParamNames: Set<string>,
): string | null {
	if (node.type === "and") {
		return (
			recordLeafFailure(node.left, lower, upper, opParamNames) ??
			recordLeafFailure(node.right, lower, upper, opParamNames)
		);
	}
	if (node.type !== "compare") {
		return `contains a ${node.type} node — only conjunctions of numeric bounds, literal inequalities, and sum/difference couplings are record-samplable`;
	}
	const leftVar = fieldRefName(node.left);
	const rightVar = fieldRefName(node.right);
	if (
		(leftVar !== null && node.right.type === "literal") ||
		(rightVar !== null && node.left.type === "literal")
	) {
		// Numeric bound (contributes to collectNumericBounds) or a literal
		// equality/inequality — filterable at the record level, no bound needed.
		return null;
	}
	const coupling = couplingLeaf(node);
	if (coupling !== null) {
		// Center B2: a coupling leaf that references a manifest-FIELD operand
		// (not an op param) is not record-samplable — the field is instance
		// state, never a record key, so its value can neither be sampled nor
		// destructured for the composed filter. The joint region cannot be
		// bounded by sampling, so the clause stays PROPERTY_UNPLANNABLE.
		if (!opParamNames.has(coupling.p1) || !opParamNames.has(coupling.p2)) {
			const fieldOperand = opParamNames.has(coupling.p1)
				? coupling.p2
				: coupling.p1;
			return `coupling ${coupling.p1} ${coupling.arithOp} ${coupling.p2} ${coupling.op} ${coupling.C} references manifest-field operand "${fieldOperand}" — only operation params can be joint-sampled`;
		}
		if (!isNumericOp(coupling.op)) {
			return `equality-of-sums compare ${coupling.p1} ${coupling.arithOp} ${coupling.p2} ${coupling.op} ${coupling.C} is a measure-zero slice, not a bounded region`;
		}
		if (!propagateCouplingBound(coupling, lower, upper)) {
			return `unboundable coupling ${coupling.p1} ${coupling.arithOp} ${coupling.p2} ${coupling.op} ${coupling.C} — cross-param propagation needs bounds on both operands`;
		}
		return null;
	}
	return "multi-param compare is neither a fieldRef equality, a bounded coupling, nor a literal inequality";
}

/** The joint-sampling classification of a multi-param guard oracle's AST. */
type MultiParamGuardClass =
	| { kind: "mirror"; source: string; target: string }
	| { kind: "field-bound" }
	| { kind: "coupled-bounded" }
	| { kind: "unplannable"; detail: string };

/**
 * Classifies a multi-param guard oracle's AST for joint sampling
 * (VERSAILLES-165): an equality-mirror (top-level `p1 == p2` with BOTH operands
 * operation params), a FIELD-BOUND equality (a bothSideFieldRef `==` with at
 * least one manifest-FIELD operand — Center B1: plannable, never unplannable;
 * the emitter renders the field-bound layout), a record + bounded filter (a
 * conjunction of numeric bounds / literal inequalities / boundable couplings),
 * or unplannable. The cross-param propagation for coupled-bounded guards runs
 * HERE — mutating the operation's lower/upper bounds — so the derived bounds
 * land in the specs.
 */
function classifyMultiParamGuard(
	ast: Node,
	lower: Record<string, number>,
	upper: Record<string, number>,
	opParamNames: Set<string>,
): MultiParamGuardClass {
	const mirror = equalityMirrorInfo(ast, opParamNames);
	if (mirror !== null) {
		return { kind: "mirror", source: mirror.source, target: mirror.target };
	}
	// Center B1: a bothSideFieldRef equality `field == param` (at least one
	// operand a manifest FIELD, not an op param) is neither mirror-able (the
	// field is instance state, never a sampled arbitrary) nor record-filterable
	// (the field can never be destructured from the record) — but it IS
	// plannable via the emitter's FIELD-BOUND layout, so it must NOT trip the
	// PROPERTY_UNPLANNABLE gate below.
	if (bothSideFieldRefEquality(ast)) {
		return { kind: "field-bound" };
	}
	const failure = recordLeafFailure(ast, lower, upper, opParamNames);
	if (failure === null) {
		return { kind: "coupled-bounded" };
	}
	return { kind: "unplannable", detail: failure };
}

/**
 * Builds the per-param ArbitrarySpec list for an equality-mirror descriptor
 * (VERSAILLES-165): the mirror SOURCE's spec first (no mirrorOf — it has the
 * independent arbitrary), then the mirror TARGET's spec carrying
 * `mirrorOf: "<source>"` (no independent arbitrary — bounds/default stripped),
 * then the remaining operation-param specs in order. Center B1: BOTH operands
 * are guaranteed operation params (equalityMirrorInfo rejects field operands —
 * field-operand equalities route to the emitter's FIELD-BOUND layout), so no
 * manifest-field source spec is ever derived here. Returns null when the
 * source or target has no representable ArbitrarySpec.
 */
function buildMirrorParams(
	base: ArbitrarySpec[],
	source: string,
	target: string,
): ArbitrarySpec[] | null {
	const sourceSpec = base.find((spec) => spec.param === source) ?? null;
	if (sourceSpec === null) {
		return null;
	}
	const targetBase = base.find((spec) => spec.param === target) ?? null;
	if (targetBase === null) {
		return null;
	}
	// The mirror TARGET has NO independent arbitrary — bounds/default stripped.
	const targetSpec: ArbitrarySpec = {
		param: targetBase.param,
		typeRef: targetBase.typeRef,
		kind: targetBase.kind,
		members: targetBase.members,
		mirrorOf: source,
	};
	const rest = base.filter(
		(spec) => spec.param !== source && spec.param !== target,
	);
	return [sourceSpec, targetSpec, ...rest];
}

/**
 * The codegen predicates import table (predicate name → import specifier),
 * derived from the loaded predicates registry. renderClausePredicate only uses
 * the map to VALIDATE resolvability — the emitted call is the bare name — so
 * the registered sourceRef (falling back to the conventional specifier) is the
 * registry-derived value.
 */
function predicatesImportMap(
	context: VersaillesContext,
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [name, entry] of Object.entries(
		context.predicates?.predicates ?? {},
	)) {
		map[name] = entry.sourceRef || "./predicates.js";
	}
	return map;
}

/**
 * Plans the property blocks for a validated context + its already-planned
 * concrete suite (ADR-0017, build-spec §9.6). Throws when context.isValid is
 * false (mirrors planTestCases — generation only runs against approved
 * contracts). Property blocks are NEVER planned when
 * config.propertyBased.enabled is false or absent (the v1 default output stays
 * byte-identical); the per-clause strategy record is still total over
 * suite.clauseIds with pbtEnabled: false semantics.
 */
export function planPropertyBlocks(
	suite: PlannedSuite,
	context: VersaillesContext,
): PropertyPlan {
	if (!context.isValid) {
		throw new Error(
			"planPropertyBlocks requires a validated context (isValid: true) — generation is blocked for invalid contracts",
		);
	}
	if (context.contracts === null) {
		throw new Error(
			"planPropertyBlocks requires a contracts store in the context",
		);
	}

	const pbt = context.config?.propertyBased;
	const pbtEnabled = pbt?.enabled === true;
	const idiom = context.config?.rejection?.idiom ?? "throws";
	// ADR-0018: the config grammarVersion field is removed; pin "1.0" so the
	// PBT seed derivation input stays byte-identical (ADR-0002).
	const grammarVersion = "1.0";
	const seedOverride = pbt?.seed;

	const descriptors: PropertyDescriptor[] = [];
	const warnings: LoaderWarning[] = [];
	const strategies: StrategyMap = {};

	const clauseMeta = collectClauseMeta(context);
	const predicates = predicatesImportMap(context);

	// Strategy record: EVERY source clause id → PbtStrategy (the total
	// coverage record). selectStrategy is a pure table lookup over the
	// resolved shape; pbtEnabled threads the config gate.
	for (const clauseId of suite.clauseIds) {
		strategies[clauseId] = selectStrategy(
			resolveClauseShape(clauseId, clauseMeta, context),
			{ pbtEnabled },
		);
	}

	// Enabled gate (ADR-0017 backward-compat pin).
	if (!pbtEnabled) {
		return { descriptors, strategies, warnings };
	}

	for (const [componentName, component] of Object.entries(
		context.contracts.contracts,
	)) {
		const invariants = component.invariants ?? [];
		for (const [operationName, operation] of Object.entries(
			component.operations ?? {},
		)) {
			// Descriptor ids: "<component>.<operation>.property-<outcome>-<n>",
			// n a per-(operation, outcome) counter from 0.
			const counters: Partial<Record<PropertyOutcome, number>> = {};
			const nextId = (outcome: PropertyOutcome): string => {
				const current = counters[outcome] ?? 0;
				counters[outcome] = current + 1;
				return `${componentName}.${operationName}.property-${outcome}-${current}`;
			};

			// Operation-wide numeric bounds: the compound-aware DIRECT bounds
			// (collectNumericBounds over every precondition) plus the cross-param
			// bounds propagation derives from the multi-param guard couplings
			// below (VERSAILLES-165). Propagation mutates these records before
			// the final { min, max } map is built, so the derived bounds land in
			// the specs BEFORE buildArbitrarySpecs consumes them.
			const lower: Record<string, number> = {};
			const upper: Record<string, number> = {};
			for (const pre of operation.preconditions ?? []) {
				const ast = context.parsedContracts[pre.id];
				if (ast !== undefined) {
					collectNumericBounds(ast, lower, upper);
				}
			}

			// The emitted GAP-3 guard set for an operation is the clause oracle
			// of EVERY satisfies + invariant-preserving descriptor for the same
			// (component, operation), in plan order. Render the candidate
			// oracles once, then CLASSIFY every multi-param guard oracle's AST
			// (VERSAILLES-165) instead of blanket-unplannable: a guard oracle
			// with >1 callback params can never be an arbitrary `.filter(...)`
			// (fast-check's filter passes exactly ONE value, so filtering with a
			// multi-param oracle would evaluate the predicate against undefined
			// and silently discard the whole domain — a hanging property). A
			// clause whose oracle cannot render never reaches the emitted guard
			// set — its own descriptor carries the render-failure warning
			// (Center W5) below instead.
			const guardCandidates: { clauseId: string; ast: Node }[] = [];
			// §9.6 guard-set soundness: a renderable SINGLE-PARAM
			// example-strategy clause (e.g. an inline numeric-bound
			// precondition `price > 0`) keeps its "example" strategy — no
			// property block of its own — but its oracle must STILL join the
			// operation's guard set so every per-param-filter sibling block
			// filters to the valid region. A lower-only numeric bound attaches
			// no bounds object, so a bare `fc.integer()` would sample ≤0 and
			// the property would fail silently (the generator-soundness bug:
			// the guard-set construction excluded every "example" clause).
			// Multi-param / unrenderable example-strategy clauses stay
			// excluded — their shapes follow the existing PROPERTY_UNPLANNABLE
			// path.
			const exampleGuardOracles: { clauseId: string; code: string }[] = [];
			for (const pre of operation.preconditions ?? []) {
				const ast = context.parsedContracts[pre.id];
				if (ast === undefined) {
					continue;
				}
				if (strategies[pre.id] === "example") {
					try {
						const code = renderClausePredicate(ast, { predicates });
						if (oracleParamsOf(code).length <= 1) {
							exampleGuardOracles.push({ clauseId: pre.id, code });
						}
					} catch {
						// Unrenderable example-strategy clause — never a guard
						// oracle (its own descriptor would warn on the
						// property path; example clauses never reach it).
					}
					continue;
				}
				guardCandidates.push({ clauseId: pre.id, ast });
			}
			for (const post of operation.postconditions ?? []) {
				const ast = context.parsedContracts[post.id];
				if (ast === undefined) {
					continue;
				}
				if (strategies[post.id] === "example") {
					try {
						const code = renderClausePredicate(ast, { predicates });
						if (oracleParamsOf(code).length <= 1) {
							exampleGuardOracles.push({ clauseId: post.id, code });
						}
					} catch {
						// Unrenderable example-strategy clause — never a guard
						// oracle.
					}
					continue;
				}
				guardCandidates.push({ clauseId: post.id, ast });
			}
			for (const invariant of invariants) {
				const ast = context.parsedContracts[invariant.id];
				if (ast !== undefined && operationOverlapsInvariant(operation, ast)) {
					guardCandidates.push({ clauseId: invariant.id, ast });
				}
			}
			const guardOracles: { clauseId: string; code: string }[] = [];
			for (const candidate of guardCandidates) {
				try {
					guardOracles.push({
						clauseId: candidate.clauseId,
						code: renderClausePredicate(candidate.ast, { predicates }),
					});
				} catch {
					// Render-failed clauses contribute no guard oracle (their own
					// descriptor warns + skips below — never a silent zero).
				}
			}

			// Joint-sampling router (VERSAILLES-165): classify EVERY multi-param
			// guard oracle's AST. An equality-mirror (`p1 == p2`, both operands
			// operation params), a FIELD-BOUND equality (a bothSideFieldRef `==`
			// with a manifest-FIELD operand — Center B1), and a record + bounded
			// filter (a conjunction of numeric bounds / literal inequalities /
			// boundable sum-difference couplings) are joint-plannable; anything
			// else — non-mirrorable `!=`, equality-of-sums, an unboundable
			// coupling, a coupling referencing a manifest field (Center B2) —
			// keeps the PROPERTY_UNPLANNABLE gate. A multi-param guard in the
			// operation's guard set makes EVERY satisfies/invariant-preserving
			// descriptor of the operation need the joint treatment: if ANY
			// multi-param guard is unplannable, the operation's
			// satisfies/invariant descriptors are all unplannable. Rejects
			// blocks are unaffected (they have no filters). The cross-param
			// propagation for coupled-bounded guards runs here, feeding the
			// operation's lower/upper records.
			const opParamNames = new Set(
				(operation.params ?? []).map((param) => param.name),
			);
			let multiParamUnplannable: { clauseId: string; detail: string } | null =
				null;
			// A field-referencing multi-param guard in the operation's guard
			// set (Center re-review): a bothSideFieldRef equality with at least
			// one manifest-FIELD operand (`f == a`). The emitter's FIELD-BOUND
			// layout is reserved for descriptors whose OWN clause is such an
			// equality; every OTHER satisfies/invariant-preserving descriptor
			// would need to filter with the field-referencing sibling — and
			// the mirror/record layouts cannot reference manifest fields in
			// their filters (the record cannot destructure the field; the
			// mirror cannot sample it) — so those siblings are
			// PROPERTY_UNPLANNABLE. `zeroParam` flags the degenerate field ×
			// field equality (`f1 == f2`, both operands manifest fields): even
			// the field-bound layout has nothing to sample then.
			let multiParamFieldBound: {
				clauseId: string;
				zeroParam: boolean;
			} | null = null;
			for (const oracle of guardOracles) {
				if (oracleParamsOf(oracle.code).length <= 1) {
					continue;
				}
				const ast = context.parsedContracts[oracle.clauseId];
				if (ast === undefined) {
					continue;
				}
				const classification = classifyMultiParamGuard(
					ast,
					lower,
					upper,
					opParamNames,
				);
				if (classification.kind === "unplannable") {
					multiParamUnplannable = {
						clauseId: oracle.clauseId,
						detail: classification.detail,
					};
					break;
				}
				if (classification.kind === "field-bound") {
					if (multiParamFieldBound === null) {
						multiParamFieldBound = {
							clauseId: oracle.clauseId,
							zeroParam:
								fieldBoundFieldOperands(ast, opParamNames).length === 2,
						};
					}
				}
			}

			// Final per-param bounds after propagation: only params with BOTH
			// bounds resolved carry a bounds object (the ArbitrarySpec bounds
			// shape requires min + max).
			const bounds = numericBoundsFromRecords(operation, lower, upper);
			const paramsResult = buildArbitrarySpecs(operation, bounds);
			const manifestFields =
				context.manifests?.manifests[componentName]?.fields ?? {};

			// Plans ONE descriptor for a property-strategy clause, or a
			// non-silent PROPERTY_UNPLANNABLE warning (the PREDICATE_UNPLANNABLE
			// tier) that skips it: unrepresentable operation params, an
			// unplannable multi-param guard oracle in the operation's filter set
			// (VERSAILLES-165), or a renderClausePredicate throw for the clause
			// (Center W5). Never silent, never a hard fail for renderer
			// unrepresentability.
			const planClauseDescriptor = (
				clauseId: string,
				ast: Node,
				outcome: PropertyOutcome,
			): void => {
				if (paramsResult.unplannable !== null) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot plan a property block for ${clauseId}: operation ${componentName}.${operationName} has param ${paramsResult.unplannable} — the clause's valid region cannot be turned into filterable arbitraries`,
					});
					return;
				}
				// Joint-sampling gate — satisfies and invariant-preserving
				// blocks only (rejects has no filters). A multi-param guard
				// that is NEITHER mirror-able NOR bounded (record + bounded
				// filter) makes every accept-side block of the operation
				// unplannable. The SELECTOR still records "property" for these
				// clauses (the strategy is the open-question coverage record);
				// the PLANNER finds the block unplannable and the coverage gap
				// stays visible in suite.clauseIds.
				if (
					(outcome === "satisfies" || outcome === "invariant-preserving") &&
					multiParamUnplannable !== null
				) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot plan a property block for ${clauseId}: guard oracle ${multiParamUnplannable.clauseId} is a multi-param oracle that cannot be joint-sampled (${multiParamUnplannable.detail}) — fast-check's .filter() passes one value, so no satisfies/invariant-preserving block in ${componentName}.${operationName} can filter its arbitraries to a valid region with this guard set`,
					});
					return;
				}
				// Fix 2 (LOW, Center re-review): the clause's OWN
				// bothSideFieldRef equality whose operands are ALL manifest
				// fields (`f1 == f2` — zero op params to sample) cannot produce
				// a valid fast-check property: the FIELD-BOUND layout samples
				// op-param arbitraries only, so with no op params it would
				// emit `fc.property(, () => {` syntax garbage. Route to
				// PROPERTY_UNPLANNABLE — warning, descriptor absent, strategy
				// stays "property".
				const ownFieldOperands = fieldBoundFieldOperands(ast, opParamNames);
				if (
					(outcome === "satisfies" || outcome === "invariant-preserving") &&
					ownFieldOperands.length === 2
				) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot plan a property block for ${clauseId}: the bothSideFieldRef equality's operands are ALL manifest fields (${ownFieldOperands.join(", ")}) — no operation param can drive fast-check's fc.property, so the FIELD-BOUND layout has no arbitrary to sample`,
					});
					return;
				}
				// Fix 1 (MEDIUM, Center re-review): when the operation's guard
				// set contains a field-referencing multi-param oracle (`f ==
				// a`), ONLY descriptors whose OWN clause is such a field-bound
				// equality are plannable — via the emitter's FIELD-BOUND
				// layout, which never filters with siblings. Every OTHER
				// satisfies/invariant-preserving descriptor would need to
				// filter with the field-referencing sibling — the mirror and
				// record layouts cannot reference manifest fields in their
				// filters — so it is PROPERTY_UNPLANNABLE (warning, descriptor
				// absent, strategy stays "property"). The SELECTOR still
				// records "property"; the coverage gap stays visible.
				if (
					(outcome === "satisfies" || outcome === "invariant-preserving") &&
					multiParamFieldBound !== null &&
					ownFieldOperands.length === 0
				) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot plan a property block for ${clauseId}: guard oracle ${multiParamFieldBound.clauseId} is a field-referencing multi-param equality (a manifest-FIELD operand) — only descriptors whose own clause is such a field-bound equality are plannable (the FIELD-BOUND layout), and the mirror/record layouts cannot filter with a field-referencing sibling, so no other satisfies/invariant-preserving block in ${componentName}.${operationName} can be planned with this guard set`,
					});
					return;
				}
				let code: string;
				try {
					code = renderClausePredicate(ast, { predicates });
				} catch (error) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot render the property oracle for ${clauseId}: ${error instanceof Error ? error.message : String(error)}`,
					});
					return;
				}
				// Equality-mirror wiring (VERSAILLES-165, Center B1): when the
				// clause's OWN oracle is a bothSideFieldRef equality `p1 == p2`
				// with BOTH operands operation params, the mirror TARGET's spec
				// carries mirrorOf: "<source>" (no independent arbitrary) and
				// the SOURCE's spec precedes it. A field-operand equality is
				// NOT mirrored — equalityMirrorInfo returns null — and the
				// descriptor is planned with op-params only; the emitter
				// renders the FIELD-BOUND layout (field → instance.<field>).
				let params = paramsResult.specs;
				if (outcome === "satisfies" || outcome === "invariant-preserving") {
					const mirror = equalityMirrorInfo(ast, opParamNames);
					if (mirror !== null) {
						const mirrored = buildMirrorParams(
							paramsResult.specs,
							mirror.source,
							mirror.target,
						);
						if (mirrored === null) {
							warnings.push({
								code: "PROPERTY_UNPLANNABLE",
								field: clauseId,
								detail: `Cannot plan a property block for ${clauseId}: the equality-mirror source or target (${mirror.source} / ${mirror.target}) has no representable ArbitrarySpec — the mirrored value cannot be sampled`,
							});
							return;
						}
						params = mirrored;
					}
				}
				// §9.6 guard-set wiring: attach the operation's renderable
				// single-param example-strategy guard oracles ONLY to
				// descriptors whose own clause oracle is single-param — the
				// per-param `.filter` layout that actually consumes sibling
				// guards. Multi-param own-clause descriptors (mirror / record
				// / FIELD-BOUND) never filter with sibling guards, so they
				// carry no `guards` (keeps the record/field-bound pins
				// byte-identical).
				const ownOracleParams = oracleParamsOf(code);
				descriptors.push({
					id: nextId(outcome),
					component: componentName,
					operation: operationName,
					params,
					clauses: [{ clauseId, code }],
					...(exampleGuardOracles.length > 0 && ownOracleParams.length <= 1
						? { guards: exampleGuardOracles }
						: {}),
					outcome,
					traces: [clauseId],
					// Seed wiring: the explicit override wins; otherwise the
					// per-block derived seed over the block's OWN covered
					// clause ids + grammar version.
					seed: seedOverride ?? derivePropertySeed([clauseId], grammarVersion),
				});
			};

			// Preconditions: "property" (compound / bothSideFieldRef / other)
			// and "property-with-falsifier" (predicateCall) plan an ACCEPT-side
			// satisfies block; the deterministic example falsifier stays in
			// the concrete suite.
			for (const pre of operation.preconditions ?? []) {
				if (strategies[pre.id] === "example") {
					continue;
				}
				const ast = context.parsedContracts[pre.id];
				if (ast === undefined) {
					continue;
				}
				planClauseDescriptor(pre.id, ast, "satisfies");
			}

			// Postconditions: literal-computable stay example; uncomputable
			// become satisfies properties.
			for (const post of operation.postconditions ?? []) {
				if (strategies[post.id] === "example") {
					continue;
				}
				const ast = context.parsedContracts[post.id];
				if (ast === undefined) {
					continue;
				}
				planClauseDescriptor(post.id, ast, "satisfies");
			}

			// Invariants this operation's effects overlap → invariant-
			// preserving block, oracle = the codegen'd invariant.
			for (const invariant of invariants) {
				const ast = context.parsedContracts[invariant.id];
				if (ast === undefined) {
					continue;
				}
				if (!operationOverlapsInvariant(operation, ast)) {
					continue;
				}
				planClauseDescriptor(invariant.id, ast, "invariant-preserving");
			}

			// Expected-rejection (enabled): the §9.2 bounded sweep's
			// deterministic first-hit set (violated invariants + satisfied
			// postconditions) becomes a rejects property whose clauses are the
			// codegen'd oracles of the traced conditions, with the configured
			// rejection idiom (ADR-0007).
			const rejection = planExpectedRejection(
				operation,
				operation.preconditions ?? [],
				operation.postconditions ?? [],
				invariants,
				manifestFields,
				context,
			);
			if (rejection === null) {
				continue;
			}
			const traces = [
				...rejection.violatedInvariants,
				...rejection.satisfiedPostconditions,
			];
			if (paramsResult.unplannable !== null) {
				warnings.push({
					code: "PROPERTY_UNPLANNABLE",
					field: traces[0] ?? "",
					detail: `Cannot plan a property block for ${componentName}.${operationName}: operation has param ${paramsResult.unplannable} — the expected-rejection property cannot be planned`,
				});
				continue;
			}
			const rejectionClauses: PropertyClause[] = [];
			let rejectionError: { clauseId: string; detail: string } | null = null;
			for (const clauseId of traces) {
				const ast = context.parsedContracts[clauseId];
				if (ast === undefined) {
					rejectionError = {
						clauseId,
						detail: `Cannot plan a property block for ${clauseId}: missing parsed AST`,
					};
					break;
				}
				try {
					rejectionClauses.push({
						clauseId,
						code: renderClausePredicate(ast, { predicates }),
					});
				} catch (error) {
					rejectionError = {
						clauseId,
						detail: `Cannot render the property oracle for ${clauseId}: ${error instanceof Error ? error.message : String(error)}`,
					};
					break;
				}
			}
			if (rejectionError !== null) {
				warnings.push({
					code: "PROPERTY_UNPLANNABLE",
					field: rejectionError.clauseId,
					detail: rejectionError.detail,
				});
				continue;
			}
			descriptors.push({
				id: nextId("rejects"),
				component: componentName,
				operation: operationName,
				params: paramsResult.specs,
				clauses: rejectionClauses,
				outcome: "rejects",
				rejectionIdiom: idiom,
				traces,
				seed: seedOverride ?? derivePropertySeed(traces, grammarVersion),
			});
		}
	}

	return { descriptors, strategies, warnings };
}
