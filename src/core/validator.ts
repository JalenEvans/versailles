/**
 * The semantic validator — the second half of the contract-language validation
 * kernel (build-spec §5). Runs AFTER a successful parse, against the FULL
 * workspace context (contracts + manifests + predicates — the loader's
 * VersaillesContext), and implements every §5.1 check row: field resolution,
 * type compatibility, in-operand shape, predicate existence/arity/arg-types,
 * the verifiedPure gate (ADR-0006), and the low-confidence warning tier
 * (ADR-0004).
 *
 * The validator never throws an unstructured exception: a missing component
 * manifest, missing operation, or missing predicate entry is a structured
 * resolution failure, not a crash (build-spec §5.2, ADR-0010).
 *
 * Pinned resolution decisions (see tests/validator.test.ts):
 * - Scope precedence: pre/post resolve roots against operation params FIRST,
 *   then component manifest fields (params shadow same-named fields);
 *   invariants resolve against component manifest fields ONLY.
 * - `in` violations split into two codes: a shape violation (RHS is not a
 *   list_literal and not a list<T>/enum<...>-typed field) → INVALID_IN_OPERAND;
 *   a list_literal whose member types don't match → TYPE_MISMATCH.
 * - error.field is the construct descriptor inside the clause (dotted path,
 *   "predicateCall(<name>)", "old"), NOT the clause entry index.
 * - confidence: "inferred" on a manifest field entry → LOW_CONFIDENCE_FIELD
 *   warning; valid stays true.
 * - UNVERIFIED_PREDICATE covers verifiedPure: false AND verifiedPure missing.
 * - arithmetic → scalar number; no operand-type checks on arithmetic.
 * - Index segments ([N]/[]) are valid only on list<T> → strip to element.
 * - A predicateCall term resolves to its registered returnType; unresolvable
 *   terms suppress downstream type checks on that term only.
 * - warnings dedupe by (code, field); valid === errors.length === 0.
 */
import type { VersaillesContext } from "../loader/workspace.js";
import type { ClauseKind, FieldPath, LiteralList, Node } from "./parser.js";

export type ValidationErrorCode =
	| "UNKNOWN_FIELD"
	| "UNRESOLVED_NESTED_FIELD"
	| "TYPE_MISMATCH"
	| "INVALID_IN_OPERAND"
	| "OLD_SCOPE"
	| "UNKNOWN_PREDICATE"
	| "PREDICATE_ARITY"
	| "PREDICATE_ARG_TYPE"
	| "UNVERIFIED_PREDICATE";

export type ValidationWarningCode = "LOW_CONFIDENCE_FIELD";

export type ValidationError = {
	contractId: string;
	code: ValidationErrorCode;
	field: string;
	detail: string;
};

export type ValidationWarning = {
	code: ValidationWarningCode;
	field: string;
	detail: string;
};

export type ValidationResult = {
	valid: boolean;
	errors: ValidationError[];
	warnings: ValidationWarning[];
};

export type ValidatorScope = { component: string; operation?: string };

/**
 * typeRef grammar (build-spec §3.3): string | number | boolean |
 * <ComponentName> | list<typeRef> | optional<typeRef> | enum<v1,v2,...>.
 */
export type ResolvedType =
	| { kind: "scalar"; name: "string" | "number" | "boolean" }
	| { kind: "component"; name: string }
	| { kind: "list"; element: ResolvedType }
	| { kind: "optional"; inner: ResolvedType }
	| { kind: "enum"; members: (string | number | boolean)[] };

/**
 * A resolved term: the ResolvedType plus enough literal context to run the
 * compatibility rules. `literalValue` is present for scalar literals (and null);
 * `listValues` is present for list literals — enum membership checks need the
 * actual values, which a bare ResolvedType does not carry.
 */
type TermResolved = {
	resolved: ResolvedType | null;
	// Construct descriptor inside the clause (dotted path, "predicateCall(x)",
	// "old", literal text). Optional because type-only comparisons (e.g. the
	// element comparison inside list compatibility) carry no descriptor.
	descriptor?: string;
	literalValue?: string | number | boolean | null;
	listValues?: (string | number | boolean | null)[];
};

type Confidence = "inferred" | "declared";

type ManifestFieldEntry = {
	typeRef: string;
	confidence: Confidence;
};

type WalkState = {
	context: VersaillesContext;
	scope: ValidatorScope;
	clauseKind: ClauseKind;
	clauseId: string;
	errors: ValidationError[];
	warnings: ValidationWarning[];
	warningKeys: Set<string>;
};

