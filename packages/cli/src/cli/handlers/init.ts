/**
 * init handler — scaffolds .versailles/ (build-spec §2, §12) by reusing
 * src/cli/init.ts (initWorkspace). VERSAILLES-184: init scaffolds a FRESH
 * workspace only — a second init on an existing workspace REFUSES (exit 1,
 * structured error) instead of re-seeding the three workspace files
 * (config.json + contracts.json + manifests.json), never a silent re-write
 * over authored content.
 */
import { join } from "node:path";

import { messageOf } from "../context.js";
import { initWorkspace } from "../init.js";
import type { CliResult } from "../types.js";

export async function handleInit(cwd: string): Promise<CliResult> {
	try {
		await initWorkspace(cwd);
	} catch (error) {
		return {
			ok: false,
			errors: [
				{
					code: "INIT_FAILED",
					field: ".versailles",
					detail: `Failed to scaffold .versailles/: ${messageOf(error)}`,
				},
			],
			warnings: [],
			exitCode: 1,
		};
	}
	return {
		ok: true,
		errors: [],
		warnings: [],
		exitCode: 0,
		output: { workspaceDir: join(cwd, ".versailles") },
	};
}
