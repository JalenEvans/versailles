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
 *
 * VERSAILLES-171: the workspace gate (requireValidWorkspace) runs first; its
 * failure-path output is the standardized {} (never { staleIds: [] }).
 */
import {
	ExtractorDependencyMissingError,
	computeSourceHash,
	extractManifests,
} from "../../../../frontend-ts/src/extractors/index.js";
import type { ExtractorResult } from "../../../../frontend-ts/src/extractors/types.js";
import {
	contextWarnings,
	expandSourceRoots,
	extractorWarnings,
	requireValidWorkspace,
	sourceRootsGuard,
} from "../context.js";
import type { CliError, CliResult } from "../types.js";

export async function handleCheck(cwd: string): Promise<CliResult> {
	const guard = await requireValidWorkspace(cwd);
	if (!guard.ok) {
		return guard.result;
	}
	const { context } = guard;

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
	//
	// VERSAILLES-191 W1: the designed extractor dependency error must survive
	// the handler boundary as its own code (EXTRACTOR_DEPENDENCY_MISSING) —
	// never the generic INTERNAL mask from runCli's catch. Everything else
	// rethrows to that last-resort catch.
	let extracted: ExtractorResult;
	try {
		extracted = extractManifests(roots, cwd);
	} catch (error) {
		if (error instanceof ExtractorDependencyMissingError) {
			return {
				ok: false,
				errors: [{ code: error.code, detail: error.detail }],
				warnings: [],
				exitCode: 1,
				output: {},
			};
		}
		throw error;
	}
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
