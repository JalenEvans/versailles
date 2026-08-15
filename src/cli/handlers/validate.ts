/**
 * validate handler — runs the parser and semantic validator across all of
 * contracts.json via the shared loader (build-spec §6, §10) and reports a
 * structured { ok, errors, warnings, exitCode } envelope. ok true / exit 0 on
 * a valid workspace; ok false / exit 1 with structured errors on any
 * parse/validation/load failure — never an unstructured throw.
 */
import { join } from "node:path";

import { loadWorkspace } from "../../loader/workspace.js";
import { contextErrors, contextWarnings } from "../context.js";
import type { CliResult } from "../types.js";

export async function handleValidate(cwd: string): Promise<CliResult> {
	const context = await loadWorkspace(join(cwd, ".versailles"));
	return {
		ok: context.isValid,
		errors: contextErrors(context),
		warnings: contextWarnings(context),
		exitCode: context.isValid ? 0 : 1,
		output: { valid: context.isValid },
	};
}
