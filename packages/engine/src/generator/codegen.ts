/**
 * Clause-codegen predicate rendering — the oracle emitter of seeded PBT
 * emission (ADR-0017, build-spec §9.6 "Clause-codegen'd oracles";
 * deterministic-generation.contract.yaml plan_property_blocks).
 *
 * renderClausePredicate converts ANY contract-clause AST from the frozen node
 * set (build-spec §4.3, packages/core/src/core/parser.ts) into an inline JS
 * arrow-function predicate — the exact source that fills `PropertyClause.code`
 * in the PBT IR. The generated property tests call it as the oracle. Output is
 * byte-pinned: the exact JS source string IS the contract
 * (tests/generator-codegen.test.ts).
 *
 * Design decisions (pinned by the fixtures):
 * - Minimal parens with one mandated exception: grammar `not` binds LOOSER
 *   than comparison while JS `!` binds TIGHTER, so a `not` of a binary node
 *   (compare/arithmetic/and/or/not) MUST emit `!(<operand>)`; a `not` of a
 *   primary (literal / fieldRef / predicateCall / old) emits bare `!operand`.
 * - Comparison ops mirror evaluate()'s strict semantics EXACTLY: the contract
 *   lexemes `==` / `!=` are emitted as strict `===` / `!==` — the grammar
 *   imposes no type discipline, and loose `==` truth-flips on cross-typed
 *   primitives (a spurious accept of a violation is the exact failure this
 *   feature prevents). Relational ops (`<`, `<=`, `>`, `>=`) and the
 *   boolean/arithmetic lexemes (`&&`, `||`, `!`, `+ - * /`) are emitted
 *   verbatim.
 * - `in` with a literal-list right desugars to a chained `||` of `===`
 *   comparisons (mirroring evaluate()'s `right.some(member => member ===
 *   left)`), never a method call — the emitted code is side-effect-free BY
 *   CONSTRUCTION: no assignment, no `function` declaration, no method calls
 *   other than predicate calls.
 * - old(field) resolves against the captured pre-state object:
 *   `<preStateName>.<root><suffixes>` — the ONLY pre-state reference
 *   (evaluate()'s `old` branch resolves env.pre ONLY). The field name is the
 *   RAW path, never paramNames-mapped.
 * - predicateCall emits `<name>(<arg0>, ...)` referencing the imported
 *   predicate by name; the name must be present in `ctx.predicates` (the
 *   import table) or codegen refuses — an emitted call to an unimportable
 *   predicate would be broken JS (mirrors the planner's "never a silent zero"
 *   PREDICATE_UNPLANNABLE philosophy).
 * - Identifier safety mirrors the planner's assertSafeIdentifier discipline:
 *   every emitted parameter name, predicate name, preStateName, and every
 *   dotted path segment must match IDENTIFIER_RE or the renderer throws —
 *   NEVER silently emits broken JS.
 *
 * Pure and deterministic (ADR-0002): renderClausePredicate is a pure function
 * of (node, ctx) — two calls produce identical bytes.
 */
import type { FieldPath, Node } from "../../../core/src/core/parser.js";

/**
 * Valid JS identifier (Center W1) — mirrors the planner's IDENTIFIER_RE.
 * Every name that flows into the emitted arrow function as an identifier
 * (parameter, predicate name, preStateName, dotted path segment) must match.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Renderer options (see module header). All entries optional; defaults keep
 * the emitted source backward-compatible with the seed-test oracle shape
 * `(amount) => amount >= 10`.
 */
export type CodegenContext = {
	/**
	 * Clause fieldRef root name → emitted arrow-function parameter name.
	 * Absent entries default to the root name itself (which must already be a
	 * safe JS identifier). Deterministic renames only — a rename that would
	 * collide two roots onto one parameter (or onto the preState parameter)
	 * is refused. Never applies to old(field)'s raw pre-state property name.
	 */
	paramNames?: Record<string, string>;
	/**
	 * Identifier for the captured pre-state object that old(field) resolves
	 * against (default "preState"). Appended as the LAST arrow-function
	 * parameter exactly when the AST contains an `old` node.
	 */
	preStateName?: string;
	/**
	 * Registered predicate name → module import specifier (e.g.
	 * { isPositive: "./predicates.js" }). Only used to VALIDATE resolvability
	 * — the emitted call is the bare name; the generated test imports the
	 * predicate from the specifier.
	 */
	predicates?: Record<string, string>;
};

