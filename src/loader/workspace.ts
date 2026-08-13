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
 * In this phase the semantic validator does not exist yet — config schema
 * errors are recorded as CONFIG_INVALID, and validationErrors otherwise holds
 * only loader-level errors (VERSION_MISMATCH / MISSING_FILE / INVALID_JSON).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";

import configSchema from "../../config.schema.json" with { type: "json" };
import { parseExpression } from "../core/parser.js";
import type { ClauseKind, Node, ParseError } from "../core/parser.js";

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
	validationErrors: LoaderError[];
	validationWarnings: LoaderWarning[];
	isValid: boolean;
};

export type ScopedView = {
	component: string;
	operation: string | null;
	contract: ComponentContract | ContractOperation | null;
	errors: (ParseError | LoaderError)[];
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
	validationErrors: LoaderError[],
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
 * Parses every expr string in contracts.json into an AST keyed by the clause
 * id, decorating each parse error's field with the entry index within its
 * clauseKind array (e.g. "postconditions[0]").
 */
function parseContracts(contracts: ContractsFile): {
	parsedContracts: Record<string, Node>;
	parseErrors: ParseError[];
} {
	const parsedContracts: Record<string, Node> = {};
	const parseErrors: ParseError[] = [];

	const parseClause = (
		clause: ContractClause,
		kind: ClauseKind,
		index: number,
	): void => {
		const result = parseExpression(clause.expr, kind, clause.id);
		if (result.ok) {
			parsedContracts[clause.id] = result.ast;
			return;
		}
		for (const error of result.errors) {
			parseErrors.push({ ...error, field: `${kind}[${index}]` });
		}
	};

	for (const component of Object.values(contracts.contracts ?? {})) {
		const invariants = component.invariants ?? [];
		invariants.forEach((clause, index) =>
			parseClause(clause, "invariants", index),
		);
		for (const operation of Object.values(component.operations ?? {})) {
			const preconditions = operation.preconditions ?? [];
			preconditions.forEach((clause, index) =>
				parseClause(clause, "preconditions", index),
			);
			const postconditions = operation.postconditions ?? [];
			postconditions.forEach((clause, index) =>
				parseClause(clause, "postconditions", index),
			);
		}
	}

	return { parsedContracts, parseErrors };
}

export async function loadWorkspace(
	workspaceDir: string,
): Promise<VersaillesContext> {
	const validationErrors: LoaderError[] = [];
	const validationWarnings: LoaderWarning[] = [];

	const [configRaw, contractsRaw, manifestsRaw, predicatesRaw] =
		await Promise.all([
			loadJsonFile(workspaceDir, "config.json", validationErrors),
			loadJsonFile(workspaceDir, "contracts.json", validationErrors),
			loadJsonFile(workspaceDir, "manifests.json", validationErrors),
			loadJsonFile(workspaceDir, "predicates.json", validationErrors),
		]);

	const config = configRaw as WorkspaceConfig | null;
	const contracts = contractsRaw as ContractsFile | null;
	const manifests = manifestsRaw as ManifestsFile | null;
	const predicates = predicatesRaw as PredicatesFile | null;

	// Version gates (build-spec §3.1): checked before config validation and
	// expr parsing; a mismatch short-circuits all downstream processing.
	let versionOk = true;
	if (config !== null) {
		if (config.grammarVersion !== SUPPORTED_GRAMMAR_VERSION) {
			validationErrors.push({
				code: "VERSION_MISMATCH",
				field: "grammarVersion",
				detail: `config.grammarVersion "${config.grammarVersion}" is not supported — upgrade to "${SUPPORTED_GRAMMAR_VERSION}"`,
			});
			versionOk = false;
		}
		if (config.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
			validationErrors.push({
				code: "VERSION_MISMATCH",
				field: "schemaVersion",
				detail: `config.schemaVersion "${config.schemaVersion}" is not supported — upgrade to "${SUPPORTED_SCHEMA_VERSION}"`,
			});
			versionOk = false;
		}
	}

	let parsedContracts: Record<string, Node> = {};
	let parseErrors: ParseError[] = [];

	if (versionOk && config !== null) {
		const configValidator = getConfigValidator();
		if (!configValidator.validate(config)) {
			for (const error of configValidator.errors ?? []) {
				validationErrors.push({
					code: "CONFIG_INVALID",
					field: error.instancePath,
					detail: error.message ?? "",
				});
			}
		}
	}

	if (versionOk && contracts !== null) {
		const result = parseContracts(contracts);
		parsedContracts = result.parsedContracts;
		parseErrors = result.parseErrors;
	}

	return {
		config,
		contracts,
		manifests,
		predicates,
		parsedContracts,
		parseErrors,
		validationErrors,
		validationWarnings,
		isValid: parseErrors.length === 0 && validationErrors.length === 0,
	};
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
): (ParseError | LoaderError)[] {
	const parseScoped = context.parseErrors.filter((error) =>
		error.contractId.startsWith(prefix),
	);
	const validationScoped = context.validationErrors.filter((error) =>
		belongsTo(error, prefix),
	);
	return [...parseScoped, ...validationScoped];
}

function belongsTo(error: ParseError | LoaderError, prefix: string): boolean {
	return "contractId" in error && error.contractId.startsWith(prefix);
}
