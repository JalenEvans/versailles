/**
 * The joint `.versailles/` loader — the single shared path into a workspace
 * (build-spec §6). Loads and JSON-parses the three jointly-loaded files
 * (config.json, contracts.json, manifests.json) — version-less stores since
 * ADR-0018, so no version gates and no VERSION_MISMATCH — parses every expr
 * string in contracts.json into an AST via parseExpression, validates
 * config.json against config.schema.json, and returns ONE VersaillesContext
 * with an aggregated isValid flag (build-spec §6.5).
 *
 * ADR-0013 (Phase 3): predicates are now declared inline in contracts.json's
 * top-level `predicates` map. predicates.json is retired and no longer loaded.
 *
 * The loader never throws on missing/invalid files, malformed exprs, or
 * valid-JSON/wrong-shape files: every failure path returns a structured
 * LoaderError/ParseError inside the context. Shape violations (a primitive
 * top-level file, a clause entry that is not an object, a manifest entry
 * missing `fields`, ...) are caught by a dedicated shape-guard pass and
 * recorded as INVALID_SHAPE LoaderErrors (chunk 3.4a, ADR-0010). After
 * parsing, the semantic validator (build-spec §5) runs over every
 * successfully-parsed clause with its clauseKind + owning scope; semantic
 * errors join loader-level errors (MISSING_FILE / INVALID_JSON /
 * CONFIG_INVALID / INVALID_SHAPE) in validationErrors, and ADR-0004 warnings
 * land in validationWarnings without flipping isValid.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";

import { existsSync, statSync } from "node:fs";

import configSchema from "../../../../config.schema.json" with { type: "json" };
import { parseExpression } from "../core/parser.js";
import type { ClauseKind, Node, ParseError } from "../core/parser.js";
import { semanticValidate } from "../core/validator.js";
import type { ValidationError, ValidatorScope } from "../core/validator.js";
import { isValidPredicateName } from "../predicates/registry.js";
import { resolvePredicateSource } from "../predicates/source.js";

export type WorkspaceConfig = {
	sourceRoots: string[];
	language: "typescript" | "csharp" | "python";
	testFramework: "vitest" | "xunit" | "pytest";
	generatedDir: string;
	staleness: { blockOnStale: boolean };
	rejection?: { idiom: "throws" | "returns" };
	propertyBased?: {
		enabled: boolean;
		numRuns: number;
		seed?: number;
	};
};

export type ContractClause = { id: string; expr: string };

export type ContractOperation = {
	id: string;
	params: { name: string; type: string }[];
	preconditions: ContractClause[];
	postconditions: ContractClause[];
	effects: { field: string; kind: "mutate" | "create" | "delete" }[];
	sourceHash: string;
};

export type ComponentContract = {
	invariants: ContractClause[];
	operations: Record<string, ContractOperation>;
};

export type ContractsFile = {
	/**
	 * ADR-0013 (Phase 3): predicates are now declared inline in contracts.json's
	 * top-level `predicates` map. Each entry carries: source, params, paramTypes,
	 * returnType. The sourceHash field is dropped (ADR-0013); verifiedPure is
	 * dropped (ADR-0019) — a legacy verifiedPure field is silently ignored.
	 */
	predicates?: Record<
		string,
		{
			source: string;
			params: string[];
			paramTypes: string[];
			returnType: string;
		}
	>;
	contracts: Record<string, ComponentContract>;
};

export type ManifestsFile = {
	manifests: Record<
		string,
		{
			sourceHash: string;
			fields: Record<string, string>;
			/**
			 * Root-relative source file the covered entry was extracted from
			 * (workspace-context.contract.yaml, VERSAILLES-21 F2). Optional on
			 * the TYPE because legacy entries predate sourcePath — the shape
			 * guard tolerates its absence (never an INVALID_SHAPE error) and
			 * the loader surfaces it untouched when present.
			 */
			sourcePath?: string;
			/**
			 * Per-component method metadata (workspace-context.contract.yaml):
			 * method name → { static, params, returnType? }. Recorded where
			 * determinable under the permissive low-confidence policy. Also
			 * optional — F1 owns the recording side; the loader only surfaces
			 * it (no emitter behavior is wired yet).
			 */
			methods?: Record<
				string,
				{ static: boolean; params: string[]; returnType?: string }
			>;
			/**
			 * Per-field TypeScript access modifier (ADR-0021):
			 * field name → "public" | "protected" | "private". Additive
			 * optional sibling of `fields`; absent for legacy entries. The
			 * loader surfaces the raw store key untouched — permissive
			 * defaulting (absent → "public") is the CONSUMER's (emitter's)
			 * job, not the loader's.
			 */
			fieldAccess?: Record<string, "public" | "protected" | "private">;
			/**
			 * Per-field readonly flag (ADR-0021): field name → boolean.
			 * Additive optional sibling of `fields`; absent for legacy
			 * entries. Surfaced untouched — defaulting (absent → false) is
			 * the consumer's job, not the loader's.
			 */
			fieldReadonly?: Record<string, boolean>;
		}
	>;
};

