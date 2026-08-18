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
	extractorWarnings,
	sourceRootsGuard,
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
	const stored = context.manifests?.manifests ?? {};

	// Center W1: zero resolved roots with a non-empty store must never
	// false-green — every stored entry would be silently skipped as
	// "not hash-comparable" and the staleness gate would disable itself.
	const zeroRoots = sourceRootsGuard(roots, stored);
	if (zeroRoots !== null) {
		return zeroRoots;
	}

	// cwd is the project root: recomputed entries' sourcePath is anchored
	// project-root-relative (VERSAILLES-24) — check only compares structural
	// hashes, but the extracted entries stay consistent with extract-manifests.
	const extracted = extractManifests(roots, cwd);
	const extractionWarnings = extractorWarnings(extracted.warnings);

	const staleIds: string[] = [];
	for (const [component, entry] of Object.entries(stored)) {
		const fresh = extracted.manifests[component];
		if (fresh === undefined) {
			// Component no longer present in source: not hash-comparable, so it
			// is not reported as stale (pruning is an extract-manifests concern).
			continue;
		}
		// Structural hash covers sorted field pairs PLUS sorted
		// method-signature records (manifest-extraction.contract.yaml 2026-08-17,
		// VERSAILLES-20 F1) — a fields-only recompute would false-positive
		// STALE on every methods-bearing entry.
		if (computeSourceHash(fresh.fields, fresh.methods) !== entry.sourceHash) {
			staleIds.push(component);
		}
	}
	staleIds.sort();

	if (staleIds.length === 0) {
		return {
			ok: true,
			errors: [],
			warnings: [...contextWarnings(context), ...extractionWarnings],
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
		warnings: [staleError, ...contextWarnings(context), ...extractionWarnings],
		exitCode: 0,
		output: { staleIds },
	};
}
