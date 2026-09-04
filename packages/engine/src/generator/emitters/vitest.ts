/**
 * The vitest emitter plugin (ADR-0008/0009) — the ONLY framework rendering in
 * the generator core. Renders the framework-agnostic IR into full `.test.ts`
 * files ready for idempotent full-file regeneration (build-spec §9.4).
 *
 * The emitter is a pure function of the suite: same suite in, byte-identical
 * file content out. Rejection assertions are rendered from the case's
 * configured idiom ("throws" → expect(() => op(inputs)).toThrow();
 * "returns" → expect(op(inputs)).toBeNull()) — never hardcoded (ADR-0007).
 *
 * Call rendering is shape-aware from manifest method metadata
 * (deterministic-generation.contract.yaml §9.4, VERSAILLES-20 F1): instance
 * methods render `new <Component>().<op>(<positional>)`, static methods render
 * `<Component>.<op>(<positional>)` with params in declared order, and
 * void-return accept cases carry no return-value assertion. Accept/invariant
 * cases on a void-returning INSTANCE operation WITH assertions bind the
 * component INSTANCE — `const instance = new <Component>(); instance.<op>(...);
 * expect(instance.<field>)...` — so assertions target instance state, never
 * the void return value (VERSAILLES-26). The same instance-bound receiver
 * applies to PRIMITIVE-returning (number/string/boolean) INSTANCE operations:
 * a primitive return value has no fields, so `result.<field>` reads undefined
 * and can never pass (VERSAILLES-185); object-returning operations keep the
 * `result.<field>` receiver. A STATIC void operation with assertions renders
 * the bare call `<Component>.<op>(...);` with no instance.<field> assertion —
 * the static call never touches a constructed instance, so an instance
 * assertion would be meaningless (VERSAILLES-26 follow-up, W1), and a STATIC
 * primitive operation keeps the result-bound render (no instance to bind).
 * Without the `methods` option
 * (legacy) the historical static options-object call
 * `<Component>.<op>({ ...inputs })` with a toBeDefined assertion is preserved
 * byte-identically.
 */
import type {
	ArbitrarySpec,
	AssertionDescriptor,
	CoverageStatus,
	EmitOptions,
	EmittedFile,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
	PropertyDescriptor,
	PropertyPlan,
} from "../ir.js";
import { oracleParamsOf } from "../oracle.js";
import { sanitizeId } from "./shared.js";

/** Tool-owned generated output directory (config default, build-spec §9.4). */
const DEFAULT_GENERATED_DIR = ".versailles/generated";
/** Default module import specifier relative to a generated file. */
const DEFAULT_MODULE_PREFIX = "../../src/";
/**
 * Default run count for `fc.assert(prop, { seed, numRuns })` when
 * config.propertyBased.numRuns is absent (build-spec §9.6, ADR-0017).
 */
const DEFAULT_PROPERTY_NUM_RUNS = 100;

type ComponentGroup = {
	operations: OperationCaseGroup[];
	invariantCases: PlannedCase[];
};

