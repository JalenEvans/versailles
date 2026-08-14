/**
 * The joint `.versailles/` loader — the single shared path into a workspace
 * (build-spec §6). Loads and JSON-parses the four jointly-loaded files
 * (config.json, contracts.json, manifests.json, predicates.json), applies the
 * version gates (build-spec §3.1) BEFORE any other processing, parses every
 * expr string in contracts.json into an AST via parseExpression, validates
 * config.json against config.schema.json, and returns ONE VersaillesContext
 * with an aggregated isValid flag (build-spec §6.5).
 *
 * The loader never throws on missing/invalid files or malformed exprs: every
 * failure path returns a structured LoaderError/ParseError inside the context.
 * After parsing, the semantic validator (build-spec §5) runs over every
 * successfully-parsed clause with its clauseKind + owning scope; semantic
 * errors join loader-level errors (VERSION_MISMATCH / MISSING_FILE /
 * INVALID_JSON / CONFIG_INVALID) in validationErrors, and ADR-0004 warnings
 * land in validationWarnings without flipping isValid.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";

import configSchema from "../../config.schema.json" with { type: "json" };
import { parseExpression } from "../core/parser.js";
import type { ClauseKind, Node, ParseError } from "../core/parser.js";
import { semanticValidate } from "../core/validator.js";
import type { ValidationError, ValidatorScope } from "../core/validator.js";

export const SUPPORTED_GRAMMAR_VERSION = "1.0";
export const SUPPORTED_SCHEMA_VERSION = "1.0";

export type WorkspaceConfig = {
	grammarVersion: string;
	schemaVersion: string;
	sourceRoots: string[];
	language: "typescript" | "csharp" | "python";
	testFramework: "vitest" | "xunit" | "pytest";
	generatedDir: string;
	staleness: { blockOnStale: boolean };
	rejection?: { idiom: "throws" | "returns" };
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
	version: string;
	contracts: Record<string, ComponentContract>;
};

export type ManifestsFile = {
	version: string;
	manifests: Record<
		string,
		{ sourceHash: string; fields: Record<string, string> }
	>;
};

export type PredicatesFile = {
	version: string;
	predicates: Record<
		string,
		{
			params: string[];
			paramTypes: string[];
			returnType: string;
			sourceRef: string;
			sourceHash: string;
			verifiedPure: boolean;
		}
	>;
};

export type LoaderErrorCode =
	| "VERSION_MISMATCH"
	| "MISSING_FILE"
	| "INVALID_JSON"
	| "CONFIG_INVALID"
	| "NOT_FOUND";

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

export type ScopedView = {
	component: string;
	operation: string | null;
	contract: ComponentContract | ContractOperation | null;
	errors: (ParseError | LoaderError | ValidationError)[];
	warnings: LoaderWarning[];
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
 * and null; invalid JSON → INVALID_JSON error and null. Never throws for the
 * covered failure modes.
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
		return JSON.parse(raw) as unknown;
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

/**
 * The schema-store types declare their record keys as required (build-spec
 * §3.2–§3.4), but init.ts seeds the three stores as bare `{ "version": "1.0" }`
 * without the key. The semantic validator indexes `manifests.manifests`
 * unguarded (validator.ts getManifestEntry) and extractScoped indexes
 * `contracts.contracts` the same way, so a degenerate shape would crash them —
 * violating the loader's never-throws promise (ADR-0010). Default an absent
 * record key to an empty record so downstream consumers always see the
 * declared shape.
 */
