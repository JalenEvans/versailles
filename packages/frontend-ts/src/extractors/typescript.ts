/**
 * TypeScript manifest extractor plugin (ADR-0008/0009, build-spec §7).
 *
 * Walks exported class/interface declarations under the source roots with
 * the compiler API's createProgram + the type checker, resolving declared
 * field types to the typeRef grammar (build-spec §3.3):
 *   string | number | boolean | <ComponentName> | list<typeRef> |
 *   optional<typeRef> | enum<v1,v2,...>
 *
 * - TS generics map to list<T>; literal-only unions map to enum<...>
 *   preserving source order; optionality is detected from the question token
 *   BEFORE union resolution (resolving from the declared type node, never the
 *   symbol type that would include | undefined).
 * - boolean is handled BEFORE union handling because the checker models the
 *   `boolean` keyword as a true|false union carrying both Union and Boolean
 *   flags.
 * - Array detection uses the Array/ReadonlyArray symbol gate around
 *   getIndexTypeOfType(IndexKind.Number): the index-type API alone treats
 *   strings and string-literal unions as indexable; the symbol gate fixes it.
 * - Nested/related types (e.g. items: OrderItem[]) are added transitively to
 *   the flat manifest map via a worklist, so order.items[].sku resolves
 *   through a sibling OrderItem entry (build-spec §3.3).
 * - Per-component method metadata is recorded for every resolvable method
 *   (class methods incl. static, interface method signatures): method name →
 *   { static, params (declared order), returnType? } (build-spec §7,
 *   VERSAILLES-20 F1). Accessors (get/set) are NOT methods. returnType is
 *   resolved to the simple typeRef grammar (void/number/string/boolean) where
 *   determinable and left undefined otherwise — never a hard error (ADR-0004).
 * - Fields whose type can only be inferred (untyped property initializer) are
 *   flagged low-confidence with a LOW_CONFIDENCE_FIELD warning — never a hard
 *   error (ADR-0004). Methods are never fields.
 * - Types outside the grammar (Date, Map, Record, anonymous object shapes)
 *   render deterministically as their symbol name (or checker.typeToString for
 *   compiler-generated anonymous symbols) and never throw — no warning.
 * - sourceRoots is a HARD boundary: only *.ts files under the roots are
 *   scanned, indexed, or resolved — never outside, even through imports.
 * - Each covered entry records a PROJECT-root-relative sourcePath with POSIX
 *   separators (e.g. "src/order.ts" for <projectRoot>/src/order.ts) so the
 *   generator's join(cwd, sourcePath) resolves to the real file
 *   (manifest-extraction.contract.yaml, VERSAILLES-24). The project root is
 *   the optional extractManifests projectRoot argument (the CLI's cwd); when
 *   absent it is inferred as the common directory prefix of the source roots.
 *
 * Synchronous extraction: the compiler API's createProgram is synchronous
 * (directory glob expansion is a CLI concern, not the extractor's). The
 * `typescript` runtime dependency is LAZY (VERSAILLES-190): the compiler API
 * is an optional dependency, loaded only inside the extract path — never at
 * module load — so `init`/`validate`/`generate`/`check` consumers who never
 * run a TypeScript extraction do not pay the compiler install cost.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

// Type-only: erased at compile time, so module load never touches the
// `typescript` package at runtime (VERSAILLES-190). Type positions use `ts.`;
// the lazily-loaded runtime value lives in `tsRuntime`.
import type * as ts from "typescript";

import { computeSourceHash } from "./hash.js";
import type {
	ExtractorPlugin,
	ExtractorResult,
	ExtractorWarning,
	FieldEntry,
	ManifestMap,
	MethodMetadata,
} from "./types.js";

/**
 * Structured extractor failure when the `typescript` package cannot be
 * resolved at extraction time (VERSAILLES-190). Follows the CLI's
 * { code, detail } structured-error conventions (ADR-0010) — the consumer
 * gets an actionable message instead of a raw module-not-found throw leaking
 * out of the CLI.
 */