export type PredicatesFile = {
	predicates: Record<
		string,
		{
			params: string[];
			paramTypes: string[];
			returnType: string;
			sourceRef: string;
		}
	>;
};

export type LoaderErrorCode =
	| "MISSING_FILE"
	| "INVALID_JSON"
	| "CONFIG_INVALID"
	| "INVALID_SHAPE"
	| "NOT_FOUND"
	| "INVALID_PREDICATE_NAME";

export type LoaderError = {
	code: LoaderErrorCode;
	field: string;
	detail: string;
};

export type LoaderWarning = { code: string; field: string; detail: string };

export type VersaillesContext = {
	config: WorkspaceConfig | null;
	contracts: ContractsFile | null;
	manifests: ManifestsFile | null;
	predicates: PredicatesFile | null;
	parsedContracts: Record<string, Node>;
	parseErrors: ParseError[];
	validationErrors: (LoaderError | ValidationError)[];
	validationWarnings: LoaderWarning[];
	isValid: boolean;
};

type ConfigValidator = {
	validate: (data: unknown) => boolean;
	errors: ValidateFunction["errors"];
};

/**
 * Config validator compiled lazily once from config.schema.json (the repo-root
 * machine-checkable schema, ADR-0009 matrix).
 */
let configValidatorCache: ConfigValidator | null = null;

function getConfigValidator(): ConfigValidator {
	if (configValidatorCache === null) {
		const validator = new Ajv({ allErrors: true }).compile(
			configSchema as Record<string, unknown>,
		);
		configValidatorCache = {
			validate: (data: unknown) => validator(data),
			get errors() {
				return validator.errors;
			},
		};
	}
	return configValidatorCache;
}

/**
 * Reads and JSON-parses one workspace file. Missing file → MISSING_FILE error
 * and null; invalid JSON → INVALID_JSON error and null (a present file whose
 * content is the JSON literal null is also INVALID_JSON — null is not a valid
 * workspace store; chunk 3.4b, W2). Never throws for the covered failure
 * modes.
 */