function withRecordKey<T extends { version: string }, K extends string>(
	file: T | null,
	key: K,
): T | null {
	if (file === null || key in file) {
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

	const [configRaw, contractsRaw, manifestsRaw, predicatesRaw] =
		await Promise.all([
			loadJsonFile(workspaceDir, "config.json", validationErrors),
			loadJsonFile(workspaceDir, "contracts.json", validationErrors),
			loadJsonFile(workspaceDir, "manifests.json", validationErrors),
			loadJsonFile(workspaceDir, "predicates.json", validationErrors),
		]);

	const context: VersaillesContext = {
		config: configRaw as WorkspaceConfig | null,
		contracts: withRecordKey(contractsRaw as ContractsFile | null, "contracts"),
		manifests: withRecordKey(manifestsRaw as ManifestsFile | null, "manifests"),
		predicates: withRecordKey(
			predicatesRaw as PredicatesFile | null,
			"predicates",
		),
		parsedContracts: {},
		parseErrors: [],
		validationErrors,
		validationWarnings,
		isValid: false,
	};

	// Version gates (build-spec §3.1): checked before config validation and
	// expr parsing; a mismatch short-circuits all downstream processing.
	let versionOk = true;
	if (context.config !== null) {
		if (context.config.grammarVersion !== SUPPORTED_GRAMMAR_VERSION) {
			validationErrors.push({
				code: "VERSION_MISMATCH",
				field: "grammarVersion",
				detail: `config.grammarVersion "${context.config.grammarVersion}" is not supported — upgrade to "${SUPPORTED_GRAMMAR_VERSION}"`,
			});
			versionOk = false;
		}
		if (context.config.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
			validationErrors.push({
				code: "VERSION_MISMATCH",
				field: "schemaVersion",
				detail: `config.schemaVersion "${context.config.schemaVersion}" is not supported — upgrade to "${SUPPORTED_SCHEMA_VERSION}"`,
			});
			versionOk = false;
		}
	}

	if (versionOk && context.config !== null) {
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

	if (versionOk && context.contracts !== null) {
		const result = parseContracts(context.contracts);
		context.parsedContracts = result.parsedContracts;
		context.parseErrors = result.parseErrors;

		// Semantic validation (build-spec §6.5): run the §5.1 checks over every
		// successfully-parsed clause with the clauseKind + scope recorded during
		// parsing. Semantic errors carry the clause contractId (so extractScoped
		// attributes them to the owning component/operation); ADR-0004 warnings
		// are non-blocking and never flip isValid. The arrays are shared with the
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

	context.isValid =
		context.parseErrors.length === 0 && context.validationErrors.length === 0;

	return context;
}

/**
 * Returns just the requested sub-object (never the whole file), with only the
 * errors that belong to it by contractId prefix. Loader-level errors (which
 * carry no contractId) are excluded from scoped views.
 */
export function extractScoped(
	context: VersaillesContext,
	component: string,
	operation?: string,
): ScopedView {
	const target =
		operation === undefined ? component : `${component}.${operation}`;
	const contract = findContract(context.contracts, component, operation);
	if (contract === null) {
		return {
			component,
			operation: operation ?? null,
			contract: null,
			errors: [
				{
					code: "NOT_FOUND",
					field: target,
					detail: `Contract "${target}" not found in the workspace`,
				},
			],
			warnings: [],
		};
	}
	return {
		component,
		operation: operation ?? null,
		contract,
		errors: scopedErrors(context, target),
		warnings: [],
	};
}

function findContract(
	contracts: ContractsFile | null,
	component: string,
	operation: string | undefined,
): ComponentContract | ContractOperation | null {
	if (contracts === null) {
		return null;
	}
	const componentContract = contracts.contracts[component];
	if (componentContract === undefined) {
		return null;
	}
	if (operation === undefined) {
		return componentContract;
	}
	return componentContract.operations[operation] ?? null;
}

function scopedErrors(
	context: VersaillesContext,
	prefix: string,
): (ParseError | LoaderError | ValidationError)[] {
	const parseScoped = context.parseErrors.filter((error) =>
		error.contractId.startsWith(prefix),
	);
	const validationScoped = context.validationErrors.filter((error) =>
		belongsTo(error, prefix),
	);
	return [...parseScoped, ...validationScoped];
}

function belongsTo(
	error: ParseError | LoaderError | ValidationError,
	prefix: string,
): boolean {
	return "contractId" in error && error.contractId.startsWith(prefix);
}
