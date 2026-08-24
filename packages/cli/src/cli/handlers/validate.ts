/**
 * validate handler — runs the parser and semantic validator across all of
 * contracts.json via the shared loader (build-spec §6, §10) and reports a
 * structured { ok, errors, warnings, exitCode } envelope. ok true / exit 0 on
 * a valid workspace; ok false / exit 1 with structured errors on any
 * parse/validation/load failure — never an unstructured throw.
 *
 * ADR-0012 Phase 2 (VERSAILLES-152): the optional `verbose` flag folds the
 * deleted review command's parser-sanity view into validate — when true, the
 * output payload carries a `verbose.exprViews` array with one entry per
 * clause in contracts.json (id, clause kind, raw expr, parsed AST or null on
 * parse failure). Without the flag, output remains the existing
 * `{ valid: boolean }` shape — no additive key.
 */
import { join } from "node:path";

import type { Node } from "../../../../core/src/core/parser.js";
import { loadWorkspace } from "../../../../core/src/loader/workspace.js";
import type { ContractsFile } from "../../../../core/src/loader/workspace.js";
import { contextErrors, contextWarnings } from "../context.js";
import type { CliResult } from "../types.js";

type ExprView = {
	id: string;
	clause: "invariants" | "preconditions" | "postconditions";
	expr: string;
	ast: Node | null;
};

/**
 * Walks contracts.json and collects one ExprView per clause (invariants +
 * each operation's preconditions + postconditions). The AST is looked up in
 * the loader's parsedContracts map — a clause whose expr failed to parse is
 * absent from that map and surfaces as `ast: null` (the parse error itself
 * is already in context.parseErrors). Sorted by id for determinism
 * (ADR-0002). Empty contracts → empty array.
 */
export function buildExprViews(
	contracts: ContractsFile | null,
	parsedContracts: Record<string, Node>,
): ExprView[] {
	const views: ExprView[] = [];
	if (contracts === null) {
		return views;
	}
	for (const [componentName, component] of Object.entries(
		contracts.contracts ?? {},
	)) {
		for (const clause of component.invariants ?? []) {
			if (typeof clause?.expr !== "string") {
				continue;
			}
			views.push({
				id: clause.id,
				clause: "invariants",
				expr: clause.expr,
				ast: parsedContracts[clause.id] ?? null,
			});
		}
		for (const operation of Object.values(component.operations ?? {})) {
			for (const clause of operation.preconditions ?? []) {
				if (typeof clause?.expr !== "string") {
					continue;
				}
				views.push({
					id: clause.id,
					clause: "preconditions",
					expr: clause.expr,
					ast: parsedContracts[clause.id] ?? null,
				});
			}
			for (const clause of operation.postconditions ?? []) {
				if (typeof clause?.expr !== "string") {
					continue;
				}
				views.push({
					id: clause.id,
					clause: "postconditions",
					expr: clause.expr,
					ast: parsedContracts[clause.id] ?? null,
				});
			}
		}
	}
	views.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return views;
}

export async function handleValidate(
	cwd: string,
	verbose = false,
): Promise<CliResult> {
	const context = await loadWorkspace(join(cwd, ".versailles"));
	const baseOutput: { valid: boolean; verbose?: { exprViews: ExprView[] } } = {
		valid: context.isValid,
	};
	if (verbose) {
		baseOutput.verbose = {
			exprViews: buildExprViews(context.contracts, context.parsedContracts),
		};
	}
	return {
		ok: context.isValid,
		errors: contextErrors(context),
		warnings: contextWarnings(context),
		exitCode: context.isValid ? 0 : 1,
		output: baseOutput,
	};
}
