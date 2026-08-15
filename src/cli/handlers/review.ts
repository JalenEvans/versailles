/**
 * review handler (build-spec §11, docs/contracts/review.contract.yaml) — the
 * human-in-the-loop approval gate between staged contract objects and
 * contracts.json (ADR-0003, ADR-0010).
 *
 *   review <component>                       → scoped view of the staged component
 *   review <component> <operation>           → scoped view of the staged operation
 *   review <component> [operation] --approve → single-object read-modify-write merge
 *   review <component> [operation] --reject  → write nothing (contractDeclined)
 *
 * Staged objects arrive from the external-agent flow as one object per file
 * (.versailles/staged/<component>.json or .versailles/staged/<component>.<operation>.json)
 * and are consumed as-is — never re-authored, never passed through an LLM
 * (ADR-0010). Approval writes no approvedBy/approvedAt metadata into
 * contracts.json: the merge commit is the audit trail (ADR-0003).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadWorkspace } from "../../loader/workspace.js";
import { buildExprViews, validateStaged } from "../../review/review.js";
import {
	contextErrors,
	contextWarnings,
	messageOf,
	writeJsonFile,
} from "../context.js";
import type { CliResult } from "../types.js";

export type ReviewFlag = "approve" | "reject" | null;

type StagedLoad =
	| { ok: true; value: unknown }
	| {
			ok: false;
			code: "NOT_FOUND" | "INVALID_JSON" | "STAGED_READ_FAILED";
			field: string;
			detail: string;
	  };

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function targetKey(component: string, operation?: string): string {
	return operation === undefined ? component : `${component}.${operation}`;
}

async function loadStagedObject(
	workspaceDir: string,
	component: string,
	operation?: string,
): Promise<StagedLoad> {
	const fileName =
		operation === undefined
			? `${component}.json`
			: `${component}.${operation}.json`;
	let raw: string;
	try {
		raw = await readFile(join(workspaceDir, "staged", fileName), "utf8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return {
				ok: false,
				code: "NOT_FOUND",
				field: `staged/${fileName}`,
				detail: `No staged contract object at .versailles/staged/${fileName} for "${targetKey(component, operation)}"`,
			};
		}
		return {
			ok: false,
			code: "STAGED_READ_FAILED",
			field: `staged/${fileName}`,
			detail: `Failed to read .versailles/staged/${fileName}: ${messageOf(error)}`,
		};
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		return {
			ok: false,
			code: "INVALID_JSON",
			field: `staged/${fileName}`,
			detail: `Staged contract file ".versailles/staged/${fileName}" is not valid JSON`,
		};
	}
}

function stagedFailure(load: Extract<StagedLoad, { ok: false }>): CliResult {
	return {
		ok: false,
		errors: [{ code: load.code, field: load.field, detail: load.detail }],
		warnings: [],
		exitCode: 1,
	};
}

/**
 * Read-modify-write merge of exactly one key into contracts.json (ADR-0003):
 * component approval writes contracts[component]; operation approval writes
 * contracts[component].operations[operation], preserving every other key.
 * Returns the merged target key.
 */
async function mergeStaged(
	workspaceDir: string,
	component: string,
	staged: unknown,
	operation?: string,
): Promise<string> {
	const contractsPath = join(workspaceDir, "contracts.json");
	const raw = await readFile(contractsPath, "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const contracts = (parsed.contracts ?? {}) as Record<string, unknown>;

	if (operation === undefined) {
		contracts[component] = staged;
	} else {
		const existing = contracts[component];
		const componentRecord =
			existing !== null &&
			typeof existing === "object" &&
			!Array.isArray(existing)
				? (existing as Record<string, unknown>)
				: { invariants: [], operations: {} };
		const operations =
			componentRecord.operations !== null &&
			typeof componentRecord.operations === "object" &&
			!Array.isArray(componentRecord.operations)
				? (componentRecord.operations as Record<string, unknown>)
				: {};
		operations[operation] = staged;
		componentRecord.operations = operations;
		contracts[component] = componentRecord;
	}
	parsed.contracts = contracts;
	await writeJsonFile(workspaceDir, "contracts.json", parsed);
	return targetKey(component, operation);
}

export async function handleReview(
	cwd: string,
	component: string,
	operation?: string,
	flag: ReviewFlag = null,
): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");

	if (flag === "reject") {
		const staged = await loadStagedObject(workspaceDir, component, operation);
		if (!staged.ok) {
			return stagedFailure(staged);
		}
		// Rejection writes nothing to contracts.json and creates no merge
		// commit — the staged object never enters the audit trail
		// (glossary: contractDeclined).
		return {
			ok: true,
			errors: [],
			warnings: [],
			exitCode: 0,
			output: { declined: targetKey(component, operation) },
		};
	}

	if (flag === "approve") {
		const context = await loadWorkspace(workspaceDir);
		const staged = await loadStagedObject(workspaceDir, component, operation);
		if (!staged.ok) {
			return stagedFailure(staged);
		}
		// approve.requires: "the staged contract object has passed validation
		// (no hard errors)" — a parse/validation failure must never merge.
		const stagedContext = validateStaged(
			context,
			component,
			staged.value,
			operation,
		);
		const errors = contextErrors(stagedContext);
		if (errors.length > 0) {
			return {
				ok: false,
				errors,
				warnings: contextWarnings(stagedContext),
				exitCode: 1,
			};
		}
		try {
			const merged = await mergeStaged(
				workspaceDir,
				component,
				staged.value,
				operation,
			);
			return {
				ok: true,
				errors: [],
				warnings: contextWarnings(stagedContext),
				exitCode: 0,
				output: { merged, contract: staged.value },
			};
		} catch (error) {
			return {
				ok: false,
				errors: [
					{
						code: "MERGE_FAILED",
						field: "contracts.json",
						detail: `Failed to merge into contracts.json: ${messageOf(error)}`,
					},
				],
				warnings: [],
				exitCode: 1,
			};
		}
	}

	// Scoped review view (no flag): the staged sub-object plus its raw expr +
	// AST pairs and any validator warnings. Only the scoped sub-object is
	// presented — never the whole contracts.json (build-spec §11).
	const context = await loadWorkspace(workspaceDir);
	const staged = await loadStagedObject(workspaceDir, component, operation);
	if (!staged.ok) {
		return stagedFailure(staged);
	}
	const stagedContext = validateStaged(
		context,
		component,
		staged.value,
		operation,
	);
	return {
		ok: true,
		errors: contextErrors(stagedContext),
		warnings: contextWarnings(stagedContext),
		exitCode: 0,
		output: {
			component,
			operation: operation ?? null,
			contract: staged.value,
			exprViews: buildExprViews(staged.value, operation),
		},
	};
}