export class ExtractorDependencyMissingError extends Error {
	readonly code = "EXTRACTOR_DEPENDENCY_MISSING" as const;
	readonly detail: string;

	constructor(detail: string) {
		super(detail);
		this.name = "ExtractorDependencyMissingError";
		this.detail = detail;
	}
}

/**
 * Lazy `typescript` namespace (VERSAILLES-190).
 *
 * `typescript` is an optional dependency: the compiler API is only touched
 * inside the extract path. `tsRuntime` starts undefined and is populated by
 * the first loader that runs; every helper in this module reads it strictly
 * after a loader has run. Two loaders back the same cache:
 *
 * - `loadTypeScriptSync` — `createRequire` require(), the synchronous path
 *   used by the public `extractManifests` / `resolveExportedFunction`
 *   surfaces (the CLI stays synchronous; ADR-0008 seam unchanged).
 * - `loadTypeScriptAsync` — dynamic `await import("typescript")`, the plugin
 *   seam's extract path (tolerates both a missing package and mock runners
 *   that only intercept ESM imports).
 *
 * Both translate any resolution failure into the structured
 * EXTRACTOR_DEPENDENCY_MISSING error above.
 */
let tsRuntime = undefined as unknown as typeof import("typescript");

/** createRequire scoped to this module — synchronous lazy resolution. */
const nodeRequire = createRequire(import.meta.url);

/** Message shared by both loaders' structured failure. */
const TYPESCRIPT_MISSING_DETAIL =
	"TypeScript extraction requires the 'typescript' package (npm i typescript)";

function loadTypeScriptSync(): void {
	if (typeof tsRuntime === "undefined") {
		try {
			tsRuntime = nodeRequire("typescript") as typeof import("typescript");
		} catch {
			throw new ExtractorDependencyMissingError(TYPESCRIPT_MISSING_DETAIL);
		}
	}
}

async function loadTypeScriptAsync(): Promise<void> {
	if (typeof tsRuntime === "undefined") {
		try {
			// CJS interop: the namespace's `default` is module.exports — the
			// same value the static `import ts from "typescript"` produced.
			const mod = (await import("typescript")) as {
				default: typeof import("typescript");
			};
			tsRuntime = mod.default;
		} catch {
			throw new ExtractorDependencyMissingError(TYPESCRIPT_MISSING_DETAIL);
		}
	}
}

/**
 * Structural-analysis-only compiler options.
 *
 * lib is pinned to es2015 (NOT the full default set) and types to none:
 * loading lib.d.ts/lib.dom.d.ts/etc. costs ~1.5–2s per createProgram, and the
 * extractor only needs primitives + Array/ReadonlyArray (both present in
 * es2015) to resolve the typeRef grammar. This keeps check/extract-manifests
 * fast (~ms instead of seconds) without changing extraction semantics.
 *
 * Built lazily (after `ts` is loaded) — the old module-level constant
 * evaluated ts.ScriptTarget/ModuleKind/ModuleResolutionKind at import time,
 * which is exactly what VERSAILLES-190 removes.
 */
function getCompilerOptions(): ts.CompilerOptions {
	return {
		target: tsRuntime.ScriptTarget.ES2022,
		module: tsRuntime.ModuleKind.NodeNext,
		moduleResolution: tsRuntime.ModuleResolutionKind.NodeNext,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		lib: ["lib.es2015.d.ts"],
		types: [],
	};
}

type NamedComponentDeclaration = (
	| ts.ClassDeclaration
	| ts.InterfaceDeclaration
) & {
	name: ts.Identifier;
};
type FieldMember = ts.PropertyDeclaration | ts.PropertySignature;
type MethodMember = ts.MethodDeclaration | ts.MethodSignature;

/** Recursively collects *.ts files under each root (HARD boundary). */
function scanTypeScriptFiles(sourceRoots: string[]): string[] {
	const files: string[] = [];
	for (const root of sourceRoots) {
		const stack = [root];
		while (stack.length > 0) {
			const dir = stack.pop();
			if (dir === undefined) break;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(path);
				} else if (
					entry.isFile() &&
					/\.ts$/.test(entry.name) &&
					!/\.d\.ts$/.test(entry.name)
				) {
					files.push(path);
				}
			}
		}
	}
	return files.sort();
}