async function loadJsonFile(
	workspaceDir: string,
	fileName: string,
	validationErrors: (LoaderError | ValidationError)[],
): Promise<unknown | null> {
	let raw: string;
	try {
		raw = await readFile(join(workspaceDir, fileName), "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			validationErrors.push({
				code: "MISSING_FILE",
				field: fileName,
				detail: `Workspace file "${fileName}" is missing from ${workspaceDir}`,
			});
			return null;
		}
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		// W2 (chunk 3.4b): a PRESENT file whose content is the JSON literal
		// `null` parses successfully to null with NO error, then the shape
		// guard treats null as missing-file-covered and isValid ends TRUE
		// (false green). A workspace file must be an object; null content is
		// a structured INVALID_JSON signal carrying the file's field, pushed
		// BEFORE the config/contracts consumers see the null store — the
		// `config !== null` guard would otherwise skip config validation and
		// lose the signal entirely.
		if (parsed === null) {
			validationErrors.push({
				code: "INVALID_JSON",
				field: fileName,
				detail: `Workspace file "${fileName}" is the JSON literal null — expected an object`,
			});
			return null;
		}
		return parsed;
	} catch {
		validationErrors.push({
			code: "INVALID_JSON",
			field: fileName,
			detail: `Workspace file "${fileName}" is not valid JSON`,
		});
		return null;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ADR-0013 (Phase 3): inline version of expandSourceRoots from src/cli/context.ts
 * to avoid circular dependency. Expands config.sourceRoots patterns into actual
 * directory roots for predicate source resolution.
 */
function expandSourceRootsInline(patterns: string[], cwd: string): string[] {
	const roots = new Set<string>();
	for (const pattern of patterns) {
		const prefix = staticPrefixInline(pattern);
		if (prefix === "") {
			continue;
		}
		const abs = join(cwd, prefix);
		if (existsSync(abs) && statSync(abs).isDirectory()) {
			roots.add(abs);
		}
	}
	return [...roots].sort();
}

function staticPrefixInline(pattern: string): string {
	const metaIndex = pattern.search(/[*?[\]{}]/);
	if (metaIndex === -1) {
		return pattern;
	}
	return pattern.slice(0, metaIndex).replace(/[\\/]+$/, "");
}

/**
 * A clause entry is an object carrying a string `expr`. The `id` field is
 * deliberately NOT required here: an id-less clause is a parse-time concern
 * (its ParseError carries an undefined contractId), not a shape violation.
 */
function isClauseEntry(value: unknown): boolean {
	return isRecord(value) && typeof value.expr === "string";
}

/**
 * Runtime shape-guard pass (chunk 3.4a, F1): the store types (ContractsFile,
 * ManifestsFile, PredicatesFile) are compile-time-only — valid JSON with the
 * wrong shape (a primitive top-level file, a clause entry that is not an
 * object, a manifest entry missing `fields`, ...) used to slip through and
 * crash downstream consumers with raw TypeErrors, violating the loader's
 * never-throws promise (ADR-0010). This pass runs AFTER loadJsonFile and
 * BEFORE withRecordKey/parseContracts: every shape violation is recorded as a
 * structured INVALID_SHAPE LoaderError, and the per-file result tells
 * loadWorkspace which downstream work to skip.
 *
 * A missing file (null) is NOT a shape violation — MISSING_FILE/INVALID_JSON
 * already cover it, and an absent record key is deliberately tolerated
 * (withRecordKey defaults it to {}, matching init.ts seeding of empty {}
 * stores).
 *
 * Field naming (documented by the SG in tests/loader.test.ts):
 * - top-level file primitive:            "<file>.json"
 * - clause entry (primitive):            "contracts.contracts.<Component>.<clauseKind>[<index>]"
 * - clauseKind that is not an array:     "contracts.contracts.<Component>.<clauseKind>"
 * - operation params (non-array/null entry):
 *   "contracts.contracts.<Component>.operations.<Op>.params"
 * - manifest entry:                      "manifests.manifests.<Component>.fields"
 */
function validateWorkspaceShapes(
	contractsRaw: unknown,
	manifestsRaw: unknown,
	validationErrors: (LoaderError | ValidationError)[],
): { contracts: boolean; manifests: boolean; predicates: boolean } {
	const pushShapeError = (field: string, detail: string): void => {
		validationErrors.push({ code: "INVALID_SHAPE", field, detail });
	};
	// ADR-0013 (Phase 3): predicates are now in contracts.json, so we validate
	// them as part of the contracts shape. The predicates flag still reports
	// whether the predicate declarations are shape-valid.
	const contractsValid = validateContractsShape(contractsRaw, pushShapeError);
	const predicatesValid = validatePredicatesShape(contractsRaw, pushShapeError);
	return {
		contracts: contractsValid && predicatesValid,
		manifests: validateManifestsShape(manifestsRaw, pushShapeError),
		predicates: predicatesValid,
	};
}

function validateContractsShape(
	raw: unknown,
	pushShapeError: (field: string, detail: string) => void,
): boolean {
	if (raw === null) {
		return true;
	}
	if (!isRecord(raw)) {
		pushShapeError(
			"contracts.json",
			"The top level of contracts.json must be an object, not a primitive value",
		);
		return false;
	}
	if (raw.contracts === undefined) {
		return true;
	}
	if (!isRecord(raw.contracts)) {
		pushShapeError(
			"contracts.contracts",
			"contracts.contracts must be an object keyed by component name",
		);
		return false;
	}

	let ok = true;
	for (const [componentName, component] of Object.entries(raw.contracts)) {
		if (!isRecord(component)) {
			pushShapeError(
				`contracts.contracts.${componentName}`,
				`Component "${componentName}" must be an object with invariants and operations`,
			);
			ok = false;
			continue;
		}

		if (component.invariants !== undefined) {
			if (!Array.isArray(component.invariants)) {
				pushShapeError(
					`contracts.contracts.${componentName}.invariants`,
					`Component "${componentName}" invariants must be an array of clauses`,
				);
				ok = false;
			} else {
				component.invariants.forEach((clause, index) => {
					if (!isClauseEntry(clause)) {
						pushShapeError(
							`contracts.contracts.${componentName}.invariants[${index}]`,
							`Invariant entry ${index} of "${componentName}" must be an object with a string expr`,
						);
						ok = false;
					}
				});
			}
		}

		if (component.operations !== undefined) {
			if (!isRecord(component.operations)) {
				pushShapeError(
					`contracts.contracts.${componentName}.operations`,
					`Component "${componentName}" operations must be an object keyed by operation id`,
				);
				ok = false;
				continue;
			}
			for (const [operationId, operation] of Object.entries(
				component.operations,
			)) {
				if (!isRecord(operation)) {
					pushShapeError(
						`contracts.contracts.${componentName}.operations.${operationId}`,
						`Operation "${operationId}" must be an object`,
					);
					ok = false;
					continue;
				}
				// B1 (chunk 3.4b): findOperationParam reads
				// operation.params unguarded (`params.find(...)` then
				// `param.name`); a non-array params value ("x", 42, {}) or an
				// array containing a null/primitive entry crashes the
				// semantic validator with a raw TypeError. Each entry must be
				// an object with a string `name` (the crash read); `type`
				// string-ness is handled defensively by parseTypeRef
				// downstream. Mirrors the per-entry predicates check.
				if (
					operation.params !== undefined &&
					(!Array.isArray(operation.params) ||
						operation.params.some(
							(param) => !isRecord(param) || typeof param.name !== "string",
						))
				) {
					pushShapeError(
						`contracts.contracts.${componentName}.operations.${operationId}.params`,
						`Operation "${operationId}" params must be an array of { name, type } entries`,
					);
					ok = false;
				}
				for (const clauseKind of ["preconditions", "postconditions"] as const) {
					const clauses = operation[clauseKind];
					if (clauses === undefined) {
						continue;
					}
					if (!Array.isArray(clauses)) {
						pushShapeError(
							`contracts.contracts.${componentName}.operations.${operationId}.${clauseKind}`,
							`Operation "${operationId}" ${clauseKind} must be an array of clauses`,
						);
						ok = false;
						continue;
					}
					clauses.forEach((clause, index) => {
						if (!isClauseEntry(clause)) {
							pushShapeError(
								`contracts.contracts.${componentName}.operations.${operationId}.${clauseKind}[${index}]`,
								`${clauseKind} entry ${index} of "${operationId}" must be an object with a string expr`,
							);
							ok = false;
						}
					});
				}
			}
		}
	}
	return ok;
}

function validateManifestsShape(
	raw: unknown,
	pushShapeError: (field: string, detail: string) => void,
): boolean {
	if (raw === null) {
		return true;
	}
	if (!isRecord(raw)) {
		pushShapeError(
			"manifests.json",
			"The top level of manifests.json must be an object, not a primitive value",
		);
		return false;
	}
	if (raw.manifests === undefined) {
		return true;
	}
	if (!isRecord(raw.manifests)) {
		pushShapeError(
			"manifests.manifests",
			"manifests.manifests must be an object keyed by component name",
		);
		return false;
	}

	let ok = true;
	for (const [componentName, entry] of Object.entries(raw.manifests)) {
		if (!isRecord(entry)) {
			pushShapeError(
				`manifests.manifests.${componentName}`,
				`Manifest entry "${componentName}" must be an object`,
			);
			ok = false;
			continue;
		}
		if (!isRecord(entry.fields)) {
			pushShapeError(
				`manifests.manifests.${componentName}.fields`,
				`Manifest entry "${componentName}" must declare a fields object`,
			);
			ok = false;
		}
		// ADR-0021: fieldAccess/fieldReadonly are additive optional siblings
		// of `fields` and are NOT shape-checked here — the guard only requires
		// `fields`, so a covered entry carrying the new keys passes through
		// untouched, and a legacy entry without them stays valid (no
		// INVALID_SHAPE, no invented keys). The loader surfaces them verbatim.
	}
	return ok;
}

/**
 * ADR-0013 (Phase 3): validates the shape of predicate declarations in
 * contracts.json's top-level `predicates` map. Each entry must have:
 * - source (string)
 * - params (array of strings)
 * - paramTypes (array of strings)
 * - returnType (string)
 *
 * ADR-0019: verifiedPure is no longer part of the schema — it is not
 * required, not checked, and silently ignored when a legacy declaration
 * still carries it.
 */
function validatePredicatesShape(
	raw: unknown,
	pushShapeError: (field: string, detail: string) => void,
): boolean {
	if (raw === null) {
		return true;
	}
	if (!isRecord(raw)) {
		pushShapeError(
			"contracts.json",
			"The top level of contracts.json must be an object, not a primitive value",
		);
		return false;
	}
	if (raw.predicates === undefined) {
		return true;
	}
	if (!isRecord(raw.predicates)) {
		pushShapeError(
			"contracts.predicates",
			"contracts.predicates must be an object keyed by predicate name",
		);
		return false;
	}

	// Per-entry shape check: each predicate declaration must have source (string),
	// params (array), paramTypes (array), returnType (string). verifiedPure is
	// not required and not checked (ADR-0019).
	let ok = true;
	for (const [predicateName, entry] of Object.entries(raw.predicates)) {
		if (!isRecord(entry)) {
			pushShapeError(
				`contracts.predicates.${predicateName}`,
				`Predicate "${predicateName}" must be an object`,
			);
			ok = false;
			continue;
		}
		if (typeof entry.source !== "string") {
			pushShapeError(
				`contracts.predicates.${predicateName}.source`,
				`Predicate "${predicateName}" must have a string "source" field`,
			);
			ok = false;
		}
		if (!Array.isArray(entry.params)) {
			pushShapeError(
				`contracts.predicates.${predicateName}.params`,
				`Predicate "${predicateName}" must have an array "params" field`,
			);
			ok = false;
		}
		if (!Array.isArray(entry.paramTypes)) {
			pushShapeError(
				`contracts.predicates.${predicateName}.paramTypes`,
				`Predicate "${predicateName}" must have an array "paramTypes" field`,
			);
			ok = false;
		}
		if (typeof entry.returnType !== "string") {
			pushShapeError(
				`contracts.predicates.${predicateName}.returnType`,
				`Predicate "${predicateName}" must have a string "returnType" field`,
			);
			ok = false;
		}
	}
	return ok;
}

/**
 * The schema-store types declare their record keys as required (build-spec
 * §3.2–§3.4), but init.ts seeds the three stores as empty `{}` without the key
 * (version-less since ADR-0018). The semantic validator indexes
 * `manifests.manifests` unguarded (validator.ts getManifestEntry), so a
 * degenerate shape would crash it — violating the loader's never-throws
 * promise (ADR-0010). Default an absent record key to an empty record so
 * downstream consumers always see the declared shape. `key in file` throws on
 * primitives (chunk 3.4a, F1), so a non-object file is returned untouched —
 * the shape-guard pass has already flagged it as INVALID_SHAPE and
 * loadWorkspace skips downstream use.
 */
function withRecordKey<T extends object, K extends string>(
	file: T | null,
	key: K,
): T | null {
	if (file === null || typeof file !== "object") {
		return file;
	}
	if (key in file) {
		return file;
	}
	return { ...file, [key]: {} } as T;
}

/**
 * Per parsed clause, the info semanticValidate needs beyond the AST: the
 * clauseKind and the validation scope — invariants are scoped to the component
 * only (no operation), pre/postconditions to the owning component+operation.
 */
type ClauseMeta = {
	kind: ClauseKind;
	scope: ValidatorScope;
};

/**
 * Parses every expr string in contracts.json into an AST keyed by the clause
 * id, decorating each parse error's field with the entry index within its
 * clauseKind array (e.g. "postconditions[0]"). Also records, for every
 * successfully-parsed clause id, its ClauseMeta so loadWorkspace can run
 * semanticValidate with the exact kind + scope the clause belongs to. A clause
 * that fails to parse never appears in parsedContracts and therefore never
 * reaches the semantic validator.
 */
function parseContracts(contracts: ContractsFile): {
	parsedContracts: Record<string, Node>;
	parseErrors: ParseError[];
	clauseMeta: Record<string, ClauseMeta>;
} {
	const parsedContracts: Record<string, Node> = {};
	const parseErrors: ParseError[] = [];
	const clauseMeta: Record<string, ClauseMeta> = {};

	const parseClause = (
		clause: ContractClause,
		kind: ClauseKind,
		index: number,
		scope: ValidatorScope,
	): void => {
		// Defense-in-depth (chunk 3.4a): the shape guard filters non-string-expr
		// clause entries before this point; a clause that slips past must not
		// crash parseExpression (which would surface a raw TypeError).
		if (typeof clause?.expr !== "string") {
			return;
		}
		const result = parseExpression(clause.expr, kind, clause.id);
		if (result.ok) {
			parsedContracts[clause.id] = result.ast;
			clauseMeta[clause.id] = { kind, scope };
			return;
		}
		for (const error of result.errors) {
			parseErrors.push({ ...error, field: `${kind}[${index}]` });
		}
	};

	for (const [componentName, component] of Object.entries(
		contracts.contracts ?? {},
	)) {
		const invariants = component.invariants ?? [];
		invariants.forEach((clause, index) =>
			parseClause(clause, "invariants", index, { component: componentName }),
		);
		for (const [operationId, operation] of Object.entries(
			component.operations ?? {},
		)) {
			const scope: ValidatorScope = {
				component: componentName,
				operation: operationId,
			};
			const preconditions = operation.preconditions ?? [];
			preconditions.forEach((clause, index) =>
				parseClause(clause, "preconditions", index, scope),
			);
			const postconditions = operation.postconditions ?? [];
			postconditions.forEach((clause, index) =>
				parseClause(clause, "postconditions", index, scope),
			);
		}
	}

	return { parsedContracts, parseErrors, clauseMeta };
}

export async function loadWorkspace(
	workspaceDir: string,
): Promise<VersaillesContext> {
	const validationErrors: (LoaderError | ValidationError)[] = [];
	const validationWarnings: LoaderWarning[] = [];

	// ADR-0013 (Phase 3): predicates.json is retired. Predicates are now
	// declared inline in contracts.json's top-level `predicates` map.
	const [configRaw, contractsRaw, manifestsRaw] = await Promise.all([
		loadJsonFile(workspaceDir, "config.json", validationErrors),
		loadJsonFile(workspaceDir, "contracts.json", validationErrors),
		loadJsonFile(workspaceDir, "manifests.json", validationErrors),
	]);

	// ADR-0011 (contract-first emission): manifests.json is optional when it's
	// missing and contracts.json is present (greenfield workspace).
	// config.json and contracts.json remain required.
	if (contractsRaw !== null) {
		const manifestsMissing = manifestsRaw === null;
		// Greenfield: manifests is missing
		if (manifestsMissing) {
			// Filter out MISSING_FILE errors for manifests.json
			for (let i = validationErrors.length - 1; i >= 0; i--) {
				const error = validationErrors[i];
				if (error.code === "MISSING_FILE" && error.field === "manifests.json") {
					validationErrors.splice(i, 1);
				}
			}
		}
	}

	// Runtime shape guard (chunk 3.4a, F1): records INVALID_SHAPE errors for
	// valid-JSON/wrong-shape files and reports which stores are safe to use.
	// Runs BEFORE withRecordKey / parseContracts so a degenerate shape can
	// never reach a consumer that assumes the declared TypeScript types
	// (ADR-0010 never-throws).
	const shape = validateWorkspaceShapes(
		contractsRaw,
		manifestsRaw,
		validationErrors,
	);

	// ADR-0013 (Phase 3): extract predicates from contracts.json's top-level
	// `predicates` map and build the PredicatesFile shape for backward
	// compatibility with the validator.
	let predicatesFile: PredicatesFile | null = null;
	if (contractsRaw !== null && isRecord(contractsRaw) && shape.predicates) {
		const contractsObj = contractsRaw as Record<string, unknown>;
		if (isRecord(contractsObj.predicates)) {
			const predicateMap: Record<
				string,
				{
					params: string[];
					paramTypes: string[];
					returnType: string;
					sourceRef: string;
				}
			> = {};

			// Derive the project root from workspaceDir (workspaceDir is .versailles/,
			// so the project root is its parent).
			const projectRoot = join(workspaceDir, "..");

			for (const [name, entry] of Object.entries(contractsObj.predicates)) {
				// Validate predicate name (must be a valid IDENT)
				if (!isValidPredicateName(name)) {
					validationErrors.push({
						code: "INVALID_PREDICATE_NAME" as LoaderErrorCode,
						field: `contracts.predicates.${name}`,
						detail: `"${name}" is not a valid predicate name — predicate_call IDENT is /^[A-Za-z_][A-Za-z0-9_]*$/ and not a reserved keyword`,
					});
					continue;
				}

				if (isRecord(entry)) {
					const source = typeof entry.source === "string" ? entry.source : "";
					const params = Array.isArray(entry.params) ? entry.params : [];
					const paramTypes = Array.isArray(entry.paramTypes)
						? entry.paramTypes
						: [];
					const returnType =
						typeof entry.returnType === "string" ? entry.returnType : "";

					// ADR-0013: sourceHash is dropped from the declaration;
					// ADR-0018 removes the vestige from the PredicatesFile
					// shape too. ADR-0019: verifiedPure is dropped — a legacy
					// field is read but not carried into the normalized entry.
					predicateMap[name] = {
						params,
						paramTypes,
						returnType,
						sourceRef: source,
					};

					// Resolve-or-warn: attempt to resolve the source under
					// config.sourceRoots. Unresolvable → warning, not error.
					if (
						source &&
						configRaw !== null &&
						isRecord(configRaw) &&
						Array.isArray(configRaw.sourceRoots)
					) {
						const config = configRaw as WorkspaceConfig;
						const roots = expandSourceRootsInline(
							config.sourceRoots ?? [],
							projectRoot,
						);
						const resolved = resolvePredicateSource(roots, source);
						if (!resolved.ok) {
							validationWarnings.push({
								code: "PREDICATE_SOURCE_UNRESOLVED",
								field: `contracts.predicates.${name}.source`,
								detail: `Predicate "${name}" source "${source}" could not be resolved under config.sourceRoots`,
							});
						}
					}
				}
			}

			predicatesFile = {
				predicates: predicateMap,
			};
		}
	}

	const context: VersaillesContext = {
		config: configRaw as WorkspaceConfig | null,
		contracts: withRecordKey(contractsRaw as ContractsFile | null, "contracts"),
		manifests: withRecordKey(manifestsRaw as ManifestsFile | null, "manifests"),
		predicates: predicatesFile,
		parsedContracts: {},
		parseErrors: [],
		validationErrors,
		validationWarnings,
		isValid: false,
	};

	// Config validation (build-spec §5 / config.schema.json) runs
	// unconditionally whenever config.json is present — no version gates
	// precede it since ADR-0018.
	if (context.config !== null) {
		const configValidator = getConfigValidator();
		if (!configValidator.validate(context.config)) {
			for (const error of configValidator.errors ?? []) {
				validationErrors.push({
					code: "CONFIG_INVALID",
					field: error.instancePath,
					detail: error.message ?? "",
				});
			}
		}
	}

	if (context.contracts !== null && shape.contracts) {
		const result = parseContracts(context.contracts);
		context.parsedContracts = result.parsedContracts;
		context.parseErrors = result.parseErrors;

		// Semantic validation (§6.5) resolves through ALL three stores; a
		// degenerate manifests/predicates file (flagged INVALID_SHAPE above)
		// would crash resolution (e.g. getManifestEntry reading a missing
		// `fields`), so the pass is skipped when any store is shape-invalid.
		// The INVALID_SHAPE error already flips isValid.
		if (shape.manifests && shape.predicates) {
			// The §5.1 checks run over every successfully-parsed clause with
			// the clauseKind + scope recorded during parsing. Semantic errors
			// carry the clause contractId; ADR-0004 warnings are non-blocking
			// and never flip isValid. The arrays are shared with the
			// loader-level errors above — appends, never a replace.
			for (const clauseId of Object.keys(context.parsedContracts)) {
				const meta = result.clauseMeta[clauseId];
				if (meta === undefined) {
					continue;
				}
				const validation = semanticValidate(
					context.parsedContracts[clauseId],
					meta.kind,
					clauseId,
					context,
					meta.scope,
				);
				context.validationErrors.push(...validation.errors);
				context.validationWarnings.push(...validation.warnings);
			}
		}
	}

	context.isValid =
		context.parseErrors.length === 0 && context.validationErrors.length === 0;

	return context;
}