type RootResolution = {
	type: ResolvedType | null;
	confidence: Confidence;
};

export function semanticValidate(
	ast: Node,
	clauseKind: ClauseKind,
	clauseId: string,
	context: VersaillesContext,
	scope: ValidatorScope,
): ValidationResult {
	const state: WalkState = {
		context,
		scope,
		clauseKind,
		clauseId,
		errors: [],
		warnings: [],
		warningKeys: new Set(),
	};
	walkNode(state, ast);
	return {
		valid: state.errors.length === 0,
		errors: state.errors,
		warnings: state.warnings,
	};
}

function walkNode(state: WalkState, node: Node): void {
	switch (node.type) {
		case "or":
		case "and":
			walkNode(state, node.left);
			walkNode(state, node.right);
			return;
		case "not":
			walkNode(state, node.operand);
			return;
		case "compare":
			handleCompare(state, node);
			return;
		default:
			resolveTerm(state, node);
	}
}

/**
 * Resolves a term node to its type, emitting any hard errors / warnings the
 * resolution finds. Returns a TermResolved with `resolved: null` when the term
 * failed to resolve (the error has already been reported) so callers can
 * suppress downstream type checks on that term (pinned decision 8).
 */
function resolveTerm(state: WalkState, node: Node): TermResolved {
	switch (node.type) {
		case "literal":
			return resolveLiteralTerm(node);
		case "fieldRef":
			return resolveFieldPath(state, node.path);
		case "old":
			return resolveOldTerm(state, node);
		case "predicateCall":
			return resolvePredicate(state, node);
		case "arithmetic":
			return resolveArithmeticTerm(state, node);
		default:
			// or/and/not/compare are handled by walkNode; a term context that
			// reaches them here has nothing to resolve.
			return { resolved: null, descriptor: "term" };
	}
}

function handleCompare(
	state: WalkState,
	node: Extract<Node, { type: "compare" }>,
): void {
	if (node.op === "in") {
		handleInCompare(state, node);
		return;
	}

	const left = resolveTerm(state, node.left);
	const right = resolveTerm(state, node.right);
	if (left.resolved === null || right.resolved === null) {
		return;
	}
	if (!compatible(left.resolved, right)) {
		addError(
			state,
			"TYPE_MISMATCH",
			termDescriptor(left),
			`The type of "${termDescriptor(left)}" is incompatible with "${termDescriptor(right)}"`,
		);
	}
}

/**
 * The `in` operator (pinned decision 2): a shape violation on the RHS is
 * INVALID_IN_OPERAND; a list_literal whose members don't match the left-hand
 * type is TYPE_MISMATCH (the RHS is list-shaped; the failure is member
 * incompatibility).
 */
function handleInCompare(
	state: WalkState,
	node: Extract<Node, { type: "compare" }>,
): void {
	const right = resolveTerm(state, node.right);
	if (right.resolved === null) {
		return;
	}

	const rightIsListLiteral =
		node.right.type === "literal" && Array.isArray(node.right.value);
	const rightIsListField = right.resolved.kind === "list";
	const rightIsEnumField = right.resolved.kind === "enum";

	if (!rightIsListLiteral && !rightIsListField && !rightIsEnumField) {
		addError(
			state,
			"INVALID_IN_OPERAND",
			termDescriptor(right),
			`The right-hand side of 'in' must be a list literal or a list/enum-typed field, not "${termDescriptor(right)}"`,
		);
		return;
	}

	const left = resolveTerm(state, node.left);
	if (left.resolved === null) {
		return;
	}

	let matches: boolean;
	if (node.right.type === "literal" && Array.isArray(node.right.value)) {
		matches = checkInMembers(left.resolved, node.right.value);
	} else {
		matches = compatible(left.resolved, right);
	}
	if (!matches) {
		addError(
			state,
			"TYPE_MISMATCH",
			termDescriptor(left),
			`The type of "${termDescriptor(left)}" is incompatible with the right-hand side of 'in'`,
		);
	}
}

function resolveLiteralTerm(
	node: Extract<Node, { type: "literal" }>,
): TermResolved {
	const value = node.value;
	if (Array.isArray(value)) {
		const element =
			value.length > 0
				? (literalTerm(value[0]).resolved ?? { kind: "scalar", name: "string" })
				: ({ kind: "scalar", name: "string" } as const);
		return {
			resolved: { kind: "list", element },
			descriptor: String(value),
			listValues: [...value],
		};
	}
	return literalTerm(value);
}