/** Exported class/interface declarations are the extraction roots. */
function isExported(decl: NamedComponentDeclaration): boolean {
	const modifiers = tsRuntime.canHaveModifiers(decl)
		? tsRuntime.getModifiers(decl)
		: undefined;
	return (
		modifiers?.some(
			(modifier) => modifier.kind === tsRuntime.SyntaxKind.ExportKeyword,
		) ?? false
	);
}

/** Export check for top-level FunctionDeclarations (predicate-registry seam). */
function isExportedFunction(decl: ts.FunctionDeclaration): boolean {
	const modifiers = tsRuntime.canHaveModifiers(decl)
		? tsRuntime.getModifiers(decl)
		: undefined;
	return (
		modifiers?.some(
			(modifier) => modifier.kind === tsRuntime.SyntaxKind.ExportKeyword,
		) ?? false
	);
}

function isComponentDeclaration(
	node: ts.Statement,
): node is NamedComponentDeclaration {
	return (
		(tsRuntime.isClassDeclaration(node) ||
			tsRuntime.isInterfaceDeclaration(node)) &&
		node.name !== undefined
	);
}

/** Methods (and accessors) are never fields — data members only. */
function isFieldMember(node: ts.Node): node is FieldMember {
	return (
		tsRuntime.isPropertyDeclaration(node) || tsRuntime.isPropertySignature(node)
	);
}

function fieldNameOf(member: FieldMember): string {
	const name = member.name;
	return tsRuntime.isIdentifier(name) ? name.text : name.getText();
}

/**
 * Method signatures are recorded for class methods (instance AND static) and
 * interface method signatures. Accessors (get/set) are NOT methods for the
 * manifest purpose — they are data accessors, skipped (fields only).
 */
function isMethodMember(node: ts.Node): node is MethodMember {
	return (
		tsRuntime.isMethodDeclaration(node) || tsRuntime.isMethodSignature(node)
	);
}

function methodNameOf(member: MethodMember): string {
	const name = member.name;
	return tsRuntime.isIdentifier(name) ? name.text : name.getText();
}

/** Static detection via the modifier list (ts.getModifiers, TS 5.0+). */
function isStaticMember(member: MethodMember): boolean {
	const modifiers = tsRuntime.canHaveModifiers(member)
		? tsRuntime.getModifiers(member)
		: undefined;
	return (
		modifiers?.some(
			(modifier) => modifier.kind === tsRuntime.SyntaxKind.StaticKeyword,
		) ?? false
	);
}

/** Parameter names in DECLARED order (binding identifiers/text). */
function paramNamesOf(member: MethodMember): string[] {
	return member.parameters.map((parameter) => {
		const name = parameter.name;
		return tsRuntime.isIdentifier(name) ? name.text : name.getText();
	});
}

/**
 * Resolves a method's return type to a typeRef-grammar string where
 * determinable (build-spec §7): the tests' fixtures need void/number/string/
 * boolean only, so the renderer stays intentionally minimal. Anything else
 * (component refs, list<T>, unions, unresolved nodes) records `undefined` —
 * the permissive never-block policy (ADR-0004) keeps the signature recorded
 * with params + static flag intact.
 */
function resolveReturnType(
	checker: ts.TypeChecker,
	member: MethodMember,
): string | undefined {
	if (member.type === undefined) return undefined;
	const type = checker.getTypeFromTypeNode(member.type);
	if (type.flags & tsRuntime.TypeFlags.Void) return "void";
	if (type.flags & tsRuntime.TypeFlags.Boolean) return "boolean";
	if (type.flags & tsRuntime.TypeFlags.String) return "string";
	if (type.flags & tsRuntime.TypeFlags.Number) return "number";
	return undefined;
}

