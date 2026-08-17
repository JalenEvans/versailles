/**
 * extract-manifests handler (build-spec §7, §12) — runs the manifest
 * extractor over config.sourceRoots and merges the result into
 * manifests.json: covered components are updated, uncovered components are
 * preserved unless --prune is passed (removal is never implicit).
 *
 * Output buckets (sorted for deterministic JSON, ADR-0002):
 *   updated   = components covered by the fresh extraction (added OR refreshed)
 *   preserved = components in the previous manifests.json the extraction did
 *               not cover, kept because --prune was not passed
 *   pruned    = components in the previous manifests.json the extraction did
 *               not cover, REMOVED because --prune was passed
 */
import { join } from "node:path";

import { extractManifests, mergeManifests } from "../../extractors/index.js";
import type { ManifestMap } from "../../extractors/types.js";
import { loadWorkspace } from "../../loader/workspace.js";
import {
	contextErrors,
	expandSourceRoots,
	extractorWarnings,
	sourceRootsGuard,
	writeJsonFile,
} from "../context.js";
import type { CliResult } from "../types.js";

export async function handleExtractManifests(
	cwd: string,
	prune: boolean,
): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");
	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: [],
			exitCode: 1,
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
		};
	}

	const roots = expandSourceRoots(context.config.sourceRoots ?? [], cwd);
	const stored = context.manifests?.manifests ?? {};

	// Center W2: zero resolved roots with a non-empty store means the scan
	// covered nothing — with --prune the merge would silently delete every
	// stored entry. Refuse and leave manifests.json byte-identical.
	const zeroRoots = sourceRootsGuard(roots, stored);
	if (zeroRoots !== null) {
		return zeroRoots;
	}

	const extracted = extractManifests(roots);
	const warnings = extractorWarnings(extracted.warnings);

	// The loader store format ({ sourceHash, fields: Record, sourcePath? })
	// differs from the extractor ManifestMap ({ fields: FieldEntry[],
	// sourcePath, confidence }); convert the stored manifests so
	// mergeManifests can operate on one shape. sourcePath is carried through
	// from the store (VERSAILLES-21 F2): a preserved legacy entry without one
	// converts to "" internally and is omitted from the store write — never an
	// invented or empty persisted path.
	const existing: ManifestMap = {};
	for (const [component, entry] of Object.entries(stored)) {
		existing[component] = {
			component,
			fields: Object.entries(entry.fields).map(([name, typeRef]) => ({
				name,
				typeRef,
				confidence: "high",
			})),
			sourceHash: entry.sourceHash,
			sourcePath: entry.sourcePath ?? "",
			confidence: "high",
		};
	}

	const merged = mergeManifests(existing, extracted.manifests, { prune });

	// Output buckets derived from the input sets (sorted for determinism).
	const updated = Object.keys(extracted.manifests).sort();
	const preserved: string[] = [];
	const pruned: string[] = [];
	for (const component of Object.keys(existing)) {
		if (component in extracted.manifests) {
			continue;
		}
		if (prune) {
			pruned.push(component);
		} else {
			preserved.push(component);
		}
	}
	preserved.sort();
	pruned.sort();

	const mergedStore: Record<
		string,
		{ sourceHash: string; fields: Record<string, string>; sourcePath?: string }
	> = {};
	for (const [component, entry] of Object.entries(merged)) {
		const storeEntry: {
			sourceHash: string;
			fields: Record<string, string>;
			sourcePath?: string;
		} = {
			sourceHash: entry.sourceHash,
			fields: Object.fromEntries(
				entry.fields.map((field) => [field.name, field.typeRef]),
			),
		};
		// Covered entries carry the extractor's real sourcePath; preserved
		// legacy entries without one convert to "" and stay out of the store
		// (contract: never an empty or invented persisted sourcePath).
		if (entry.sourcePath.length > 0) {
			storeEntry.sourcePath = entry.sourcePath;
		}
		mergedStore[component] = storeEntry;
	}
	await writeJsonFile(workspaceDir, "manifests.json", {
		version: "1.0",
		manifests: mergedStore,
	});

	return {
		ok: true,
		errors: [],
		warnings,
		exitCode: 0,
		output: { updated, preserved, pruned },
	};
}