function literalTerm(value: string | number | boolean | null): TermResolved {
	if (value === null) {
		return {
			resolved: { kind: "scalar", name: "string" },
			descriptor: "null",
			literalValue: null,
		};
	}
	if (typeof value === "number") {
		return {
			resolved: { kind: "scalar", name: "number" },
			descriptor: String(value),
			literalValue: value,
		};
	}
	if (typeof value === "boolean") {
		return {
			resolved: { kind: "scalar", name: "boolean" },
			descriptor: String(value),
			literalValue: value,
		};
	}
	return {
		resolved: { kind: "scalar", name: "string" },
		descriptor: value,
		literalValue: value,
	};
}

function resolveOldTerm(
	state: WalkState,
	node: Extract<Node, { type: "old" }>,
): TermResolved {
	if (state.clauseKind !== "postconditions") {
		addError(
			state,
			"OLD_SCOPE",
			"old",
			`old(...) is only valid inside postconditions, not ${state.clauseKind}`,
		);
		return { resolved: null, descriptor: "old" };
	}
	const inner = resolveFieldPath(state, node.ref.path);
	return { resolved: inner.resolved, descriptor: "old" };
}

/**
 * Predicate resolution (build-spec §5.1 rows F–I + ADR-0006): existence,
 * verifiedPure gate, arity, per-arg type compatibility. On success the term
 * resolves to the registered returnType (pinned decision 8).
 */
function resolvePredicate(
	state: WalkState,
	node: Extract<Node, { type: "predicateCall" }>,
): TermResolved {
	const descriptor = `predicateCall(${node.name})`;
	const registry = state.context.predicates?.predicates ?? {};
	const entry = registry[node.name];
	if (entry === undefined) {
		addError(
			state,
			"UNKNOWN_PREDICATE",
			descriptor,
			`Predicate "${node.name}" is not registered in predicates.json`,
		);
		return { resolved: null, descriptor };
	}

	// ADR-0006: verifiedPure must be exactly true; false or missing are hard
	// errors (pinned decision 5).
	if (entry.verifiedPure !== true) {
		addError(
			state,
			"UNVERIFIED_PREDICATE",
			descriptor,
			`Predicate "${node.name}" is not verified pure (verifiedPure must be true)`,
		);
		return { resolved: null, descriptor };
	}

	const params = Array.isArray(entry.params) ? entry.params : [];
	if (node.args.length !== params.length) {
		addError(
			state,
			"PREDICATE_ARITY",
			descriptor,
			`Predicate "${node.name}" expects ${params.length} argument(s) but got ${node.args.length}`,
		);
		return { resolved: null, descriptor };
	}

	const paramTypes = Array.isArray(entry.paramTypes) ? entry.paramTypes : [];
	for (let i = 0; i < node.args.length; i++) {
		const arg = resolveTerm(state, node.args[i]);
		if (arg.resolved === null) {
			continue;
		}
		const declaredType = parseTypeRef(paramTypes[i] ?? "");
		if (declaredType === null) {
			continue;
		}
		if (!compatible(declaredType, arg)) {
			addError(
				state,
				"PREDICATE_ARG_TYPE",
				descriptor,
				`Argument ${i + 1} of predicate "${node.name}" has an incompatible type`,
			);
		}
	}

	const returnType = parseTypeRef(entry.returnType ?? "");
	return { resolved: returnType, descriptor };
}

/**
 * Arithmetic resolves to scalar number (pinned decision 6). Operand type
 * checks are out of scope for the §5.1 table, but operands are still walked so
 * their field refs resolve (and can warn) — only type compatibility is skipped.
 */
function resolveArithmeticTerm(
	state: WalkState,
	node: Extract<Node, { type: "arithmetic" }>,
): TermResolved {
	resolveTerm(state, node.left);
	resolveTerm(state, node.right);
	return {
		resolved: { kind: "scalar", name: "number" },
		descriptor: "arithmetic",
	};
}

/**
 * Root + transitive nested field resolution (build-spec §5.1 rows A–C).
 * The root resolves params-first for pre/postconditions and manifest-only for
 * invariants (pinned decision 1); each subsequent `.` segment resolves through
 * the referenced type's manifest entry; index segments strip list<T> to T
 * (pinned decision 7) and are UNRESOLVED_NESTED_FIELD on any other type.
 */