/**
 * Longest common directory prefix of the source roots — the best available
 * project-root estimate when a caller does not pass an explicit projectRoot
 * (VERSAILLES-24). For the common single-source-root case the root IS the
 * inferred project root, so results are byte-identical to the pre-fix
 * behavior; for nested/multi-root layouts the common ancestor keeps every
 * sourcePath project-root-relative (never source-root-relative, never
 * absolute). Returns undefined when the roots share no directory prefix
 * (including the empty sourceRoots list) so the caller can fall back.
 */
function inferProjectRoot(sourceRoots: string[]): string | undefined {
	if (sourceRoots.length === 0) return undefined;
	let common = sourceRoots[0];
	for (const root of sourceRoots.slice(1)) {
		while (root !== common && !root.startsWith(`${common}${sep}`)) {
			const next = common.lastIndexOf(sep);
			if (next <= 0) return undefined;
			common = common.slice(0, next);
		}
	}
	return common;
}

/**
 * PROJECT-root-relative sourcePath for a covered component
 * (manifest-extraction.contract.yaml, VERSAILLES-24): a component at
 * <projectRoot>/src/order.ts records "src/order.ts" — never source-root-
 * relative ("order.ts") and never absolute — so deriveModulePaths'
 * join(cwd, sourcePath) resolves to the real file. The project root is the
 * explicit projectRoot argument when provided (the CLI's cwd); otherwise it
 * is inferred as the common directory prefix of the source roots. When no
 * project root is derivable (projectRoot omitted + disjoint source roots),
 * the fallback is the file relative to sourceRoots[0] when that yields a
 * relative path, or "" (the store-write omission sentinel) — the absolute
 * file path is never emitted (VERSAILLES-24 follow-up, W2). POSIX
 * separators always (build-spec §3.3).
 */
function sourcePathOf(
	decl: NamedComponentDeclaration,
	sourceRoots: string[],
	projectRoot?: string,
): string {
	const file = decl.getSourceFile().fileName;
	const root = projectRoot ?? inferProjectRoot(sourceRoots);
	if (root === undefined || root === "") {
		// W2 (manifest-extraction.contract.yaml, VERSAILLES-24 follow-up): no
		// project root is derivable (projectRoot omitted and the source roots
		// share no common prefix — disjoint roots). Fall back to the file
		// relative to sourceRoots[0] when that yields a relative path, or
		// return "" — the caller's omission sentinel (extract.ts never
		// persists an empty sourcePath) — never the absolute file path, which
		// would leak machine-specific absolute paths into the store. The CLI
		// path (projectRoot passed) never reaches here.
		if (sourceRoots.length === 0) return "";
		const rel = relative(sourceRoots[0], file);
		return rel === "" ? "" : rel.split(sep).join("/");
	}
	const rel = relative(root, file);
	return rel === "" ? file : rel.split(sep).join("/");
}

/**
 * Per-field TS access modifier from the member's modifier list (ADR-0021).
 * The permissive policy (ADR-0004): an unresolvable or absent access modifier
 * defaults to "public" — never omitted, never a hard error.
 */
function accessOf(member: FieldMember): "public" | "protected" | "private" {
	const modifiers = tsRuntime.canHaveModifiers(member)
		? tsRuntime.getModifiers(member)
		: undefined;
	if (modifiers?.some((m) => m.kind === tsRuntime.SyntaxKind.PrivateKeyword)) {
		return "private";
	}
	if (
		modifiers?.some((m) => m.kind === tsRuntime.SyntaxKind.ProtectedKeyword)
	) {
		return "protected";
	}
	return "public";
}

/**
 * Per-field readonly flag from the member's modifier list (ADR-0021). Under
 * the permissive policy an absent readonly modifier defaults to false.
 */
function readonlyOf(member: FieldMember): boolean {
	const modifiers = tsRuntime.canHaveModifiers(member)
		? tsRuntime.getModifiers(member)
		: undefined;
	return (
		modifiers?.some((m) => m.kind === tsRuntime.SyntaxKind.ReadonlyKeyword) ??
		false
	);
}

/**
 * Resolves a field member to a FieldEntry: declared types resolve from the
 * declared type node (so optionality comes from the question token, not an
 * implicit | undefined); inferred-only fields resolve from the initializer,
 * are flagged low-confidence, and emit a non-blocking warning (ADR-0004).
 * Per-field access/readonly come from the TS modifiers (ADR-0021).
 */
