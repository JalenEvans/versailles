/**
 * Shared helpers for the CLI command handlers: conversion of loader
 * parse/validation errors into the structured CliError surface, glob
 * expansion of config.sourceRoots into extractor directory roots, and
 * deterministic JSON file writes.
 */
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtractorWarning } from "../extractors/types.js";
import type { VersaillesContext } from "../loader/workspace.js";
import type { CliError, CliResult } from "./types.js";

/** Converts loader ParseError/ValidationError entries into CliError entries. */
export function contextErrors(context: VersaillesContext): CliError[] {
	const errors: CliError[] = [];
	for (const error of context.parseErrors) {
		errors.push({
			code: "PARSE_ERROR",
			field: error.field,
			detail: error.message,
		});
	}
	for (const error of context.validationErrors) {
		errors.push({ code: error.code, field: error.field, detail: error.detail });
	}
	return errors;
}

/** Converts non-blocking loader warnings into the CliError warning surface. */
export function contextWarnings(context: VersaillesContext): CliError[] {
	return context.validationWarnings.map((warning) => ({
		code: warning.code,
		field: warning.field,
		detail: warning.detail,
	}));
}

/** Converts non-blocking extractor warnings (ADR-0004) into the CliError surface. */
export function extractorWarnings(warnings: ExtractorWarning[]): CliError[] {
	return warnings.map((warning) => ({
		code: warning.code,
		field: warning.field,
		detail: warning.detail,
	}));
}

/**
 * Zero-source-roots guard (Center W1/W2): when config.sourceRoots resolves to
 * zero actual directories while the stored manifests store is non-empty, a
 * command cannot meaningfully verify or update the grounding layer — the scan
 * covered nothing, so a clean report or a prune would be a false signal (and
 * a prune would silently destroy the store). Returns a structured
 * NO_SOURCE_ROOTS result (exit 1) or null when the scan is usable.
 */
export function sourceRootsGuard(
	roots: string[],
	storedManifests: Record<string, unknown>,
): CliResult | null {
	if (roots.length === 0 && Object.keys(storedManifests).length > 0) {
		return {
			ok: false,
			errors: [
				{
					code: "NO_SOURCE_ROOTS",
					field: "config.sourceRoots",
					detail:
						"config.sourceRoots resolved to zero existing source directories while the manifests store is non-empty — refusing to report a clean check or modify the store (verify the sourceRoots glob patterns)",
				},
			],
			warnings: [],
			exitCode: 1,
			output: { staleIds: [] },
		};
	}
	return null;
}

/**
 * Glob-expands config.sourceRoots patterns (e.g. the seeded
 * "src/**\/*.ts") into the directory roots the extractor scans (the
 * extractor takes directory paths; glob expansion is a CLI concern,
 * ADR-0008). The static prefix before the first glob metacharacter is the
 * directory root — the extractor scans it recursively, covering every file
 * the glob would have matched. Non-existent prefixes are skipped so a stale
 * sourceRoots entry never throws. Sorted for deterministic extraction order.
 */
export function expandSourceRoots(patterns: string[], cwd: string): string[] {
	const roots = new Set<string>();
	for (const pattern of patterns) {
		const prefix = staticPrefix(pattern);
		if (prefix === "") {
			continue;
		}
		const abs = join(cwd, prefix);
		if (existsSync(abs) && statSync(abs).isDirectory()) {
			roots.add(abs);
		}
	}
	return [...roots].sort();
}

function staticPrefix(pattern: string): string {
	const metaIndex = pattern.search(/[*?[\]{}]/);
	if (metaIndex === -1) {
		return pattern;
	}
	return pattern.slice(0, metaIndex).replace(/[\\/]+$/, "");
}

/** Writes deterministic pretty-printed JSON (ADR-0002: stable, no timestamps). */
export async function writeJsonFile(
	dirPath: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	await writeFile(
		join(dirPath, fileName),
		`${JSON.stringify(value, null, 2)}\n`,
		"utf8",
	);
}

/** Extracts a stable message from an unknown thrown value. */
export function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