/**
 * Valid JS identifier (Center W1): component / operation names and input keys
 * flow raw into import specifiers, describe titles, method calls and object
 * keys — the emitter refuses to render anything that could break out of the
 * generated surface.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(name: string, what: string): void {
	if (!IDENTIFIER_RE.test(name)) {
		throw new Error(
			`Refusing to emit: ${what} "${name}" is not a valid JS identifier (must match /^[A-Za-z_$][A-Za-z0-9_$]*$/)`,
		);
	}
}

export function emitVitest(
	suite: PlannedSuite,
	options?: EmitOptions,
): EmittedFile[] {
	const generatedDir = options?.generatedDir ?? DEFAULT_GENERATED_DIR;
	const modulePaths = options?.modulePaths ?? {};
	const methods = options?.methods;
	const predicates = options?.predicates;
	const propertyPlan = options?.propertyPlan;
	const propertyNumRuns = options?.propertyNumRuns ?? DEFAULT_PROPERTY_NUM_RUNS;
	// ADR-0021: the field model (access/types/readonly) threaded through the
	// emitter seam exactly like methods / modulePaths, plus the out-param
	// warning channel for non-silent EMISSION_UNRENDERABLE warnings.
	const fieldAccess = options?.fieldAccess;
	const fieldTypes = options?.fieldTypes;
	const fieldReadonly = options?.fieldReadonly;
	const warnings = options?.warnings;
	// VERSAILLES-186: the header trace comment mirrors the suite's coverage
	// status — brownfield keeps the verified `// traces:` form, greenfield
	// surfaces the provisional state (never reading as verified coverage).
	const coverageStatus = suite.coverageStatus ?? "verified";
	const groups = groupByComponent(suite);
	const files: EmittedFile[] = [];
	for (const component of Object.keys(groups)) {
		assertIdentifier(component, "component name");
		const content = renderComponentFile(
			component,
			groups[component],
			suite.clauseIds,
			coverageStatus,
			modulePaths,
			methods,
			predicates,
			propertyPlan,
			propertyNumRuns,
			fieldAccess,
			fieldTypes,
			fieldReadonly,
			warnings,
		);
		files.push({ path: `${generatedDir}/${component}.test.ts`, content });
	}
	return files;
}

function groupByComponent(suite: PlannedSuite): Record<string, ComponentGroup> {
	const groups: Record<string, ComponentGroup> = {};
	for (const group of suite.operations) {
		const entry = groups[group.component] ?? {
			operations: [],
			invariantCases: [],
		};
		entry.operations.push(group);
		groups[group.component] = entry;
	}
	for (const case_ of suite.invariantCases) {
		const component = case_.id.split(".")[0];
		const entry = groups[component] ?? { operations: [], invariantCases: [] };
		entry.invariantCases.push(case_);
		groups[component] = entry;
	}
	return groups;
}

function renderComponentFile(
	component: string,
	group: ComponentGroup,
	clauseIds: string[],
	coverageStatus: CoverageStatus,
	modulePaths: Record<string, string>,
	methods: EmitOptions["methods"],
	predicates: EmitOptions["predicates"],
	propertyPlan?: PropertyPlan,
	propertyNumRuns: number = DEFAULT_PROPERTY_NUM_RUNS,
	fieldAccess?: EmitOptions["fieldAccess"],
	fieldTypes?: EmitOptions["fieldTypes"],
	fieldReadonly?: EmitOptions["fieldReadonly"],
	warnings?: EmitOptions["warnings"],
): string {
	// ADR-0021 non-silent warning path: a field-model entry whose typeRef the
	// emitter cannot render to a TS type (fieldTypes present but unrenderable)
	// surfaces an EMISSION_UNRENDERABLE warning on the same non-blocking tier
	// as UNPLANNABLE_OPERATION / PROPERTY_UNPLANNABLE — never a silent untyped
	// field-bound oracle lambda (the TS7006 bug) and never a hard crash. The
	// files still emit (exit 0); the unrenderable shape is surfaced.
	for (const [field, typeRef] of Object.entries(
		fieldTypes?.[component] ?? {},
	)) {
		if (typeRefToTs(typeRef) === null) {
			warnings?.push({
				code: "EMISSION_UNRENDERABLE",
				field: `${component}.${field}`,
				detail: `Field type "${typeRef}" for ${component}.${field} has no renderable TS form — the emitter cannot type field-bound oracle lambdas referencing it type-safely; such lambdas are emitted untyped`,
			});
		}
	}
	const lines: string[] = [];
	lines.push(
		"// Auto-generated by the Versailles deterministic generator core.",
	);
	lines.push("// Do not edit — regenerate with `versailles generate`.");
	// §9.3: the traceability comment references the contract clause ids the
	// generated surface covers (the full source clause set, so zero-coverage
	// gaps stay visible against the manifest). Clause ids are escaped with
	// JSON.stringify so a hostile id can never break out of the comment into
	// an executable line (Center W1). VERSAILLES-186: the comment mirrors the
	// coverage status — brownfield keeps the byte-identical verified
	// `// traces: "id", ...` form; greenfield emits a provisional-marked
	// variant (`// traces (provisional): ...`) that never starts with the
	// verified `// traces:` prefix and still lists the traced clause ids.
	const tracesLine =
		coverageStatus === "provisional"
			? `// traces (provisional): ${clauseIds.map((id) => JSON.stringify(id)).join(", ")}`
			: `// traces: ${clauseIds.map((id) => JSON.stringify(id)).join(", ")}`;
	lines.push(tracesLine);
	lines.push('import { describe, expect, it } from "vitest";');
	lines.push("");
	// modulePaths override wins when present and non-empty; an absent (legacy)
	// or empty entry falls back to the deterministic default — an empty-string
	// import must never be emitted (deterministic-generation.contract.yaml).
	const override = modulePaths[component];
	const modulePath =
		typeof override === "string" && override.length > 0
			? override
			: `${DEFAULT_MODULE_PREFIX}${component}.js`;
	lines.push(`import { ${component} } from "${modulePath}";`);
	// ADR-0017: the fast-check import lands immediately after the component
	// import (and after the predicate imports — GAP 2), only when the component
	// has at least one property descriptor. Absent/empty propertyPlan renders
	// the v1 header byte-for-byte (the enabled=false backward-compat pin).
	const componentDescriptors = (propertyPlan?.descriptors ?? []).filter(
		(descriptor) => descriptor.component === component,
	);
	// ADR-0021 (VERSAILLES-175): the op-param coverage of the same non-silent
	// warning path — a descriptor op-param whose typeRef the emitter cannot
	// render to a TS type even after the container extension (e.g. list<Order>)
	// surfaces EMISSION_UNRENDERABLE on the same non-blocking tier as the
	// field-model path above — never a silent untyped op-param oracle lambda
	// (the TS7006 bug). The property block omits oracles referencing such a
	// param (renderPropertyBlock's hasUnrenderableOpParam filter), so the bare
	// lambda never renders; the warning names the op-param as
	// <component>.<operation>.<param>.
	for (const descriptor of componentDescriptors) {
		for (const spec of descriptor.params) {
			if (typeRefToTs(spec.typeRef) === null) {
				warnings?.push({
					code: "EMISSION_UNRENDERABLE",
					field: `${descriptor.component}.${descriptor.operation}.${spec.param}`,
					detail: `Op-param type "${spec.typeRef}" for ${descriptor.component}.${descriptor.operation}.${spec.param} has no renderable TS form — the emitter cannot type oracle lambdas referencing it type-safely; such oracles are omitted from emitted property blocks`,
				});
			}
		}
	}
	if (componentDescriptors.length > 0) {
		// GAP 2 (build-spec §9.6): every predicate the component's property
		// clauses reference is imported after the component import, before
		// fast-check — the codegen'd oracle calls the predicate by its bare
		// name, so the generated test needs the import to resolve it.
		for (const name of referencedPredicates(componentDescriptors, predicates)) {
			const specifier = predicates?.[name];
			if (specifier !== undefined) {
				lines.push(`import { ${name} } from "${specifier}";`);
			}
		}
		lines.push('import fc from "fast-check";');
	}
	lines.push("");

	for (const operation of group.operations) {
		assertIdentifier(operation.operation, "operation name");
		const propertyDescriptors = componentDescriptors.filter(
			(descriptor) => descriptor.operation === operation.operation,
		);
		// The guard set for a property block (GAP 3): every satisfies +
		// invariant-preserving descriptor for the same (component, operation),
		// in plan.descriptors order. Computed once per operation because every
		// block in that operation shares the same sibling set.
		const guardDescriptors = propertyDescriptors.filter(
			(descriptor) =>
				descriptor.outcome === "satisfies" ||
				descriptor.outcome === "invariant-preserving",
		);
		// V-27 empty-group pin + ADR-0017: an operation with zero concrete
		// cases but at least one property descriptor must still render its
		// describe — the property blocks are the only content inside.
		if (operation.cases.length > 0 || propertyDescriptors.length > 0) {
			lines.push(`describe("${operation.operation}", () => {`);
			for (const case_ of operation.cases) {
				lines.push(
					...renderCase(
						case_,
						component,
						operation.operation,
						methods,
						fieldAccess,
						fieldReadonly,
					),
				);
			}
			// Property blocks render AFTER the operation's concrete cases, in
			// plan.descriptors order (the planner already traverses operations
			// in component order, so a per-operation filter preserves it).
			for (const descriptor of propertyDescriptors) {
				lines.push(
					...renderPropertyBlock(
						descriptor,
						propertyNumRuns,
						methods,
						guardDescriptors,
						fieldAccess,
						fieldTypes,
					),
				);
			}
			lines.push("});");
			lines.push("");
		}
	}

	if (group.invariantCases.length > 0) {
		lines.push(`describe("${component} invariants", () => {`);
		for (const case_ of group.invariantCases) {
			const operation = operationOf(case_);
			assertIdentifier(operation, "operation name");
			lines.push(
				...renderCase(
					case_,
					component,
					operation,
					methods,
					fieldAccess,
					fieldReadonly,
				),
			);
		}
		lines.push("});");
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Matcher family per assertion op — renders a real vitest matcher on the
 * subject field instead of a bare toBeDefined() accept render (Center W2b).
 */
const MATCHER: Record<AssertionDescriptor["op"], string> = {
	">=": "toBeGreaterThanOrEqual",
	">": "toBeGreaterThan",
	"<=": "toBeLessThanOrEqual",
	"<": "toBeLessThan",
	"==": "toEqual",
	"!=": "not.toEqual",
};

/**
 * Renders a real vitest matcher on the subject field. The receiver is either
 * "result" (an object-returning operation's return value) or "instance" (a
 * bound component instance for void-returning operations, VERSAILLES-26, and
 * for PRIMITIVE-returning operations, VERSAILLES-185 — a primitive return
 * value has no fields, so `result.<field>` would read undefined) — a
 * fieldless call's return value must never be the assertion subject.
 *
 * ADR-0021: an INSTANCE-receiver assertion on a non-public field renders
 * through the deliberate `(instance as any).<field>` escape (the manifest
 * fieldAccess marks it private/protected — external code cannot read it
 * type-safely by definition). PUBLIC fields never cast, and an absent field
 * model (legacy) keeps `instance.<field>` byte-identical. RESULT-receiver
 * assertions never cast: the return object's fields are not the component's
 * own manifest fields, so fieldAccess does not apply to them.
 */
