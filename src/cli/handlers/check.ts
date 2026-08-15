/**
 * check handler (build-spec §8, §12) — CI-mode lint. Loads the workspace,
 * fails on parse/validation errors (dominates staleness), then recomputes the
 * structural sourceHash for every manifest entry from current source and
 * compares against the stored hash.
 *
 * Exit codes (pinned by the contract):
 *   0 clean
 *   1 parse/validation errors present (dominates staleness, never 2)
 *   2 blocking staleness when staleness.blockOnStale is true
 *   0 with a STALE warning when staleness.blockOnStale is false
 */
import { join } from "node:path";

import { computeSourceHash, extractManifests } from "../../extractors/index.js";
import { loadWorkspace } from "../../loader/workspace.js";
import {
	contextErrors,
	contextWarnings,
	expandSourceRoots,
} from "../context.js";
import type { CliError, CliResult } from "../types.js";

export async function handleCheck(cwd: string): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");
	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: contextWarnings(context),
			exitCode: 1,
			output: { staleIds: [] },
		};
	}
	if (context.config === null) {
		return {
			ok: false,
			errors: [
				{
					code: "CONFIG_INVALID",
					field: "config.json",
					detail: "Workspace config is missing — cannot determine sourceRoots",
				},
			],
			warnings: [],
			exitCode: 1,
			output: { staleIds: [] },
		};
	}

	const roots = expandSourceRoots(context.config.sourceRoots ?? [], cwd);
	const extracted = extractManifests(roots);
	const stored = context.manifests?.manifests ?? {};

	const staleIds: string[] = [];
	for (const [component, entry] of Object.entries(stored)) {
		const fresh = extracted.manifests[component];
		if (fresh === undefined) {
			// Component no longer present in source: not hash-comparable, so it
			// is not reported as stale (pruning is an extract-manifests concern).
			continue;
		}
		if (computeSourceHash(fresh.fields) !== entry.sourceHash) {
			staleIds.push(component);
		}
	}
	staleIds.sort();

	if (staleIds.length === 0) {
		return {
			ok: true,
			errors: [],
			warnings: contextWarnings(context),
			exitCode: 0,
			output: { staleIds },
		};
	}

	const staleError: CliError = {
		code: "STALE",
		detail: `Stale manifests: ${staleIds.join(", ")} — source changed since extraction (structural shape differs from the stored sourceHash)`,
		ids: staleIds,
	};
	const blockOnStale = context.config.staleness?.blockOnStale ?? true;
	if (blockOnStale) {
		return {
			ok: false,
			errors: [staleError],
			warnings: [],
			exitCode: 2,
			output: { staleIds },
		};
	}
	return {
		ok: true,
		errors: [],
		warnings: [staleError],
		exitCode: 0,
		output: { staleIds },
	};
}