/**
 * Mutable per-render state: parameter collection (first-referenced, in-order)
 * plus pre-state presence. Recreated per renderClausePredicate call, so the
 * renderer stays a pure function of (node, ctx).
 */
type RenderState = {
	ctx: CodegenContext;
	/** Resolved pre-state identifier (ctx.preStateName ?? "preState"). */
	preStateName: string;
	/** Emitted parameter names in first-referenced in-order traversal order. */
	paramOrder: string[];
	/** Raw fieldRef roots already registered (dedup key, pre-rename). */
	seenRoots: Set<string>;
	/** Whether the AST contains an `old` node (appends the preState param). */
	hasOld: boolean;
};

/**
 * Mirrors the planner's assertSafeIdentifier failure mode (planner.ts): a
 * name that is not a safe JS identifier surfaces a non-silent error, never a
 * silently emitted broken identifier.
 */
function assertSafeIdentifier(name: string, what: string): void {
	if (!IDENTIFIER_RE.test(name)) {
		throw new Error(
			`Refusing to generate tests: ${what} "${name}" is not a valid JS identifier (must match /^[A-Za-z_$][A-Za-z0-9_$]*$/)`,
		);
	}
}

/**
 * Renders any contract-clause AST to a FULL arrow-function JS source string
 * `(<params>) => <expr>` — exactly what fills `PropertyClause.code` in the
 * PBT IR. Parameters are the fieldRef roots in first-referenced
 * (deterministic in-order) order, mapped through `ctx.paramNames`, then
 * `ctx.preStateName` (default `"preState"`) last when an `old` node is
 * present.
 *
 * Throws (non-silent) on: unsafe fieldRef root / predicate name /
 * preStateName / dotted path segment, a prototype-chain path segment
 * (`__proto__` / `constructor` / `prototype`), an unregistered predicate name
 * (not in ctx.predicates), the `[]` wildcard path segment, `in` with a
 * non-literal right operand, a literal of unsupported type (non-null object,
 * function, symbol, bigint, or undefined), and rename collisions.
 */
export function renderClausePredicate(
	node: Node,
	ctx?: CodegenContext,
): string {
	const state: RenderState = {
		ctx: ctx ?? {},
		preStateName: ctx?.preStateName ?? "preState",
		paramOrder: [],
		seenRoots: new Set(),
		hasOld: false,
	};
	const expr = renderNode(node, state);
	const params = [...state.paramOrder];
	if (state.hasOld) {
		assertSafeIdentifier(state.preStateName, "preState name");
		if (params.includes(state.preStateName)) {
			throw new Error(
				`Refusing to generate tests: preState name "${state.preStateName}" collides with a fieldRef parameter — rename via ctx.preStateName`,
			);
		}
		params.push(state.preStateName);
	}
	return `(${params.join(", ")}) => ${expr}`;
}

/** Node kinds that bind tighter than unary `!` — no parens under `not`. */
const PRIMARY_KINDS = new Set(["literal", "fieldRef", "predicateCall", "old"]);

/**
 * Renders a node to its JS expression, registering fieldRef roots as
 * arrow-function parameters in first-referenced in-order order as it goes.
 */