function renderAssertion(
	assertion: AssertionDescriptor,
	receiver: "result" | "instance",
	component?: string,
	fieldAccess?: EmitOptions["fieldAccess"],
): string {
	const matcher = MATCHER[assertion.op];
	const subject =
		receiver === "instance" &&
		component !== undefined &&
		shouldCastRead(component, assertion.subject, fieldAccess)
			? `(instance as any).${assertion.subject}`
			: `${receiver}.${assertion.subject}`;
	return `expect(${subject}).${matcher}(${renderValue(assertion.literal)})`;
}

/**
 * The effective access modifier for a field: the manifest fieldAccess entry
 * when present, else the permissive default "public" (ADR-0004/0018 —
 * legacy manifests without access data load as accessible).
 */
function accessOf(
	component: string,
	field: string,
	fieldAccess?: EmitOptions["fieldAccess"],
): "public" | "protected" | "private" {
	return fieldAccess?.[component]?.[field] ?? "public";
}

/**
 * READ-site cast decision (ADR-0021): a non-public field (per the manifest
 * fieldAccess) reads through the deliberate `(instance as any).<field>`
 * escape — external code cannot read private/protected state type-safely by
 * definition. PUBLIC fields never cast; an absent field model (legacy) keeps
 * `instance.<field>` byte-identical. readonly does NOT force a read cast (TS
 * readonly never blocks reads).
 */
function shouldCastRead(
	component: string,
	field: string,
	fieldAccess?: EmitOptions["fieldAccess"],
): boolean {
	const access = accessOf(component, field, fieldAccess);
	return access === "private" || access === "protected";
}

/**
 * WRITE-site cast decision (ADR-0021): a pre-state seeding write to a
 * non-public field — OR to a readonly field — renders through the deliberate
 * `(instance as any).<field>` escape. TS readonly is a compile-time-only
 * constraint, so the cast bypasses it at runtime and the seeding coverage is
 * preserved (the balance transition is the point of the example); the field
 * is never silently skipped. Public + non-readonly fields never cast.
 */
function shouldCastWrite(
	component: string,
	field: string,
	fieldAccess?: EmitOptions["fieldAccess"],
	fieldReadonly?: EmitOptions["fieldReadonly"],
): boolean {
	return (
		shouldCastRead(component, field, fieldAccess) ||
		fieldReadonly?.[component]?.[field] === true
	);
}

/**
 * Renders one instance-field READ in an oracle assertion or concrete-case
 * assertion: `instance.<field>` plain for public/unknown fields, the
 * deliberate `(instance as any).<field>` escape for non-public fields
 * (ADR-0021).
 */
function fieldRead(
	component: string,
	field: string,
	fieldAccess?: EmitOptions["fieldAccess"],
): string {
	return shouldCastRead(component, field, fieldAccess)
		? `(instance as any).${field}`
		: `instance.${field}`;
}

/**
 * Maps a source typeRef to the TS type the emitter annotates on an oracle
 * lambda parameter (ADR-0021): number → number, string → string, boolean →
 * boolean, enum<...> → string, and containers (VERSAILLES-175) render
 * RECURSIVELY — list<X> → `X[]`, optional<X> → `X | undefined` (the inner
 * typeRef is recursed, e.g. list<string> → string[], optional<number> →
 * number | undefined, list<list<string>> → string[][]). Returns null for any
 * other typeRef — including a container whose INNER typeRef is itself
 * unrenderable (e.g. list<Order> — a component-typed inner the emitter cannot
 * type) — which is the EMISSION_UNRENDERABLE trigger when the ref came from
 * the field model or a descriptor op-param.
 */
function typeRefToTs(typeRef: string): string | null {
	if (typeRef === "number" || typeRef === "string" || typeRef === "boolean") {
		return typeRef;
	}
	if (typeRef.startsWith("enum<")) {
		return "string";
	}
	if (typeRef.startsWith("list<") && typeRef.endsWith(">")) {
		const inner = typeRefToTs(typeRef.slice("list<".length, -1).trim());
		return inner === null ? null : `${inner}[]`;
	}
	if (typeRef.startsWith("optional<") && typeRef.endsWith(">")) {
		const inner = typeRefToTs(typeRef.slice("optional<".length, -1).trim());
		return inner === null ? null : `${inner} | undefined`;
	}
	return null;
}

/**
 * The TS type for one oracle lambda parameter (ADR-0021):
 *
 * - an OPERATION param is typed UNCONDITIONALLY from the contract op param
 *   typeRef (descriptor.params[].typeRef) — the emitter has the type in the
 *   plan and must not drop it (the TS7006 bug).
 * - a FIELD param (a manifest field, not an op param) is typed ONLY when the
 *   field model carries the field's type (EmitOptions.fieldTypes); an absent
 *   entry (legacy without a field model) keeps the param untyped — the
 *   byte-identical legacy guarantee.
 *
 * Returns null when no type is renderable for the param.
 */
function oracleParamType(
	param: string,
	descriptor: PropertyDescriptor,
	component: string,
	fieldTypes?: EmitOptions["fieldTypes"],
): string | null {
	const spec = descriptor.params.find((s) => s.param === param);
	if (spec !== undefined) {
		return typeRefToTs(spec.typeRef);
	}
	const fieldType = fieldTypes?.[component]?.[param];
	if (fieldType === undefined) {
		return null;
	}
	return typeRefToTs(fieldType);
}

/**
 * Embeds a codegen'd clause predicate with ADR-0021 type annotations injected
 * into the lambda's parameter list: the byte-pinned `(<params>) => <expr>`
 * head is rebuilt with `param: type` on each parameter whose type is
 * renderable (op params unconditionally, field params from the field model).
 * When no parameter carries a type the rebuilt head is byte-identical to the
 * codegen'd source (`(a, b) => ...` → `(a, b) => ...`) — the legacy
 * guarantee. The body is never touched.
 */
function renderOracleCode(
	code: string,
	descriptor: PropertyDescriptor,
	component: string,
	fieldTypes?: EmitOptions["fieldTypes"],
): string {
	const params = oracleParamsOf(code);
	if (params.length === 0) {
		return code;
	}
	const typed = params.map((param) => {
		const type = oracleParamType(param, descriptor, component, fieldTypes);
		return type === null ? param : `${param}: ${type}`;
	});
	const arrow = code.indexOf(") => ");
	if (arrow === -1) {
		return code;
	}
	// `") => "` is 5 chars — slice past the whole arrow so the body keeps its
	// exact leading space (a +4 slice would leave a doubled space).
	return `(${typed.join(", ")}) => ${code.slice(arrow + 5)}`;
}

/**
 * VERSAILLES-175: true when an oracle's lambda parameter list includes a
 * CONTRACT OP PARAM (a descriptor param) whose typeRef has no renderable TS
 * form even after the container extension (e.g. list<Order> — a
 * component-typed inner the emitter cannot type). Embedding such an oracle
 * would force a bare untyped lambda parameter (the TS7006 bug) — the
 * totality-of-emission discipline (ADR-0021) instead DROPS the oracle from the
 * block (its filter/assert never render) and surfaces EMISSION_UNRENDERABLE in
 * renderComponentFile. FIELD params never trigger this: legacy keeps them
 * untyped by design (the byte-identical guarantee, pinned in
 * tests/emitters-pbt.test.ts as `(balance) => balance >= 0`).
 */