function resolveFieldPath(state: WalkState, path: FieldPath): TermResolved {
	const root = path[0];
	if (typeof root !== "string") {
		return { resolved: null, descriptor: String(root) };
	}

	const rootResolved = resolveRoot(state, root);
	if (rootResolved.type === null) {
		// ADR-0011 (contract-first emission): when manifests is null (greenfield
		// workspace), skip UNKNOWN_FIELD errors for field references that are not
		// params. The fields will be derived from contracts at emit time, or the
		// user will add them to manifests later. Param references still validate
		// correctly because resolveRoot checks params first.
		if (state.context.manifests !== null) {
			addError(
				state,
				"UNKNOWN_FIELD",
				root,
				`Field "${root}" does not exist in the ${scopeName(state)} scope`,
			);
		}
		return { resolved: null, descriptor: root };
	}
	if (rootResolved.confidence === "inferred") {
		addLowConfidenceWarning(state, root);
	}

	let current = rootResolved.type;
	let descriptor = root;
	for (let i = 1; i < path.length; i++) {
		const segment = path[i];
		const nextDescriptor = appendDescriptor(descriptor, segment);

		// The parser emits the [] wildcard as the STRING "[]" (parser.ts
		// parseFieldRefSuffixes). Dispatch it as an index — strip list<T> to T
		// (pinned decision 7) — not as a nested field name.
		if (typeof segment === "string" && segment !== "[]") {
			if (current.kind !== "component") {
				addError(
					state,
					"UNRESOLVED_NESTED_FIELD",
					nextDescriptor,
					`Cannot resolve nested field "${nextDescriptor}" — "${descriptor}" is not a component type`,
				);
				return { resolved: null, descriptor: nextDescriptor };
			}

			const typeEntry = getManifestEntry(state.context, current.name);
			if (typeEntry === null) {
				addError(
					state,
					"UNRESOLVED_NESTED_FIELD",
					nextDescriptor,
					`Cannot resolve nested field "${nextDescriptor}" — type "${current.name}" has no manifest entry`,
				);
				return { resolved: null, descriptor: nextDescriptor };
			}

			const fieldEntry = typeEntry.fields[segment];
			if (fieldEntry === undefined) {
				addError(
					state,
					"UNRESOLVED_NESTED_FIELD",
					nextDescriptor,
					`Cannot resolve nested field "${nextDescriptor}" — "${current.name}" has no field "${segment}"`,
				);
				return { resolved: null, descriptor: nextDescriptor };
			}

			const parsed = parseManifestField(fieldEntry);
			const fieldType = parseTypeRef(parsed.typeRef);
			if (fieldType === null) {
				addError(
					state,
					"UNRESOLVED_NESTED_FIELD",
					nextDescriptor,
					`Cannot resolve nested field "${nextDescriptor}" — "${parsed.typeRef}" is not a valid type reference`,
				);
				return { resolved: null, descriptor: nextDescriptor };
			}
			if (parsed.confidence === "inferred") {
				addLowConfidenceWarning(state, nextDescriptor);
			}

			current = fieldType;
			descriptor = nextDescriptor;
			continue;
		}

		if (current.kind !== "list") {
			addError(
				state,
				"UNRESOLVED_NESTED_FIELD",
				nextDescriptor,
				`Cannot apply index "${indexDescriptor(segment)}" — "${descriptor}" is not a list type`,
			);
			return { resolved: null, descriptor: nextDescriptor };
		}
		current = current.element;
		descriptor = nextDescriptor;
	}

	return { resolved: current, descriptor };
}

function resolveRoot(state: WalkState, name: string): RootResolution {
	// Pre/postconditions resolve params FIRST (they shadow manifest fields).
	if (state.clauseKind !== "invariants") {
		const param = findOperationParam(state.context, state.scope, name);
		if (param !== null) {
			return { type: parseTypeRef(param.type), confidence: "declared" };
		}
	}

	const manifestEntry = getManifestEntry(state.context, state.scope.component);
	if (manifestEntry === null) {
		return { type: null, confidence: "declared" };
	}
	const rawEntry = manifestEntry.fields[name];
	if (rawEntry === undefined) {
		return { type: null, confidence: "declared" };
	}
	const parsed = parseManifestField(rawEntry);
	return { type: parseTypeRef(parsed.typeRef), confidence: parsed.confidence };
}

