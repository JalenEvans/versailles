/**
 * The machine-readable CLI surface (build-spec §10, §12,
 * docs/contracts/versailles.contract.yaml) — runCli routes argv to exactly
 * one of the subcommands (init | extract-manifests | validate | check |
 * generate), validates arguments at the boundary, and resolves with the
 * structured CliResult envelope. Pure-ish and testable: no process.exit, no
 * stdout writes. Never throws — every failure surface (unknown command,
 * malformed args, load errors, parse/validation errors, staleness, internal
 * failures) is a structured error (ADR-0010).
 *
 * Root-level version flags (VERSAILLES-168 Phase 3, VERSAILLES-171): -v /
 * --version short-circuit BEFORE the command table and resolve ok:true
 * exit:0 with output { version } — the repo-root package.json version, read
 * dynamically. The short-circuit is pure: no workspace load, works from any
 * directory. Subcommands reject the flags as ordinary unexpected arguments
 * (USAGE exit 1) — --verbose stays long-only on validate.
 *
 * ADR-0013 (Phase 3): the predicate CLI trio (register-predicate, verify-purity,
 * remind-unverified) is REMOVED. Predicates are now declarative in contracts.json.
 */
import pkg from "../../../../package.json" with { type: "json" };
import { messageOf } from "./context.js";
import { handleCheck } from "./handlers/check.js";
import { handleExtractManifests } from "./handlers/extract.js";
import { handleGenerate } from "./handlers/generate.js";
import { handleInit } from "./handlers/init.js";
import { handleValidate } from "./handlers/validate.js";
import type { CliResult } from "./types.js";

const COMMANDS = new Set([
	"init",
	"extract-manifests",
	"validate",
	"check",
	"generate",
]);

function usageError(
	code: "USAGE" | "UNKNOWN_COMMAND",
	detail: string,
): CliResult {
	return {
		ok: false,
		errors: [{ code, detail }],
		warnings: [],
		exitCode: 1,
	};
}

/**
 * Runs one CLI command against the workspace at <options.cwd>/.versailles
 * (default: process.cwd()). argv is process.argv minus node and script.
 */
export async function runCli(
	argv: string[],
	options?: { cwd?: string },
): Promise<CliResult> {
	const cwd = options?.cwd ?? process.cwd();
	try {
		return await dispatch(argv, cwd);
	} catch (error) {
		// Last-resort safety net (ADR-0010): never an unstructured throw.
		return {
			ok: false,
			errors: [
				{
					code: "INTERNAL",
					detail: `Unexpected internal error: ${messageOf(error)}`,
				},
			],
			warnings: [],
			exitCode: 1,
		};
	}
}

async function dispatch(argv: string[], cwd: string): Promise<CliResult> {
	const [command, ...rest] = argv;
	if (command === undefined) {
		return usageError(
			"USAGE",
			"Missing command — expected one of: init, extract-manifests, validate, check, generate",
		);
	}
	// Root-level version flags (VERSAILLES-168 Phase 3, VERSAILLES-171):
	// short-circuit BEFORE the command table — pure, no workspace load, works
	// from any directory. The version is the repo-root package.json version.
	if (command === "-v" || command === "--version") {
		return {
			ok: true,
			errors: [],
			warnings: [],
			exitCode: 0,
			output: { version: pkg.version },
		};
	}
	if (!COMMANDS.has(command)) {
		return usageError(
			"UNKNOWN_COMMAND",
			`Unknown command "${command}" — expected one of: init, extract-manifests, validate, check, generate`,
		);
	}

	switch (command) {
		case "init": {
			if (rest.length > 0) {
				return usageError(
					"USAGE",
					`"init" accepts no arguments — unexpected "${rest[0]}"`,
				);
			}
			return handleInit(cwd);
		}
		case "validate": {
			let verbose = false;
			for (const arg of rest) {
				if (arg === "--verbose") {
					verbose = true;
					continue;
				}
				return usageError(
					"USAGE",
					`Unexpected argument "${arg}" for validate — only --verbose is supported`,
				);
			}
			return handleValidate(cwd, verbose);
		}
		case "check": {
			if (rest.length > 0) {
				return usageError(
					"USAGE",
					`"check" accepts no arguments — unexpected "${rest[0]}"`,
				);
			}
			return handleCheck(cwd);
		}
		case "generate": {
			if (rest.length > 0) {
				return usageError(
					"USAGE",
					`"generate" accepts no arguments — unexpected "${rest[0]}"`,
				);
			}
			return handleGenerate(cwd);
		}
		case "extract-manifests": {
			let prune = false;
			for (const arg of rest) {
				if (arg === "--prune") {
					prune = true;
					continue;
				}
				return usageError(
					"USAGE",
					`Unexpected argument "${arg}" for extract-manifests — only --prune is supported`,
				);
			}
			return handleExtractManifests(cwd, prune);
		}
		default: {
			// Unreachable: COMMANDS membership was checked above and every
			// command case returns. TS needs an explicit end path for string.
			return usageError(
				"UNKNOWN_COMMAND",
				`Unknown command "${command}" — expected one of: init, extract-manifests, validate, check, generate`,
			);
		}
	}
}
