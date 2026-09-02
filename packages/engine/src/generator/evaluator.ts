/**
 * The mini expression evaluator (ADR-0020): a tiny evaluator over the
 * restricted, side-effect-free grammar — enough to resolve `old(field)`
 * against the captured pre-state and check invariants/postconditions during
 * planning, and to derive the post-call state from effect-field
 * postconditions. Pure and deterministic.
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractClause,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import { fieldRefName } from "./clause-analysis.js";

export type EvalEnv = {
	params: Record<string, unknown>;
	pre: Record<string, unknown>;
	post: Record<string, unknown>;
};

/**
 * Derives the post-call state from postconditions of the shape
 * `expr == f` / `f == expr` where f is an effect field (e.g.
 * `old(balance) - amount == balance` → post.balance = old(balance) - amount).
 * Used only by the expected-rejection search.
 */
export function derivePostState(
	postconditions: ContractClause[],
	pre: Record<string, unknown>,
	params: Record<string, unknown>,
	effectFields: Set<string>,
	context: VersaillesContext,
): Record<string, unknown> {
	const post: Record<string, unknown> = { ...pre };
	for (const clause of postconditions) {
		const ast = context.parsedContracts[clause.id];
		if (ast === undefined || ast.type !== "compare" || ast.op !== "==") {
			continue;
		}
		const rightVar = fieldRefName(ast.right);
		if (rightVar !== null && effectFields.has(rightVar)) {
			post[rightVar] = evaluate(ast.left, { params, pre, post });
		}
		const leftVar = fieldRefName(ast.left);
		if (leftVar !== null && effectFields.has(leftVar)) {
			post[leftVar] = evaluate(ast.right, { params, pre, post });
		}
	}
	return post;
}

/**
 * A tiny evaluator over the restricted, side-effect-free grammar — enough to
 * resolve `old(field)` against the captured pre-state and check
 * invariants/postconditions during planning. Pure and deterministic.
 */
export function evaluate(node: Node, env: EvalEnv): unknown {
	switch (node.type) {
		case "literal":
			return node.value;
		case "fieldRef": {
			const root = node.path[0];
			if (typeof root === "string") {
				// DbC post-state resolution (Center W3): in postcondition
				// evaluation a bare field ref is the POST-state — only
				// old(...) names the pre-state. Resolution order is therefore
				// params → post → pre. (Callers that evaluate invariants and
				// preconditions pass pre === post, so this order is neutral
				// there.)
				if (root in env.params) {
					return env.params[root];
				}
				if (root in env.post) {
					return env.post[root];
				}
				if (root in env.pre) {
					return env.pre[root];
				}
			}
			return undefined;
		}
		case "old": {
			const root = node.ref.path[0];
			if (typeof root === "string" && root in env.pre) {
				return env.pre[root];
			}
			return undefined;
		}
		case "arithmetic": {
			const left = evaluate(node.left, env);
			const right = evaluate(node.right, env);
			if (typeof left !== "number" || typeof right !== "number") {
				return undefined;
			}
			switch (node.op) {
				case "+":
					return left + right;
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return right === 0 ? undefined : left / right;
			}
			return undefined;
		}
		case "compare": {
			const left = evaluate(node.left, env);
			const right = evaluate(node.right, env);
			switch (node.op) {
				case "==":
					return left === right;
				case "!=":
					return left !== right;
				case ">":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left > right
					);
				case ">=":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left >= right
					);
				case "<":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left < right
					);
				case "<=":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left <= right
					);
				case "in":
					return (
						Array.isArray(right) && right.some((member) => member === left)
					);
			}
			return undefined;
		}
		case "and":
			return (
				Boolean(evaluate(node.left, env)) && Boolean(evaluate(node.right, env))
			);
		case "or":
			return (
				Boolean(evaluate(node.left, env)) || Boolean(evaluate(node.right, env))
			);
		case "not":
			return !evaluate(node.operand, env);
		case "predicateCall":
			return undefined;
	}
	return undefined;
}