function hasUnrenderableOpParam(
	code: string,
	descriptor: PropertyDescriptor,
): boolean {
	return oracleParamsOf(code).some((param) => {
		const spec = descriptor.params.find((s) => s.param === param);
		return spec !== undefined && typeRefToTs(spec.typeRef) === null;
	});
}

/**
 * The descriptor's own asserted clauses that can be embedded type-safely
 * (VERSAILLES-175): a clause whose oracle references an unrenderable op-param
 * is dropped from the assertion set — never embedded as a bare untyped lambda
 * (the block still emits; the EMISSION_UNRENDERABLE warning already surfaced
 * the shape).
 */
function assertableClauses(descriptor: PropertyDescriptor) {
	return descriptor.clauses
		.filter((clause) => !hasUnrenderableOpParam(clause.code, descriptor))
		.map((clause) => ({
			constName: sanitizeId(clause.clauseId),
			oracleParams: oracleParamsOf(clause.code),
		}));
}

function renderCase(
	case_: PlannedCase,
	component: string,
	operation: string,
	methods: EmitOptions["methods"],
	fieldAccess?: EmitOptions["fieldAccess"],
	fieldReadonly?: EmitOptions["fieldReadonly"],
): string[] {
	const title = `${case_.id} — ${case_.description}`;
	const call = renderCall(case_, component, operation, methods);
	const meta = methods?.[component]?.[operation];
	// §9.4 shape awareness: a void-returning operation's accept case must not
	// assert the return value (expect(result).toBeDefined() fails on
	// undefined). Only metadata-driven renders skip it — the legacy default
	// (no methods metadata) keeps the historical toBeDefined assertion.
	const voidAccept =
		meta?.returnType === "void" && case_.expects.outcome === "accept";
	const lines: string[] = [];
	lines.push(`\tit(${JSON.stringify(title)}, () => {`);
	if (case_.expects.outcome === "reject") {
		const idiom = case_.expects.rejectionIdiom ?? "throws";
		switch (idiom) {
			case "throws":
				lines.push(`\t\texpect(() => ${call}).toThrow();`);
				break;
			case "returns":
				lines.push(`\t\texpect(${call}).toBeNull();`);
				break;
			default:
				throw new Error(
					`Unknown rejection idiom "${idiom}" for case "${case_.id}"`,
				);
		}
	} else {
		const assertions = case_.expects.assertions ?? [];
		// VERSAILLES-185: a PRIMITIVE return type (number/string/boolean) has
		// no fields — `result.<field>` on the primitive return value reads
		// `undefined` and can never pass. A field-based assertion on a
		// primitive-returning operation must target the bound INSTANCE's
		// state, exactly like the V-26 void render. Static ops never bind an
		// instance (a static call never touches a constructed object), so the
		// static primitive-returning op keeps the result-bound render below.
		const primitiveReturn =
			meta?.returnType === "number" ||
			meta?.returnType === "string" ||
			meta?.returnType === "boolean";
		// The instance-bound accept-with-assertions render applies to an
		// INSTANCE operation whose return type cannot carry field assertions —
		// void (V-26) or primitive (V-185) — when the case asserts a field.
		// Static ops (the W1 static-void bare call and the static non-void
		// result-bound pin), object-returning ops (result.<field>), and
		// fieldless accept cases without assertions all stay on their existing
		// paths.
		const instanceStateAccept =
			meta !== undefined &&
			!meta.static &&
			(voidAccept || primitiveReturn) &&
			assertions.length > 0;
		if (instanceStateAccept) {
			// VERSAILLES-26/185: a void- or primitive-returning operation's
			// return value carries no fields — `const result = ...;
			// expect(result.<field>)` reads `undefined` on the void return
			// (V-26) or on the primitive number/string/boolean return (V-185)
			// and can never pass. The case binds the component INSTANCE and
			// asserts instance state — `const instance = new <Component>();
			// instance.<op>(...); expect(instance.<field>)` (§9.4).
			// instanceStateAccept guarantees an INSTANCE (non-static) op, so
			// the call always runs on the bound instance.
			lines.push(`\t\tconst instance = new ${component}();`);
			// B1: the assertion literal is derived by the planner from its
			// captured pre-call state, so the emitter must establish that
			// state on the bound instance before the call runs.
			//
			// ADR-0021: a pre-state WRITE to a non-public field (per the
			// manifest fieldAccess) — or to a readonly field, whose
			// compile-time-only restriction the cast bypasses at runtime —
			// renders through the deliberate `(instance as any).<field>`
			// escape. Public fields never cast; legacy (no field model)
			// keeps `instance.<field>` byte-identical.
			const paramNames = new Set(meta.params);
			for (const key of Object.keys(case_.inputs)) {
				if (!paramNames.has(key)) {
					assertIdentifier(key, "pre-state input key");
					const target = shouldCastWrite(
						component,
						key,
						fieldAccess,
						fieldReadonly,
					)
						? `(instance as any).${key}`
						: `instance.${key}`;
					lines.push(`\t\t${target} = ${renderValue(case_.inputs[key])};`);
				}
			}
			lines.push(
				`\t\tinstance.${operation}${renderPositionalArgs(case_, component, operation, methods)};`,
			);
			for (const assertion of assertions) {
				lines.push(
					`\t\t${renderAssertion(assertion, "instance", component, fieldAccess)};`,
				);
			}
		} else if (voidAccept) {
			// The remaining void-accept cases render the bare call:
			// - W1 (VERSAILLES-26 follow-up,
			//   deterministic-generation.contract.yaml): a STATIC void
			//   operation's accept/invariant case — `<Component>.<op>(...);`
			//   — with NO instance binding, NO result binding, and NO
			//   assertions. The static call never touches a constructed
			//   instance, so `expect(instance.<field>)` would assert state on
			//   an object the call cannot have modified — a silently
			//   meaningless assertion.
			// - an INSTANCE void accept case WITHOUT assertions (the F1 pin) —
			//   no result binding, no return-value assertion.
			lines.push(`\t\t${call};`);
		} else {
			lines.push(`\t\tconst result = ${call};`);
			lines.push("\t\texpect(result).toBeDefined();");
			for (const assertion of assertions) {
				lines.push(`\t\t${renderAssertion(assertion, "result")};`);
			}
		}
	}
	lines.push("\t});");
	lines.push("");
	return lines;
}

/**
 * One guard oracle of a property block's guard set (GAP 3, build-spec §9.6):
 * a codegen'd clause predicate that must hold on the inputs reaching the
 * call. `oracleParams` are the arrow function's parameter list, parsed from
 * the byte-pinned `(<params>) => <expr>` codegen output (split at the first
 * `) => `, params on ", "). A param that is not a callback param of the
 * current descriptor is a manifest FIELD (e.g. the invariant `(balance) =>
 * balance >= 0`).
 */
type GuardOracle = {
	/** sanitizeId(clauseId) — the const name in the emitted block. */
	constName: string;
	clauseId: string;
	/** The codegen'd arrow function, embedded verbatim. */
	code: string;
	oracleParams: string[];
};

/**
 * Escapes regex metacharacters in a predicate name before it is embedded in
 * the reference-check regex (Center W4): registry keys flow into
 * `new RegExp(\`\\b${name}\\s*(\`)`, so a hostile or unusual name like
 * "is.positive" or "a+b" would otherwise inject a character class /
 * quantifier and produce a wrong or throwing match.
 */
