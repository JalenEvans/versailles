/**
 * generate handler (build-spec §9, §12) — runs the deterministic generator
 * (planTestCases → emitSuite) and writes full-file .test.ts output under
 * config.generatedDir. Gated on context.isValid: an invalid context writes
 * ZERO files and surfaces structured errors with exit 1 (contract invariant 1,
 * build-spec §9). The rejection idiom comes from config.rejection.idiom
 * (default "throws", ADR-0007) and flows through the planner into every
 * reject case. Deterministic: same context in, byte-identical files out.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { emitSuite, planTestCases } from "../../generator/index.js";
import { loadWorkspace } from "../../loader/workspace.js";
import { contextErrors, contextWarnings, messageOf } from "../context.js";
import type { CliResult } from "../types.js";

export async function handleGenerate(cwd: string): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");
	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: contextWarnings(context),
			exitCode: 1,
			output: { files: [] },
		};
	}
	if (context.config === null) {
		return {
			ok: false,
			errors: [
				{
					code: "CONFIG_INVALID",
					field: "config.json",
					detail: "Workspace config is missing — cannot determine generatedDir",
				},
			],
			warnings: [],
			exitCode: 1,
			output: { files: [] },
		};
	}

	try {
		const suite = planTestCases(context);
		const files = emitSuite(suite, context.config.testFramework as "vitest", {
			generatedDir: context.config.generatedDir,
		});
		for (const file of files) {
			const target = join(cwd, file.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.content, "utf8");
		}
		return {
			ok: true,
			errors: [],
			warnings: contextWarnings(context),
			exitCode: 0,
			output: { files: files.map((file) => file.path) },
		};
	} catch (error) {
		// planTestCases throws on an invalid context (the isValid gate should
		// prevent it) and on unsafe identifiers — convert to structured output.
		return {
			ok: false,
			errors: [
				{
					code: "GENERATION_FAILED",
					detail: `Generation failed: ${messageOf(error)}`,
				},
			],
			warnings: [],
			exitCode: 1,
			output: { files: [] },
		};
	}
}
