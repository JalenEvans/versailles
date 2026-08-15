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
import { contextErrors, expandSourceRoots, writeJsonFile } from "../context.js";
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
	const extracted = extractManifests(roots);

	// The loader store format ({ sourceHash, fields: Record }) differs from the
	// extractor ManifestMap ({ fields: FieldEntry[], sourcePath, confidence });
	// convert the stored manifests so mergeManifests can operate on one shape.
	const existing: ManifestMap = {};
	for (const [component, entry] of Object.entries(
		context.manifests?.manifests ?? {},
	)) {
		existing[component] = {
			component,
			fields: Object.entries(entry.fields).map(([name, typeRef]) => ({
				name,
				typeRef,
				confidence: "high",
			})),
			sourceHash: entry.sourceHash,
			sourcePath: "",
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
		{ sourceHash: string; fields: Record<string, string> }
	> = {};
	for (const [component, entry] of Object.entries(merged)) {
		mergedStore[component] = {
			sourceHash: entry.sourceHash,
			fields: Object.fromEntries(
				entry.fields.map((field) => [field.name, field.typeRef]),
			),
		};
	}
	await writeJsonFile(workspaceDir, "manifests.json", {
		version: "1.0",
		manifests: mergedStore,
	});

	return {
		ok: true,
		errors: [],
		warnings: [],
		exitCode: 0,
		output: { updated, preserved, pruned },
	};
}