function renderNode(node: Node, state: RenderState): string {
	// Captured before the exhaustive switch so the fall-through guard can name
	// the discriminant without tripping TS narrowing (node is `never` there).
	const type = node.type;
	switch (node.type) {
		case "literal":
			return renderLiteral(node.value);
		case "fieldRef":
			return renderFieldRef(node.path, state);
		case "old":
			state.hasOld = true;
			return renderPreStatePath(node.ref.path, state);
		case "arithmetic":
			// Bare infix. The parser's ArithOp set is + - * / only, but the
			// renderer is total over Node at runtime and must emit any op it
			// finds deterministically (the hand-built `%` fixture pins this).
			return `${renderNode(node.left, state)} ${node.op} ${renderNode(node.right, state)}`;
		case "compare": {
			if (node.op === "in") {
				return renderIn(node, state);
			}
			// Center W1 (ratified): the codegen'd oracle must mirror planner
			// evaluate()'s strict semantics EXACTLY — the grammar imposes no
			// type discipline, and loose `==` truth-flips on cross-typed
			// primitives (a spurious accept of a violation is the exact failure
			// this feature prevents). So the contract lexemes `==` / `!=` are
			// emitted as strict `===` / `!==`; relational ops (`<`, `<=`, `>`,
			// `>=`) are emitted verbatim.
			const op = node.op === "==" ? "===" : node.op === "!=" ? "!==" : node.op;
			return `${renderNode(node.left, state)} ${op} ${renderNode(node.right, state)}`;
		}
		case "and":
			return `${renderNode(node.left, state)} && ${renderNode(node.right, state)}`;
		case "or":
			return `${renderNode(node.left, state)} || ${renderNode(node.right, state)}`;
		case "not": {
			const operand = renderNode(node.operand, state);
			// Grammar `not` binds looser than comparison, JS `!` tighter —
			// a binary operand MUST be parenthesized (design decision #1);
			// primaries never need it.
			return PRIMARY_KINDS.has(node.operand.type)
				? `!${operand}`
				: `!(${operand})`;
		}
		case "predicateCall":
			return renderPredicateCall(node, state);
	}
	// Unreachable for the frozen Node union; a hostile hand-built AST with an
	// unknown type must never be silently emitted as broken JS.
	throw new Error(
		`Refusing to generate tests: unknown clause node type "${type}"`,
	);
}

/** A literal scalar or a flat literal list (LiteralList cannot nest). */
type LiteralValue =
	| string
	| number
	| boolean
	| null
	| (string | number | boolean | null)[];

/**
 * Renders a literal node: number via String(n), string via JSON.stringify,
 * boolean/null as-is, and a literal list as `[a, b, c]`.
 */