function findOperationParam(
	context: VersaillesContext,
	scope: ValidatorScope,
	name: string,
): { name: string; type: string } | null {
	if (context.contracts === null || scope.operation === undefined) {
		return null;
	}
	const component = context.contracts.contracts[scope.component];
	if (component === undefined) {
		return null;
	}
	const operation = component.operations[scope.operation];
	if (operation === undefined) {
		return null;
	}
	// Defense-in-depth (chunk 3.4b, B1): the loader shape guard flags a
	// non-array / null-element params array as INVALID_SHAPE before any
	// semantic validation runs, but a direct semanticValidate caller can
	// still hand us a malformed operation. Mirror the predicate-params
	// pattern in resolvePredicate and skip null/primitive entries instead
	// of reading `.name` unguarded (ADR-0010 never-throws).
	const params = Array.isArray(operation.params) ? operation.params : [];
	return params.find((param) => param?.name === name) ?? null;
}

function getManifestEntry(
	context: VersaillesContext,
	name: string,
): { sourceHash: string; fields: Record<string, string> } | null {
	if (context.manifests === null) {
		return null;
	}
	return context.manifests.manifests[name] ?? null;
}

/**
 * A manifest field entry is either the §3.3 plain typeRef string (declared,
 * full confidence) or the ADR-0004 extension object carrying an explicit
 * confidence tier (pinned decision 4). The validator reads either form.
 */
function parseManifestField(raw: unknown): ManifestFieldEntry {
	if (typeof raw === "string") {
		return { typeRef: raw, confidence: "declared" };
	}
	if (raw !== null && typeof raw === "object") {
		const record = raw as { type?: unknown; confidence?: unknown };
		if (typeof record.type === "string") {
			return {
				typeRef: record.type,
				confidence: record.confidence === "inferred" ? "inferred" : "declared",
			};
		}
	}
	return { typeRef: "", confidence: "declared" };
}

/**
 * Maximum number of list< / optional< wrappers accepted in a single typeRef.
 * Bounds the ResolvedType depth so compatible()'s per-nesting recursion (one
 * frame per list/optional level) can never overflow the call stack on a
 * pathologically deep reference — a same-family compare like `total == total`
 * with total = list<list<...>> would otherwise recurse 20000 levels deep and
 * throw RangeError (chunk 3.4b, W1). The parser's own MAX_PARSE_DEPTH (256)
 * bounds expression nesting; typeRefs live in manifest/param JSON and are not
 * parsed, so they get their own cap. 512 gives headroom above that while
 * keeping any one compare well inside the JS call stack. Refs nested past the
 * cap resolve to null → structured UNKNOWN_FIELD / UNRESOLVED_NESTED_FIELD
 * errors, never a throw.
 */
const MAX_TYPE_REF_DEPTH = 512;

/**
 * Parses a typeRef (build-spec §3.3) into a ResolvedType. Returns null for an
 * empty or structurally invalid reference so callers can fail resolution
 * structurally. Iterative (chunk 3.4a, F2): outer wrappers (list<, optional<)
 * are peeled off in a loop and unwrapped inside-out, so a pathologically deep
 * typeRef (e.g. "list<" repeated 20000×) cannot overflow the call stack — the
 * previous recursive form threw RangeError at depth ~10000. References nested
 * past MAX_TYPE_REF_DEPTH are rejected (return null) rather than producing a
 * ResolvedType deep enough to overflow compatible()'s recursion (chunk 3.4b,
 * W1).
 */
function parseTypeRef(ref: string): ResolvedType | null {
	// Defense-in-depth: a malformed manifest may carry a non-string typeRef.
	if (typeof ref !== "string") {
		return null;
	}
	const stack: ("list" | "optional")[] = [];
	let current = ref.trim();
	for (;;) {
		if (current === "") {
			return null;
		}
		if (current === "string" || current === "number" || current === "boolean") {
			return wrapTypeRef(stack, { kind: "scalar", name: current });
		}
		if (current.startsWith("list<") && current.endsWith(">")) {
			if (stack.length >= MAX_TYPE_REF_DEPTH) {
				return null;
			}
			stack.push("list");
			current = current.slice("list<".length, -1).trim();
			continue;
		}
		if (current.startsWith("optional<") && current.endsWith(">")) {
			if (stack.length >= MAX_TYPE_REF_DEPTH) {
				return null;
			}
			stack.push("optional");
			current = current.slice("optional<".length, -1).trim();
			continue;
		}
		if (current.startsWith("enum<") && current.endsWith(">")) {
			const members = current
				.slice("enum<".length, -1)
				.split(",")
				.map((member) => member.trim())
				.filter((member) => member !== "")
				.map(parseEnumMember);
			return wrapTypeRef(stack, { kind: "enum", members });
		}
		return wrapTypeRef(stack, { kind: "component", name: current });
	}
}

