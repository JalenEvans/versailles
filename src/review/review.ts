/**
 * Review flow core (build-spec §11, docs/contracts/review.contract.yaml) —
 * the parser-sanity presentation and staged-object validation, kept
 * framework-agnostic (no CLI surface, no file IO). The CLI handler in
 * src/cli/handlers/review.ts owns staged-file loading and the read-modify-write
 * merge.
 *
 * A staged contract object arrives from the external-agent flow (ADR-0010) as
 * one object per file: .versailles/staged/<component>.json holds a
 * ComponentContract, .versailles/staged/<component>.<operation>.json holds a
 * ContractOperation. Both shapes are consumed as-is — never re-authored.
 */
import { parseExpression } from "../core/parser.js";
import type { ClauseKind, Node } from "../core/parser.js";
import { semanticValidate } from "../core/validator.js";
import type { ValidatorScope } from "../core/validator.js";
import type {
	ComponentContract,
	ContractOperation,
	ContractsFile,
	VersaillesContext,
} from "../loader/workspace.js";

/** One raw expr string alongside its parsed AST — the parser-sanity pair. */
export type ExprView = {
	id: string;
	clause: ClauseKind;
	expr: string;
	ast: Node | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The clauses inside a clauseKind array that carry a string expr (defense). */
function clauseEntries(value: unknown): { id: string; expr: string }[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const entries: { id: string; expr: string }[] = [];
	for (const clause of value) {
		if (!isRecord(clause) || typeof clause.expr !== "string") {
			continue;
		}
		entries.push({
			id: typeof clause.id === "string" ? clause.id : "",
			expr: clause.expr,
		});
	}
	return entries;
}

function exprView(
	clause: { id: string; expr: string },
	kind: ClauseKind,
): ExprView {
	const parsed = parseExpression(clause.expr, kind, clause.id);
	return {
		id: clause.id,
		clause: kind,
		expr: clause.expr,
		ast: parsed.ok ? parsed.ast : null,
	};
}

/**
 * The parser-sanity presentation (build-spec §11): every raw expr string in
 * the staged object alongside its parsed AST. Component-scope views include
 * invariants plus every operation's pre/postconditions; operation-scope views
 * include only the operation's own clauses — component invariants never leak
 * into an operation view.
 */
export function buildExprViews(
	contract: unknown,
	operation?: string,
): ExprView[] {
	if (!isRecord(contract)) {
		return [];
	}
	const views: ExprView[] = [];
	if (operation === undefined) {
		for (const clause of clauseEntries(contract.invariants)) {
			views.push(exprView(clause, "invariants"));
		}
		const operations = isRecord(contract.operations) ? contract.operations : {};
		for (const op of Object.values(operations)) {
			if (!isRecord(op)) {
				continue;
			}
			for (const clause of clauseEntries(op.preconditions)) {
				views.push(exprView(clause, "preconditions"));
			}
			for (const clause of clauseEntries(op.postconditions)) {
				views.push(exprView(clause, "postconditions"));
			}
		}
		return views;
	}
	for (const clause of clauseEntries(contract.preconditions)) {
		views.push(exprView(clause, "preconditions"));
	}
	for (const clause of clauseEntries(contract.postconditions)) {
		views.push(exprView(clause, "postconditions"));
	}
	return views;
}

/**
 * Validates ONE staged contract object against the workspace context, exactly
 * as if it were the only contract in contracts.json: parse every expr (parse
 * failures are hard PARSE_ERROR-family errors) then run the semantic validator
 * per successfully-parsed clause (hard validation errors), with ADR-0004
 * warnings collected separately. Returns a VersaillesContext mirroring the
 * loader's shape so the CLI adapters (contextErrors/contextWarnings) can map
 * it directly.
 */
export function validateStaged(
	base: VersaillesContext,
	component: string,
	staged: unknown,
	operation?: string,
): VersaillesContext {
	const target =
		operation === undefined ? component : `${component}.${operation}`;
	const context: VersaillesContext = {
		...base,
		contracts: buildStagedContracts(base, component, staged, operation),
		parsedContracts: {},
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: false,
	};
	if (!isRecord(staged)) {
		// A non-object staged payload (primitive/array) is a shape failure,
		// not a parse concern — record it as a hard INVALID_SHAPE LoaderError
		// so approve refuses it (approve.requires: no hard errors).
		context.validationErrors.push({
			code: "INVALID_SHAPE",
			field: target,
			detail: `Staged contract object for "${target}" is not an object`,
		});
		return context;
	}
	parseAndValidate(context);
	context.isValid =
		context.parseErrors.length === 0 && context.validationErrors.length === 0;
	return context;
}

function buildStagedContracts(
	base: VersaillesContext,
	component: string,
	staged: unknown,
	operation: string | undefined,
): ContractsFile | null {
	if (!isRecord(staged)) {
		return null;
	}
	const contracts =
		operation === undefined
			? { [component]: staged as ComponentContract }
			: {
					[component]: {
						invariants: [],
						operations: { [operation]: staged as ContractOperation },
					},
				};
	return { version: base.contracts?.version ?? "1.0", contracts };
}

/**
 * Parse + semantic-validate pass over the synthetic staged-only contracts
 * file. Mirrors the loader's parseContracts/§6.5 integration (same error
 * field decoration, same clauseKind+scope per clause) but scoped to the one
 * staged object.
 */
function parseAndValidate(context: VersaillesContext): void {
	const parsedContracts: Record<string, Node> = {};
	const clauseMeta: Record<
		string,
		{ kind: ClauseKind; scope: ValidatorScope }
	> = {};

	const parseClause = (
		clause: unknown,
		kind: ClauseKind,
		index: number,
		scope: ValidatorScope,
	): void => {
		if (!isRecord(clause) || typeof clause.expr !== "string") {
			return;
		}
		const id = typeof clause.id === "string" ? clause.id : "";
		const result = parseExpression(clause.expr, kind, id);
		if (result.ok) {
			parsedContracts[id] = result.ast;
			clauseMeta[id] = { kind, scope };
			return;
		}
		for (const error of result.errors) {
			context.parseErrors.push({ ...error, field: `${kind}[${index}]` });
		}
	};

	const contracts = context.contracts;
	if (contracts === null) {
		return;
	}
	for (const [componentName, componentRecord] of Object.entries(
		contracts.contracts,
	)) {
		if (!isRecord(componentRecord)) {
			continue;
		}
		const invariants = Array.isArray(componentRecord.invariants)
			? componentRecord.invariants
			: [];
		invariants.forEach((clause, index) =>
			parseClause(clause, "invariants", index, {
				component: componentName,
			}),
		);
		const operations = isRecord(componentRecord.operations)
			? componentRecord.operations
			: {};
		for (const [operationId, opRecord] of Object.entries(operations)) {
			if (!isRecord(opRecord)) {
				continue;
			}
			const scope: ValidatorScope = {
				component: componentName,
				operation: operationId,
			};
			const preconditions = Array.isArray(opRecord.preconditions)
				? opRecord.preconditions
				: [];
			preconditions.forEach((clause, index) =>
				parseClause(clause, "preconditions", index, scope),
			);
			const postconditions = Array.isArray(opRecord.postconditions)
				? opRecord.postconditions
				: [];
			postconditions.forEach((clause, index) =>
				parseClause(clause, "postconditions", index, scope),
			);
		}
	}

	for (const clauseId of Object.keys(parsedContracts)) {
		const meta = clauseMeta[clauseId];
		if (meta === undefined) {
			continue;
		}
		const validation = semanticValidate(
			parsedContracts[clauseId],
			meta.kind,
			clauseId,
			context,
			meta.scope,
		);
		context.validationErrors.push(...validation.errors);
		context.validationWarnings.push(...validation.warnings);
	}
}