function escapeRegExp(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The predicate names a component's property clauses reference, ordered by
 * first appearance across the component's descriptors in plan order (GAP 2).
 * The codegen emits each predicate as a bare call `<name>(<args>)` — only a
 * real call reference (name immediately followed by `(`) counts as a
 * reference, never a substring in a longer identifier.
 */
function referencedPredicates(
	componentDescriptors: PropertyDescriptor[],
	predicates: EmitOptions["predicates"],
): string[] {
	if (predicates === undefined) {
		return [];
	}
	const names = Object.keys(predicates);
	const found: string[] = [];
	for (const descriptor of componentDescriptors) {
		for (const clause of descriptor.clauses) {
			for (const name of names) {
				if (found.includes(name)) {
					continue;
				}
				if (new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(clause.code)) {
					found.push(name);
				}
			}
		}
	}
	return found;
}

/**
 * Renders one seeded property block (ADR-0017, build-spec §9.6) — a §9.3
 * tab-indented traceability comment plus an `it` whose body builds the
 * arbitraries, embeds the codegen'd clause oracles verbatim at the it-body
 * level, runs the operation shape-aware, and asserts the outcome.
 *
 * Satisfies / invariant-preserving blocks (GAP 3):
 *
 * - The oracle consts are HOISTED to the it-body level (indent 2) so the SAME
 *   codegen'd arrow function fills both the arbitrary `.filter(...)` and the
 *   in-callback assertion — never a dead const, never duplicated code.
 * - The FILTER oracles are the clause oracles of EVERY satisfies +
 *   invariant-preserving descriptor for the same (component, operation), in
 *   plan order — the "satisfy invariants + all other preconditions" rule.
 * - The call is SHAPE-AWARE (GAP 1): instance → `new <Component>().<op>(
 *   <positional>)`, static → `<Component>.<op>(<positional>)`, with the
 *   descriptor's params in declared order; the legacy options-object static
 *   call is preserved when no methods metadata exists. Satisfies/invariant
 *   blocks render the BARE call (no `const result =` — void-safe; the clause
 *   IS the check).
 * - The assertion `expect(<oracle>(<params>)).toBe(true)` passes each oracle
 *   parameter the callback value when it is a callback param, else
 *   `<instance>.<param>` (a manifest field) — the instance binding
 *   (`const instance = new <Component>(); instance.<op>(...);`) is emitted
 *   when any asserted oracle parameter is a field.
 *
 * Joint-sampling layouts (VERSAILLES-165) — chosen per descriptor from its
 * params + guard oracle set:
 *
 * - MIRROR — the descriptor has a mirror TARGET (its ArbitrarySpec carries
 *   mirrorOf) and every multi-param guard oracle is mirror-satisfied. Only
 *   NON-mirror params get arbitrary declarations and callback params; the
 *   target is derived inside the callback (`const <target> = <source>;`), the
 *   equality oracle is asserted but NEVER filtered (the mirror guarantees it),
 *   and the call uses ALL descriptor params in order.
 * - FIELD-BOUND (Center B1) — the block's OWN asserted multi-param oracle
 *   references a manifest FIELD (a callback param not in descriptor.params,
 *   e.g. `status == newStatus` where status is instance state). No record or
 *   filter can bound the field — it is never a sampled param — so the block
 *   samples ONLY the op-param arbitraries, binds the component instance
 *   (`const instance = new <Component>();`), calls with the sampled params
 *   (positional, matching the concrete-case call shape), and asserts the
 *   oracle with the field mapped to `instance.<field>`. No mirror const, no
 *   record, no filter.
 * - RECORD — ANY guard oracle is multi-param non-mirror. No per-param
 *   arbitrary declarations, no per-param `.filter(...)`: the record carries
 *   the non-mirror params' arbitraries inline, a record-level `.filter(({
 *   <params> }) => <non-mirror oracles joined " && " in guard order>)` guards
 *   the joint region, and the callback DESTRUCTURES the record.
 * - SINGLE-PARAM — all guard oracles single-param (no mirror). The per-param
 *   `.filter(<oracle>)` layout, byte-identical to the pre-joint emitter.
 *
 * Rejects blocks embed NO oracle consts (the clause is never embedded as dead
 * code), NO filter; the block asserts the descriptor's configured rejection
 * idiom (ADR-0007): "throws" → `expect(() => <call>).toThrow()`, "returns" →
 * `expect(<call>).toBeNull()`.
 */
function renderPropertyBlock(
	descriptor: PropertyDescriptor,
	propertyNumRuns: number,
	methods: EmitOptions["methods"],
	guardDescriptors: PropertyDescriptor[],
	fieldAccess?: EmitOptions["fieldAccess"],
	fieldTypes?: EmitOptions["fieldTypes"],
): string[] {
	const lines: string[] = [];
	lines.push(
		`\t// traces: ${descriptor.traces.map((id) => JSON.stringify(id)).join(", ")}`,
	);
	lines.push(`\tit(${JSON.stringify(descriptor.id)}, () => {`);

	const params = descriptor.params.map((spec) => spec.param);
	const paramNames = new Set(params);
	// VERSAILLES-165 joint sampling: the mirror TARGET's spec carries mirrorOf
	// — its value is mirrored from the SOURCE inside the callback, so it never
	// gets its own arbitrary, never filters, never becomes a record key, and
	// never appears in the callback param list.
	const mirrorTargets = new Set(
		descriptor.params
			.filter((spec) => spec.mirrorOf !== undefined)
			.map((spec) => spec.param),
	);
	const nonMirrorParams = params.filter((param) => !mirrorTargets.has(param));

	// Rejects — NO oracle consts (the clause is never embedded as dead code),
	// NO filter; only the descriptor's configured rejection idiom asserts
	// (ADR-0007). Per-param arbitraries render for EVERY param (rejects
	// descriptors never carry mirrors).
	if (descriptor.outcome === "rejects") {
		for (const spec of descriptor.params) {
			assertIdentifier(spec.param, "param name");
			lines.push(`\t\tconst ${spec.param} = ${renderArbitrary(spec)};`);
		}
		const call = renderPropertyCall(descriptor, methods, false);
		lines.push(
			`\t\tconst prop = fc.property(${params.join(", ")}, (${params.join(", ")}) => {`,
		);
		const idiom = descriptor.rejectionIdiom ?? "throws";
		switch (idiom) {
			case "throws":
				lines.push(`\t\t\texpect(() => ${call}).toThrow();`);
				break;
			case "returns":
				lines.push(`\t\t\texpect(${call}).toBeNull();`);
				break;
			default:
				throw new Error(
					`Unknown rejection idiom "${idiom}" for property "${descriptor.id}"`,
				);
		}
		lines.push("\t\t});");
		lines.push(
			`\t\tfc.assert(prop, { seed: ${String(descriptor.seed)}, numRuns: ${String(propertyNumRuns)} });`,
		);
		lines.push("\t});");
		lines.push("");
		return lines;
	}

	// Guard set (GAP 3): the clause oracle of EVERY satisfies +
	// invariant-preserving descriptor for the same (component, operation), in
	// plan order — PLUS each descriptor's `guards` (the renderable
	// SINGLE-PARAM example-strategy sibling oracles, build-spec §9.6). Each
	// callback param referenced by a guard oracle gets `.filter(<first guard
	// oracle referencing it>)` on its arbitrary — so every input reaching the
	// call satisfies ALL sibling oracles.
	const guardOracles: GuardOracle[] = [];
	// Dedupe by clauseId: the same example-strategy guard sits on EVERY
	// single-param sibling descriptor's `guards`, so a naive collection would
	// emit duplicate `const` declarations (a TS redeclaration error) in the
	// block.
	const seenGuardClauseIds = new Set<string>();
	const pushGuardOracle = (clause: {
		clauseId: string;
		code: string;
	}): void => {
		if (seenGuardClauseIds.has(clause.clauseId)) {
			return;
		}
		seenGuardClauseIds.add(clause.clauseId);
		const oracle: GuardOracle = {
			constName: sanitizeId(clause.clauseId),
			clauseId: clause.clauseId,
			code: clause.code,
			oracleParams: oracleParamsOf(clause.code),
		};
		// VERSAILLES-175: an oracle referencing an op-param whose typeRef
		// has no renderable TS form (e.g. list<Order>) cannot be embedded
		// type-safely — dropping it here (its filter/assert never render)
		// is the non-silent alternative to a bare untyped lambda (the
		// TS7006 bug); the EMISSION_UNRENDERABLE warning for the op-param
		// fires in renderComponentFile.
		if (hasUnrenderableOpParam(oracle.code, descriptor)) {
			return;
		}
		guardOracles.push(oracle);
	};
	for (const sibling of guardDescriptors) {
		for (const clause of sibling.clauses) {
			pushGuardOracle(clause);
		}
		for (const guard of sibling.guards ?? []) {
			pushGuardOracle(guard);
		}
	}

	// Joint-layout decision (VERSAILLES-165): classify each guard oracle.
	//   mirror-satisfied — a multi-param oracle whose params include a mirror
	//     target: the mirror construction (`const <target> = <source>;`)
	//     guarantees it, so it is asserted but NEVER filtered.
	//   multi-param non-mirror — a multi-param oracle with no mirror target:
	//     its joint region needs the record + bounded filter — UNLESS the
	//     block's OWN asserted oracle references a manifest FIELD, in which
	//     case it needs the FIELD-BOUND layout (Center B1).
	//   single-param — the per-param `.filter(...)` layout below.
	//
	// A descriptor with a mirror param and NO multi-param non-mirror oracle
	// renders the MIRROR layout; ANY multi-param non-mirror oracle renders the
	// RECORD layout (the planner only passes joint-plannable descriptors, so
	// reaching here is expected — never the old belt-and-suspenders error) —
	// EXCEPT when the block's own asserted multi-param oracle references a
	// manifest field (a param not in descriptor.params): that oracle can never
	// be destructured from the record nor filter the sampled joint region, so
	// the block renders the FIELD-BOUND layout (op-param arbitraries only, the
	// component instance bound, the field mapped to instance.<field> in the
	// assertion). Otherwise every guard oracle is single-param and the
	// per-param layout is byte-identical to the pre-joint emitter.
	const multiParamNonMirror = guardOracles.filter(
		(oracle) =>
			oracle.oracleParams.length > 1 &&
			!oracle.oracleParams.some((param) => mirrorTargets.has(param)),
	);
	const useMirrorLayout =
		mirrorTargets.size > 0 && multiParamNonMirror.length === 0;
	const useRecordLayout = !useMirrorLayout && multiParamNonMirror.length > 0;
	// Center B1 FIELD-BOUND detection: the record layout would be chosen, but
	// the block's OWN asserted oracle is a multi-param oracle referencing a
	// manifest FIELD (a callback param absent from descriptor.params — the
	// same instance-bound signal the single-param layout uses). Sampling a
	// record cannot bound such an oracle — the field is instance state, never a
	// sampled param — so the record/filter layout is wrong for it.
	const fieldBound =
		useRecordLayout &&
		descriptor.clauses.some((clause) => {
			const ps = oracleParamsOf(clause.code);
			return ps.length > 1 && ps.some((param) => !paramNames.has(param));
		});

	const ownClauseIds = new Set(
		descriptor.clauses.map((clause) => clause.clauseId),
	);

	// ── Mirror layout ────────────────────────────────────────────────────────
	// Only NON-mirror params get arbitrary declarations and callback params;
	// the mirror TARGET is derived inside the callback, the equality oracle is
	// asserted but NEVER filtered (the mirror guarantees it), and the call uses
	// ALL descriptor params in order.
	if (useMirrorLayout) {
		for (const spec of descriptor.params) {
			if (spec.mirrorOf !== undefined) {
				continue;
			}
			assertIdentifier(spec.param, "param name");
			lines.push(`\t\tconst ${spec.param} = ${renderArbitrary(spec)};`);
		}
		// The block EMBEDS exactly the guard oracles it uses — its own asserted
		// clauses (the mirror oracle is asserted, never filtered) — in guard
		// order, never a dead const.
		const embedded = guardOracles.filter((oracle) =>
			ownClauseIds.has(oracle.clauseId),
		);
		for (const oracle of embedded) {
			lines.push(
				`\t\tconst ${oracle.constName} = ${renderOracleCode(oracle.code, descriptor, descriptor.component, fieldTypes)};`,
			);
		}
		lines.push(
			`\t\tconst prop = fc.property(${nonMirrorParams.join(", ")}, (${nonMirrorParams.join(", ")}) => {`,
		);
		// Mirror derivation inside the callback, before the call.
		for (const spec of descriptor.params) {
			if (spec.mirrorOf !== undefined) {
				assertIdentifier(spec.mirrorOf, "mirror source param");
				lines.push(`\t\t\tconst ${spec.param} = ${spec.mirrorOf};`);
			}
		}
		const asserted = assertableClauses(descriptor);
		const call = renderPropertyCall(descriptor, methods, false);
		lines.push(`\t\t\t${call};`);
		// Oracle assertion: mirror targets are in-scope locals — pass oracle
		// params directly, never mapped to instance.<field>.
		for (const a of asserted) {
			const args = a.oracleParams.join(", ");
			lines.push(`\t\t\texpect(${a.constName}(${args})).toBe(true);`);
		}
		lines.push("\t\t});");
		lines.push(
			`\t\tfc.assert(prop, { seed: ${String(descriptor.seed)}, numRuns: ${String(propertyNumRuns)} });`,
		);
		lines.push("\t});");
		lines.push("");
		return lines;
	}

	// ── Field-bound layout (Center B1) ──────────────────────────────────────
	// A multi-param oracle in the block's OWN clauses references a manifest
	// FIELD (a callback param not in descriptor.params — e.g. `status ==
	// newStatus` where status is instance state). No record/filter can bound
	// it (the field is never a sampled param), so the block samples ONLY the
	// op-param arbitraries, binds the component instance, calls with the
	// sampled params (positional, matching the concrete-case call shape), and
	// asserts the oracle with the field mapped to instance.<field> — no mirror
	// const, no record, no filter.
	if (fieldBound) {
		// Sample only the op-param arbitraries (a field-bound descriptor never
		// carries a mirror target).
		for (const spec of descriptor.params) {
			assertIdentifier(spec.param, "param name");
			lines.push(`\t\tconst ${spec.param} = ${renderArbitrary(spec)};`);
		}
		// The block EMBEDS exactly the guard oracles it uses — its own asserted
		// clauses (the field-referencing oracle is asserted, never filtered) —
		// in guard order, never a dead const.
		const embedded = guardOracles.filter((oracle) =>
			ownClauseIds.has(oracle.clauseId),
		);
		for (const oracle of embedded) {
			lines.push(
				`\t\tconst ${oracle.constName} = ${renderOracleCode(oracle.code, descriptor, descriptor.component, fieldTypes)};`,
			);
		}
		lines.push(
			`\t\tconst prop = fc.property(${params.join(", ")}, (${params.join(", ")}) => {`,
		);
		// Bind the component instance inside the callback, before the call.
		lines.push(`\t\t\tconst instance = new ${descriptor.component}();`);
		const call = renderPropertyCall(descriptor, methods, true);
		lines.push(`\t\t\t${call};`);
		// Oracle assertion: params stay as callback locals; the field param is
		// read from the bound instance (instance.<field>).
		const asserted = assertableClauses(descriptor);
		for (const a of asserted) {
			const args = a.oracleParams
				.map((p) =>
					paramNames.has(p)
						? p
						: fieldRead(descriptor.component, p, fieldAccess),
				)
				.join(", ");
			lines.push(`\t\t\texpect(${a.constName}(${args})).toBe(true);`);
		}
		lines.push("\t\t});");
		lines.push(
			`\t\tfc.assert(prop, { seed: ${String(descriptor.seed)}, numRuns: ${String(propertyNumRuns)} });`,
		);
		lines.push("\t});");
		lines.push("");
		return lines;
	}

	// ── Record layout ────────────────────────────────────────────────────────
	// No per-param arbitrary declarations, no per-param `.filter(...)` — the
	// record carries the non-mirror params' arbitraries inline and the
	// record-level filter composes ALL non-mirror guard oracles (each invoked
	// with the params it references, joined `&&` in guard order) to guard the
	// joint region. Mirror-satisfied oracles never filter (the mirror
	// guarantees them); field-referencing oracles cannot be destructured from
	// the record (embedded only when the block asserts them itself).
	if (useRecordLayout) {
		const sourceParams = new Set(nonMirrorParams);
		const recordFilterOracles = guardOracles.filter(
			(oracle) =>
				oracle.oracleParams.length > 0 &&
				oracle.oracleParams.every((param) => sourceParams.has(param)),
		);
		// Center S2 (belt-and-suspenders): a record layout whose computed
		// record filter oracle list is EMPTY — every guard oracle is
		// field-referencing and was excluded above — would emit
		// `.filter(({ a, b }) => )` syntax garbage. The planner marks
		// non-field-bound descriptors with field-referencing guard oracles
		// PROPERTY_UNPLANNABLE (the FIELD-BOUND layout is reserved for
		// descriptors whose OWN clause is the field-bound equality), so
		// reaching here means a planner routing gap — refuse loudly rather
		// than emit `filter(({ a, b }) => )` syntax garbage.
		if (recordFilterOracles.length === 0) {
			throw new Error(
				`Refusing to emit: record-layout property "${descriptor.id}" has an empty record filter — every guard oracle is field-referencing and cannot be destructured from the record. The planner marks non-field-bound descriptors with field-referencing guard oracles PROPERTY_UNPLANNABLE, so reaching here is a planner routing gap; refusing loudly instead of emitting \`filter(({ ... }) => )\` syntax garbage.`,
			);
		}
		const filterConsts = new Set(
			recordFilterOracles.map((oracle) => oracle.constName),
		);
		const embedded = guardOracles.filter(
			(oracle) =>
				filterConsts.has(oracle.constName) || ownClauseIds.has(oracle.clauseId),
		);
		for (const oracle of embedded) {
			lines.push(
				`\t\tconst ${oracle.constName} = ${renderOracleCode(oracle.code, descriptor, descriptor.component, fieldTypes)};`,
			);
		}
		const recordEntries = descriptor.params
			.filter((spec) => spec.mirrorOf === undefined)
			.map((spec) => `${spec.param}: ${renderArbitrary(spec)}`);
		const filterBody = recordFilterOracles
			.map((oracle) => `${oracle.constName}(${oracle.oracleParams.join(", ")})`)
			.join(" && ");
		lines.push("\t\tconst prop = fc.property(");
		lines.push(`\t\t\tfc.record({ ${recordEntries.join(", ")} })`);
		lines.push(
			`\t\t\t\t.filter(({ ${nonMirrorParams.join(", ")} }) => ${filterBody}),`,
		);
		lines.push(`\t\t\t({ ${nonMirrorParams.join(", ")} }) => {`);
		// Mirror params carry no record key — derived inside the callback.
		for (const spec of descriptor.params) {
			if (spec.mirrorOf !== undefined) {
				assertIdentifier(spec.mirrorOf, "mirror source param");
				lines.push(`\t\t\t\tconst ${spec.param} = ${spec.mirrorOf};`);
			}
		}
		const asserted = assertableClauses(descriptor);
		const instanceBound = asserted.some((a) =>
			a.oracleParams.some((p) => !paramNames.has(p)),
		);
		const call = renderPropertyCall(descriptor, methods, instanceBound);
		if (instanceBound) {
			lines.push(`\t\t\t\tconst instance = new ${descriptor.component}();`);
		}
		lines.push(`\t\t\t\t${call};`);
		for (const a of asserted) {
			const args = a.oracleParams
				.map((p) =>
					paramNames.has(p)
						? p
						: fieldRead(descriptor.component, p, fieldAccess),
				)
				.join(", ");
			lines.push(`\t\t\t\texpect(${a.constName}(${args})).toBe(true);`);
		}
		lines.push("\t\t\t}");
		lines.push("\t\t);");
		lines.push(
			`\t\tfc.assert(prop, { seed: ${String(descriptor.seed)}, numRuns: ${String(propertyNumRuns)} });`,
		);
		lines.push("\t});");
		lines.push("");
		return lines;
	}

	// ── Single-param layout (byte-identical to the pre-joint emitter) ────────
	for (const spec of descriptor.params) {
		assertIdentifier(spec.param, "param name");
		lines.push(`\t\tconst ${spec.param} = ${renderArbitrary(spec)};`);
	}
	const filters = new Map<string, string>();
	for (const param of params) {
		const first = guardOracles.find((oracle) =>
			oracle.oracleParams.includes(param),
		);
		if (first !== undefined) {
			// B1 belt-and-suspenders (last-resort invariant): the joint-layout
			// decision above routes every multi-param guard oracle to the
			// mirror/record layouts, so a multi-param oracle reaching this
			// branch is an internal invariant violation — refuse loudly rather
			// than emit a broken property.
			if (first.oracleParams.length > 1) {
				throw new Error(
					`Refusing to emit: guard oracle ${first.constName} (${first.clauseId}) takes ${first.oracleParams.length} callback params — fast-check's .filter() passes one value, so property "${descriptor.id}" cannot filter its arbitrary to a valid region`,
				);
			}
			filters.set(param, first.constName);
		}
	}
	const filterConsts = new Set(filters.values());
	const embedded = guardOracles.filter(
		(oracle) =>
			filterConsts.has(oracle.constName) || ownClauseIds.has(oracle.clauseId),
	);
	for (const oracle of embedded) {
		lines.push(
			`\t\tconst ${oracle.constName} = ${renderOracleCode(oracle.code, descriptor, descriptor.component, fieldTypes)};`,
		);
	}
	const arbitraryExprs = descriptor.params.map((spec) => {
		const filter = filters.get(spec.param);
		return filter === undefined
			? spec.param
			: `${spec.param}.filter(${filter})`;
	});
	lines.push(
		`\t\tconst prop = fc.property(${arbitraryExprs.join(", ")}, (${params.join(", ")}) => {`,
	);

	// Oracle assertion (GAP 3): the block's own clauses. An oracle parameter
	// that is not a callback param is a manifest FIELD — the block binds the
	// component instance and asserts instance.<field> through the oracle.
	const asserted = assertableClauses(descriptor);
	const instanceBound = asserted.some((a) =>
		a.oracleParams.some((p) => !paramNames.has(p)),
	);

	const call = renderPropertyCall(descriptor, methods, instanceBound);
	if (instanceBound) {
		lines.push(`\t\t\tconst instance = new ${descriptor.component}();`);
	}
	lines.push(`\t\t\t${call};`);

	for (const a of asserted) {
		const args = a.oracleParams
			.map((p) =>
				paramNames.has(p) ? p : fieldRead(descriptor.component, p, fieldAccess),
			)
			.join(", ");
		lines.push(`\t\t\texpect(${a.constName}(${args})).toBe(true);`);
	}
	lines.push("\t\t});");
	lines.push(
		`\t\tfc.assert(prop, { seed: ${String(descriptor.seed)}, numRuns: ${String(propertyNumRuns)} });`,
	);
	lines.push("\t});");
	lines.push("");
	return lines;
}

/**
 * The shape-aware property call (GAP 1) — reuses renderCall's callee
 * computation (VERSAILLES-20 F1, build-spec §9.4): instance →
 * `new <Component>().<op>(<positional>)`, static → `<Component>.<op>(
 * <positional>)`, with the descriptor's callback param names in declared
 * order. With NO methods metadata (legacy) the historical static
 * options-object call `<Component>.<op>({ <params> })` is preserved
 * byte-identically. When the block binds the component instance (a
 * field-referencing oracle is asserted), the call runs on the bound instance
 * — `instance.<op>(...)` (mirrors the concrete-case VERSAILLES-26 render).
 */
function renderPropertyCall(
	descriptor: PropertyDescriptor,
	methods: EmitOptions["methods"],
	instanceBound: boolean,
): string {
	const component = descriptor.component;
	const operation = descriptor.operation;
	const meta = methods?.[component]?.[operation];
	const params = descriptor.params.map((spec) => spec.param);
	if (meta === undefined) {
		const args = `{ ${params.join(", ")} }`;
		return instanceBound
			? `instance.${operation}(${args})`
			: `${component}.${operation}(${args})`;
	}
	const args = `(${params.join(", ")})`;
	if (instanceBound) {
		return `instance.${operation}${args}`;
	}
	const callee = meta.static
		? `${component}.${operation}`
		: `new ${component}().${operation}`;
	return `${callee}${args}`;
}

/**
 * Renders one per-param arbitrary (ArbitrarySpec → fast-check call). The
 * deterministic `default` (list<X> → `fc.constant([])`, optional<X> →
 * `fc.constant(<inner default>)`) wins over the kind; otherwise kind selects
 * the arbitrary family: number with bounds → `fc.integer({ min, max })`,
 * number without → `fc.integer()`, enum → `fc.constantFrom(<members>)`
 * (JSON-stringified, joined ", "), string → `fc.string()`, boolean →
 * `fc.boolean()`.
 */
function renderArbitrary(spec: ArbitrarySpec): string {
	if (spec.default !== undefined) {
		return `fc.constant(${renderValue(spec.default)})`;
	}
	switch (spec.kind) {
		case "number":
			if (spec.bounds !== undefined) {
				return `fc.integer({ min: ${spec.bounds.min}, max: ${spec.bounds.max} })`;
			}
			return "fc.integer()";
		case "enum": {
			const members = (spec.members ?? [])
				.map((member) => JSON.stringify(member))
				.join(", ");
			return `fc.constantFrom(${members})`;
		}
		case "string":
			return "fc.string()";
		case "boolean":
			return "fc.boolean()";
	}
}

/**
 * Shape-aware call rendering from manifest method metadata (VERSAILLES-20 F1,
 * deterministic-generation.contract.yaml §9.4):
 *
 * - instance method → `new <Component>().<op>(<positional args>)`
 * - static method  → `<Component>.<op>(<positional args>)`
 * - params pass POSITIONALLY in the metadata's declared order, looked up in
 *   the case inputs by name — a declared param missing from inputs renders
 *   the deterministic default `undefined`, and captured pre-call state (e.g.
 *   balance) never leaks into the call because only declared params are read.
 *
 * Legacy default (no methods metadata for the component+operation): today's
 * static options-object call `<Component>.<op>({ ...inputs })` is preserved
 * byte-identically, keeping existing suites (tests/generator.test.ts and the
 * backward-compat pin in tests/emitters.test.ts) green.
 */
function renderCall(
	case_: PlannedCase,
	component: string,
	operation: string,
	methods: EmitOptions["methods"],
): string {
	const meta = methods?.[component]?.[operation];
	if (meta === undefined) {
		return `${component}.${operation}(${renderObjectLiteral(case_.inputs)})`;
	}
	const callee = meta.static
		? `${component}.${operation}`
		: `new ${component}().${operation}`;
	return `${callee}${renderPositionalArgs(case_, component, operation, methods)}`;
}

/**
 * The positional argument list `(<args>)` from the declared metadata params,
 * in declared order (VERSAILLES-20 F1). Split out of renderCall so the
 * void-with-assertions path can invoke a bound instance
 * (`instance.<op>(<args>)`) while reusing the exact same argument computation
 * (VERSAILLES-26). Callers must guarantee method metadata is present (the
 * renderCall meta guard, or the voidAccept branch where meta is defined).
 */
function renderPositionalArgs(
	case_: PlannedCase,
	component: string,
	operation: string,
	methods: EmitOptions["methods"],
): string {
	const meta = methods?.[component]?.[operation];
	if (meta === undefined) {
		throw new Error(
			`Cannot render positional args for "${component}.${operation}" — no method metadata`,
		);
	}
	const args = meta.params.map((param) => {
		assertIdentifier(param, "param name");
		return renderValue(case_.inputs[param]);
	});
	return `(${args.join(", ")})`;
}

/**
 * The operation name is the second segment of "<component>.<operation>.<kind>-<n>".
 * With the id format pinned by Center B1 the segment is always present — a
 * malformed id is a hard error, never masked by a fallback.
 */
function operationOf(case_: PlannedCase): string {
	const parts = case_.id.split(".");
	if (parts.length < 2 || parts[1].length === 0) {
		throw new Error(
			`Cannot derive the operation name from case id "${case_.id}" — expected "<component>.<operation>.<kind>-<n>"`,
		);
	}
	return parts[1];
}

function renderObjectLiteral(inputs: Record<string, unknown>): string {
	const entries = Object.entries(inputs).map(([key, value]) => {
		assertIdentifier(key, "input key");
		return `${key}: ${renderValue(value)}`;
	});
	return `{ ${entries.join(", ")} }`;
}

function renderValue(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(renderValue).join(", ")}]`;
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
}