/**
 * Builds a ResolvedType from the inside out: the innermost base type wrapped
 * by every peeled wrapper, outermost first (stack bottom = outermost).
 */
function wrapTypeRef(
	stack: ("list" | "optional")[],
	inner: ResolvedType,
): ResolvedType {
	let resolved = inner;
	for (let i = stack.length - 1; i >= 0; i--) {
		resolved =
			stack[i] === "list"
				? { kind: "list", element: resolved }
				: { kind: "optional", inner: resolved };
	}
	return resolved;
}

function parseEnumMember(raw: string): string | number | boolean {
	if (raw === "true") {
		return true;
	}
	if (raw === "false") {
		return false;
	}
	if (/^[0-9]+$/.test(raw)) {
		return Number(raw);
	}
	return raw;
}

/**
 * compatible(declared, actual) — the compatibility rules pinned in the test
 * header. `actual` is a TermResolved so scalar/enum literals can carry their
 * values (enum membership is value-based, not name-based).
 */
function compatible(declared: ResolvedType, actual: TermResolved): boolean {
	// null literal is permissive — the "x != null" guard idiom.
	if (actual.literalValue === null) {
		return true;
	}

	// optional<T> unwraps to T (also accepts null, handled above).
	if (declared.kind === "optional") {
		return compatible(declared.inner, actual);
	}

	switch (declared.kind) {
		case "scalar":
			return (
				actual.resolved !== null &&
				actual.resolved.kind === "scalar" &&
				actual.resolved.name === declared.name
			);
		case "component":
			return (
				actual.resolved !== null &&
				actual.resolved.kind === "component" &&
				actual.resolved.name === declared.name
			);
		case "list":
			if (actual.resolved !== null && actual.resolved.kind === "list") {
				return compatible(declared.element, {
					resolved: actual.resolved.element,
				});
			}
			if (actual.listValues !== undefined) {
				return actual.listValues.every((value) =>
					compatible(declared.element, literalTerm(value)),
				);
			}
			return false;
		case "enum":
			if (actual.listValues !== undefined) {
				return actual.listValues.every((value) =>
					declared.members.some((member) => member === value),
				);
			}
			if (
				actual.literalValue !== undefined &&
				typeof actual.literalValue !== "object"
			) {
				return declared.members.some(
					(member) => member === actual.literalValue,
				);
			}
			if (actual.resolved !== null && actual.resolved.kind === "enum") {
				// enum vs enum: same shape family in v1 (no deep subset check).
				return true;
			}
			return false;
	}
}

/**
 * Member-level compatibility for a list_literal RHS of `in`: each member must
 * be compatible with the left-hand type (unwrapping list<T> to its element).
 */
function checkInMembers(declared: ResolvedType, members: LiteralList): boolean {
	const element = declared.kind === "list" ? declared.element : declared;
	return members.every((member) => compatible(element, literalTerm(member)));
}

function termDescriptor(term: TermResolved): string {
	return term.descriptor ?? "term";
}

function addError(
	state: WalkState,
	code: ValidationErrorCode,
	field: string,
	detail: string,
): void {
	state.errors.push({ contractId: state.clauseId, code, field, detail });
}

function addLowConfidenceWarning(state: WalkState, field: string): void {
	const key = `LOW_CONFIDENCE_FIELD:${field}`;
	if (state.warningKeys.has(key)) {
		return;
	}
	state.warningKeys.add(key);
	state.warnings.push({
		code: "LOW_CONFIDENCE_FIELD",
		field,
		detail: `Field "${field}" has inferred (low-confidence) type information`,
	});
}

function scopeName(state: WalkState): string {
	return state.scope.operation === undefined
		? state.scope.component
		: `${state.scope.component}.${state.scope.operation}`;
}

function appendDescriptor(
	descriptor: string,
	segment: FieldPath[number],
): string {
	if (typeof segment === "number") {
		return `${descriptor}[${segment}]`;
	}
	if (segment === "[]") {
		return `${descriptor}[]`;
	}
	return `${descriptor}.${segment}`;
}

function indexDescriptor(segment: FieldPath[number]): string {
	return typeof segment === "number" ? String(segment) : "[]";
}