function resolveField(
	checker: ts.TypeChecker,
	member: FieldMember,
	component: string,
	warnings: ExtractorWarning[],
	refs: Set<string>,
): FieldEntry {
	const name = fieldNameOf(member);
	const optional = member.questionToken !== undefined;

	let typeRef: string;
	let confidence: "high" | "low";

	if (member.type !== undefined) {
		const type = checker.getTypeFromTypeNode(member.type);
		typeRef = renderTypeRef(checker, type, refs);
		confidence = "high";
	} else {
		const type = checker.getTypeAtLocation(member);
		typeRef = renderTypeRef(checker, type, refs);
		confidence = "low";
		warnings.push({
			code: "LOW_CONFIDENCE_FIELD",
			component,
			field: name,
			detail: `Field "${name}" has no declared type annotation; the type was inferred from its initializer (low-confidence)`,
		});
	}

	if (optional) typeRef = `optional<${typeRef}>`;

	return {
		name,
		typeRef,
		confidence,
		// ADR-0021: per-field access/readonly from the TS modifiers. Under the
		// permissive policy (ADR-0004) an unresolvable modifier defaults to
		// "public" / not readonly — never omitted.
		access: accessOf(member),
		readonly: readonlyOf(member),
	};
}

/**
 * Renders a checker type to the typeRef grammar. Threads `refs` so the caller
 * learns which component names the typeRef references (for transitive
 * extraction) without re-parsing strings.
 */
function renderTypeRef(
	checker: ts.TypeChecker,
	type: ts.Type,
	refs: Set<string>,
): string {
	// boolean BEFORE union: the checker models `boolean` as a true|false union
	// whose flags carry both Union and Boolean.
	if (type.flags & tsRuntime.TypeFlags.Boolean) return "boolean";
	if (type.flags & tsRuntime.TypeFlags.String) return "string";
	if (type.flags & tsRuntime.TypeFlags.Number) return "number";

	if (type.flags & tsRuntime.TypeFlags.StringLiteral) {
		return `enum<${(type as ts.StringLiteralType).value}>`;
	}
	if (type.flags & tsRuntime.TypeFlags.NumberLiteral) {
		return `enum<${(type as ts.NumberLiteralType).value}>`;
	}
	if (type.flags & tsRuntime.TypeFlags.BooleanLiteral) return "boolean";

	if (type.flags & tsRuntime.TypeFlags.Union) {
		const parts = (type as ts.UnionType).types;
		// All-boolean-literal unions are the checker's internal boolean model.
		if (
			parts.every((part) => part.flags & tsRuntime.TypeFlags.BooleanLiteral)
		) {
			return "boolean";
		}
		// Literal-only union → enum<v1,v2,...> preserving source order.
		if (parts.every(isLiteralType)) {
			return `enum<${parts.map((part) => literalValueOf(checker, part)).join(",")}>`;
		}
		// Non-literal union (e.g. string | undefined): deterministic fallback.
		return checker.typeToString(type);
	}

	if (isArrayType(checker, type)) {
		const element = checker.getIndexTypeOfType(
			type,
			tsRuntime.IndexKind.Number,
		);
		if (element !== undefined) {
			return `list<${renderTypeRef(checker, element, refs)}>`;
		}
	}

	// Component reference, or non-grammar fallback (Date, Map, ...) rendered
	// deterministically as the symbol name — never a throw, no warning.
	const symbolName = type.symbol?.getName();
	if (symbolName !== undefined && !symbolName.startsWith("__")) {
		refs.add(symbolName);
		return symbolName;
	}

	// Compiler-generated anonymous symbol (e.g. Record<...>): deterministic
	// string rendering via the checker.
	return checker.typeToString(type);
}

function isLiteralType(type: ts.Type): boolean {
	return (
		(type.flags & tsRuntime.TypeFlags.StringLiteral) !== 0 ||
		(type.flags & tsRuntime.TypeFlags.NumberLiteral) !== 0 ||
		(type.flags & tsRuntime.TypeFlags.BooleanLiteral) !== 0
	);
}

