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
 * parse failure). VERSAILLES-168 Phase 5 (VERSAILLES-173) extends the verbose
 * namespace additively with `verbose.predicateReferences` — a reverse-reference
 * index mapping every declared predicate to the sorted clause ids whose parsed
 * ASTs call it, including declared-but-unused predicates (clauses: []).
 * Without the flag, output remains the existing `{ valid: boolean }` shape —
 * no additive key.
 */
import { join } from "node:path";

import type { Node } from "../../../../core/src/core/parser.js";
import { loadWorkspace } from "../../../../core/src/loader/workspace.js";
import type {
	ContractsFile,
	PredicatesFile,
} from "../../../../core/src/loader/workspace.js";
import { contextErrors, contextWarnings } from "../context.js";
import type { CliResult } from "../types.js";

type ExprView = {
	id: string;
	clause: "invariants" | "preconditions" | "postconditions";
	expr: string;
	ast: Node | null;
};

export type PredicateReference = {
	predicate: string;
	source: string;
	clauses: string[];
	singleUse: boolean;
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

/**
 * Collects every predicate name referenced by a parsed AST, walking
 * recursively into predicate-call arguments — nested calls like f(g(x)) appear
 * as predicateCall nodes inside `args`, so the walk must descend there.
 */
function collectPredicateCalls(node: Node, out: Set<string>): void {
	switch (node.type) {
		case "or":
		case "and":
			collectPredicateCalls(node.left, out);
			collectPredicateCalls(node.right, out);
			return;
		case "not":
			collectPredicateCalls(node.operand, out);
			return;
		case "compare":
		case "arithmetic":
			collectPredicateCalls(node.left, out);
			collectPredicateCalls(node.right, out);
			return;
		case "predicateCall":
			out.add(node.name);
			for (const arg of node.args) {
				collectPredicateCalls(arg, out);
			}
			return;
		case "old":
		case "fieldRef":
		case "literal":
			return;
	}
}

/**
 * Builds the verbose predicateReferences reverse-reference index
 * (VERSAILLES-168 Phase 5, VERSAILLES-173): one entry per DECLARED predicate
 * mapping its name and source (the declaration's `source` field, surfaced by
 * the loader as the entry's sourceRef) to the sorted clause ids whose parsed
 * ASTs call it. References come from parsedContracts only — a clause that
 * failed to parse is absent from that map and contributes nothing. A
 * predicateCall whose name is not declared is simply not represented (no
 * entry, no crash). Declared-but-unused predicates surface with clauses: []
 * so authors can discover them; singleUse is exactly clauses.length === 1.
 * Entries sorted by predicate name, clauses by id — deterministic (ADR-0002).
 * No declared predicates → [].
 */
export function buildPredicateReferences(
	predicates: PredicatesFile | null,
	parsedContracts: Record<string, Node>,
): PredicateReference[] {
	const declared = predicates?.predicates ?? {};
	const byPredicate = new Map<
		string,
		{ source: string; clauses: Set<string> }
	>();
	for (const [name, entry] of Object.entries(declared)) {
		byPredicate.set(name, { source: entry.sourceRef, clauses: new Set() });
	}
	if (byPredicate.size === 0) {
		return [];
	}
	for (const [clauseId, ast] of Object.entries(parsedContracts)) {
		const referenced = new Set<string>();
		collectPredicateCalls(ast, referenced);
		for (const name of referenced) {
			const entry = byPredicate.get(name);
			if (entry === undefined) {
				continue;
			}
			entry.clauses.add(clauseId);
		}
	}
	const refs: PredicateReference[] = [];
	for (const [predicate, entry] of byPredicate) {
		const clauses = [...entry.clauses].sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		refs.push({
			predicate,
			source: entry.source,
			clauses,
			singleUse: clauses.length === 1,
		});
	}
	refs.sort((a, b) =>
		a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : 0,
	);
	return refs;
}

export async function handleValidate(
	cwd: string,
	verbose = false,
): Promise<CliResult> {
	const context = await loadWorkspace(join(cwd, ".versailles"));
	const baseOutput: {
		valid: boolean;
		verbose?: {
			exprViews: ExprView[];
			predicateReferences: PredicateReference[];
		};
	} = {
		valid: context.isValid,
	};
	if (verbose) {
		baseOutput.verbose = {
			exprViews: buildExprViews(context.contracts, context.parsedContracts),
			predicateReferences: buildPredicateReferences(
				context.predicates,
				context.parsedContracts,
			),
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