function renderLiteral(value: LiteralValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((element) => renderLiteralElement(element)).join(", ")}]`;
	}
	return renderLiteralElement(value);
}

/** Renders a single literal element (list member or scalar literal). */
function renderLiteralElement(value: string | number | boolean | null): string {
	switch (typeof value) {
		case "number":
			return String(value);
		case "string":
			return JSON.stringify(value);
		case "boolean":
			return String(value);
		case "object":
			// typeof null === "object"; the literal grammar has no other
			// object values, so anything else is a hostile AST — refuse.
			if (value !== null) {
				throw new Error(
					"Refusing to generate tests: unsupported literal value of type object",
				);
			}
			return "null";
		default:
			// Center S3 (ratified): typeof function / symbol / bigint /
			// undefined is unreachable for the frozen literal grammar, but a
			// hostile hand-built AST must never silently emit "undefined" into
			// the oracle — the last silent-broken-JS path. Refuse loudly.
			throw new Error(
				`Refusing to generate tests: unsupported literal value of type ${typeof value}`,
			);
	}
}

/**
 * Renders a fieldRef: registers the root as an arrow-function parameter
 * (first-referenced in-order, renamed through ctx.paramNames) and appends
 * suffix segments — string → `.seg`, number → `[n]`.
 */
function renderFieldRef(path: FieldPath, state: RenderState): string {
	const root = path[0];
	if (typeof root !== "string") {
		throw new Error(
			`Refusing to generate tests: fieldRef root must be a string, got ${String(root)}`,
		);
	}
	return renderAccess(registerRoot(root, state), path.slice(1), "fieldRef");
}

/**
 * Registers a fieldRef root as a parameter on first encounter (dedup by raw
 * root) and returns the emitted (paramNames-renamed) identifier. Refuses a
 * rename that collides two roots onto one parameter.
 */
function registerRoot(root: string, state: RenderState): string {
	const emitted = state.ctx.paramNames?.[root] ?? root;
	if (state.seenRoots.has(root)) {
		return emitted;
	}
	state.seenRoots.add(root);
	assertSafeIdentifier(emitted, "fieldRef root");
	if (state.paramOrder.includes(emitted)) {
		throw new Error(
			`Refusing to generate tests: parameter name "${emitted}" is already used by another fieldRef root — rename via ctx.paramNames`,
		);
	}
	state.paramOrder.push(emitted);
	return emitted;
}

/**
 * Renders old(field) as `<preStateName>.<root><suffixes>` — the ONLY
 * pre-state reference. The field name is the RAW path (never
 * paramNames-mapped): the pre-state object is keyed by field name.
 */
function renderPreStatePath(path: FieldPath, state: RenderState): string {
	const root = path[0];
	if (typeof root !== "string") {
		throw new Error(
			`Refusing to generate tests: old() fieldRef root must be a string, got ${String(root)}`,
		);
	}
	assertSafeIdentifier(root, "old() fieldRef root");
	// The root is emitted as a DOTTED segment (`preState.<root>`), so the
	// prototype-chain refusal applies here too — `preState.__proto__` would
	// return Object.prototype (truthy), a wrong-oracle vector.
	assertNonPrototypeSegment(root, "old() fieldRef root");
	return renderAccess(
		`${state.preStateName}.${root}`,
		path.slice(1),
		"old() fieldRef",
	);
}

/**
 * Prototype-chain traversal refusal (Center S1 — hardening): a dotted segment
 * of `__proto__` / `constructor` / `prototype` would emit a property access
 * that walks the prototype chain (e.g. `preState.__proto__` returns
 * Object.prototype — truthy — a wrong-oracle vector) instead of a data
 * property. These are all valid JS identifiers, so assertSafeIdentifier alone
 * cannot catch them. Numeric index segments are unaffected.
 */
const PROTOTYPE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function assertNonPrototypeSegment(segment: string, what: string): void {
	if (PROTOTYPE_SEGMENTS.has(segment)) {
		throw new Error(
			`Refusing to generate tests: ${what} path segment "${segment}" would traverse the prototype chain (a ${segment} property access returns a prototype object — truthy — a wrong-oracle vector)`,
		);
	}
}

/**
 * Appends suffix segments to a base access expression: string → `.seg`
 * (identifier-asserted and prototype-chain-refused — dot notation needs a
 * valid JS identifier and must never walk the prototype chain), number →
 * `[n]`. The `[]` "any element" wildcard is a non-silent error: no concrete
 * JS property access exists for an unknown index.
 */
function renderAccess(base: string, segments: FieldPath, what: string): string {
	let out = base;
	for (const segment of segments) {
		if (segment === "[]") {
			throw new Error(
				`Refusing to generate tests: ${what} path segment "[]" (the 'any element' wildcard) has no concrete JS property access — refusing to emit ambiguous code`,
			);
		}
		if (typeof segment === "number") {
			out += `[${segment}]`;
			continue;
		}
		assertNonPrototypeSegment(segment, what);
		assertSafeIdentifier(segment, `${what} path segment`);
		out += `.${segment}`;
	}
	return out;
}

/**
 * Renders an `in` comparison as a chained `||` of `===` comparisons against a
 * literal-list right side — pure operator JS, no method calls, byte-pinned
 * (mirrors evaluate()'s `right.some(member => member === left)`). An `in`
 * with any non-literal-list right side is a non-silent error: rendering it
 * would need a method call the side-effect-free contract forbids.
 */
function renderIn(
	node: Extract<Node, { type: "compare" }>,
	state: RenderState,
): string {
	const right = node.right;
	if (right.type !== "literal" || !Array.isArray(right.value)) {
		throw new Error(
			`Refusing to generate tests: 'in' requires a literal-list right operand (got ${right.type}) — rendering a non-literal right would need a method call the side-effect-free contract forbids`,
		);
	}
	const left = renderNode(node.left, state);
	const members = right.value;
	if (members.length === 0) {
		// Empty membership is always false; the OR-chain of zero comparisons
		// has no concrete JS spelling, so emit the identity.
		return "false";
	}
	return members
		.map((member) => `${left} === ${renderLiteralElement(member)}`)
		.join(" || ");
}

/**
 * Renders a predicateCall as `<name>(<arg0>, <arg1>, ...)`. The name is
 * identifier-asserted AND must be present in ctx.predicates (the import
 * table) — an unregistered predicate would emit an unresolvable reference,
 * so codegen refuses (non-silent).
 */
function renderPredicateCall(
	node: { type: "predicateCall"; name: string; args: Node[] },
	state: RenderState,
): string {
	assertSafeIdentifier(node.name, "predicate name");
	const predicates = state.ctx.predicates ?? {};
	if (!(node.name in predicates)) {
		throw new Error(
			`Refusing to generate tests: predicate "${node.name}" is not registered in ctx.predicates — the generated test cannot import it`,
		);
	}
	const args = node.args.map((arg) => renderNode(arg, state));
	return `${node.name}(${args.join(", ")})`;
}