function literalValueOf(checker: ts.TypeChecker, type: ts.Type): string {
	if (type.flags & tsRuntime.TypeFlags.StringLiteral) {
		return String((type as ts.StringLiteralType).value);
	}
	if (type.flags & tsRuntime.TypeFlags.NumberLiteral) {
		return String((type as ts.NumberLiteralType).value);
	}
	// Boolean literals expose no public value; typeToString yields true/false.
	return checker.typeToString(type);
}

/**
 * Array gate: getIndexTypeOfType(IndexKind.Number) alone treats strings and
 * string-literal unions as indexable; requiring the Array/ReadonlyArray
 * symbol fixes the false positive. Handles T[], Array<T>, ReadonlyArray<T>.
 */
function isArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
	const symbolName = type.symbol?.getName();
	if (symbolName !== "Array" && symbolName !== "ReadonlyArray") return false;
	return (
		checker.getIndexTypeOfType(type, tsRuntime.IndexKind.Number) !== undefined
	);
}

/**
 * Shared extraction pipeline — runs ONLY after a loader has populated the
 * module-level `ts` namespace (VERSAILLES-190). Byte-identical to the
 * pre-lazy-load extraction: the lazy load changes HOW `ts` is obtained, never
 * what the analysis produces.
 */
function extractTypeScriptCore(
	sourceRoots: string[],
	projectRoot?: string,
): ExtractorResult {
	const files = scanTypeScriptFiles(sourceRoots);
	const program = tsRuntime.createProgram({
		rootNames: files,
		options: getCompilerOptions(),
	});
	const checker = program.getTypeChecker();

	// Index every top-level named class/interface under the roots so
	// transitive references resolve deterministically (first occurrence wins;
	// files are sorted).
	const declarationsByName = new Map<string, NamedComponentDeclaration>();
	for (const file of program.getSourceFiles()) {
		if (!files.includes(file.fileName)) continue;
		for (const statement of file.statements) {
			if (
				isComponentDeclaration(statement) &&
				!declarationsByName.has(statement.name.text)
			) {
				declarationsByName.set(statement.name.text, statement);
			}
		}
	}

	const manifests: ManifestMap = {};
	const warnings: ExtractorWarning[] = [];
	const processed = new Set<string>();
	const queue: NamedComponentDeclaration[] = [];

	// Roots: exported top-level components under the source roots.
	for (const file of program.getSourceFiles()) {
		if (!files.includes(file.fileName)) continue;
		for (const statement of file.statements) {
			if (isComponentDeclaration(statement) && isExported(statement)) {
				queue.push(statement);
			}
		}
	}

	while (queue.length > 0) {
		const declaration = queue.pop() as NamedComponentDeclaration;
		const component = declaration.name.text;
		if (processed.has(component)) continue;
		processed.add(component);

		const fields: FieldEntry[] = [];
		const methods: Record<string, MethodMetadata> = {};
		const refs = new Set<string>();
		let hasLowConfidence = false;

		for (const member of declaration.members) {
			if (isFieldMember(member)) {
				const field = resolveField(checker, member, component, warnings, refs);
				fields.push(field);
				if (field.confidence === "low") hasLowConfidence = true;
			} else if (isMethodMember(member)) {
				// Signature record: name, static/instance, ordered params,
				// return type where determinable. Method BODIES never enter
				// the manifest or the structural hash (build-spec §7). The
				// last overload wins deterministically (source order).
				methods[methodNameOf(member)] = {
					static: isStaticMember(member),
					params: paramNamesOf(member),
					returnType: resolveReturnType(checker, member),
				};
			}
		}

		manifests[component] = {
			component,
			fields,
			methods,
			sourceHash: computeSourceHash(fields, methods),
			sourcePath: sourcePathOf(declaration, sourceRoots, projectRoot),
			confidence: hasLowConfidence ? "low" : "high",
		};

		// Transitive extraction: every component the typeRefs reference joins
		// the worklist; multi-level chains resolve because each processed
		// declaration pushes its own references.
		for (const ref of refs) {
			const refDeclaration = declarationsByName.get(ref);
			if (refDeclaration !== undefined) queue.push(refDeclaration);
		}
	}

	return { manifests, warnings };
}

/**
 * Async plugin-seam extract (ADR-0008/0009) — lazy-loads the compiler API via
 * dynamic `await import("typescript")` and fails with the structured
 * EXTRACTOR_DEPENDENCY_MISSING error when the optional dependency is absent
 * (VERSAILLES-190). The plugin seam is async-capable so the dependency-missing
 * path is mock-observable in test runners that only intercept ESM imports.
 */
async function extractTypeScript(
	sourceRoots: string[],
	projectRoot?: string,
): Promise<ExtractorResult> {
	await loadTypeScriptAsync();
	return extractTypeScriptCore(sourceRoots, projectRoot);
}

/**
 * Synchronous extract for the public `extractManifests` surface — the CLI and
 * the repo's sync test suites call it without awaiting. Lazy-loads via
 * createRequire (synchronous) and fails with the same structured
 * EXTRACTOR_DEPENDENCY_MISSING error when `typescript` is absent.
 */
function extractTypeScriptSync(
	sourceRoots: string[],
	projectRoot?: string,
): ExtractorResult {
	loadTypeScriptSync();
	return extractTypeScriptCore(sourceRoots, projectRoot);
}

/** TypeScript extractor plugin (ADR-0008/0009). */
export const typescriptExtractor: ExtractorPlugin = {
	language: "typescript",
	extract: extractTypeScript,
	extractSync: extractTypeScriptSync,
};

export type ResolvedFunction =
	| {
			ok: true;
			moduleName: string;
			functionName: string;
			/** node.getText() on the resolved FunctionDeclaration: `export`/`function` through the closing brace — no leading trivia, no trailing newline. */
			sourceText: string;
			filePath: string;
	  }
	| { ok: false };

function moduleNameOf(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.endsWith(".ts") ? base.slice(0, -3) : base;
}

/**
 * Predicate-registry static-analysis seam (build-spec §13 milestone 8) —
 * resolves a `Module.functionName` sourceRef to the exported top-level
 * FunctionDeclaration under the source roots and returns its exact source
 * text (node.getText()). Module = file basename without `.ts`; function =
 * exported top-level function name. This is a shared analysis seam, NOT
 * manifest derivation — manifest-extraction owns that (contract limits).
 */
export function resolveExportedFunction(
	sourceRoots: string[],
	moduleName: string,
	functionName: string,
): ResolvedFunction {
	// Synchronous lazy load — the predicate seam is called from sync core
	// code (workspace loader) and must not require awaiting (VERSAILLES-190).
	loadTypeScriptSync();
	const files = scanTypeScriptFiles(sourceRoots);
	const program = tsRuntime.createProgram({
		rootNames: files,
		options: getCompilerOptions(),
	});
	// Iterate the program's own source files (mirrors extractTypeScript) and
	// match the module by file basename without `.ts`.
	for (const sourceFile of program.getSourceFiles()) {
		if (!files.includes(sourceFile.fileName)) continue;
		if (moduleNameOf(sourceFile.fileName) !== moduleName) continue;
		for (const statement of sourceFile.statements) {
			if (
				tsRuntime.isFunctionDeclaration(statement) &&
				statement.name !== undefined &&
				statement.name.text === functionName &&
				isExportedFunction(statement)
			) {
				return {
					ok: true,
					moduleName,
					functionName,
					// node.getText() semantics: from `export`/`function` through
					// the closing brace — getStart skips leading trivia and
					// getEnd lands after the last token. The parent chain is
					// not bound here (no type-checker), so getStart(sourceFile)
					// is passed the file explicitly instead of walking parents.
					sourceText: sourceFile.text.substring(
						statement.getStart(sourceFile),
						statement.getEnd(),
					),
					filePath: sourceFile.fileName,
				};
			}
		}
	}
	return { ok: false };
}
