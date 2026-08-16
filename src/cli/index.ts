import { messageOf } from "./context.js";
/**
 * The machine-readable CLI surface (build-spec §10, §12,
 * docs/contracts/versailles.contract.yaml) — runCli routes argv to exactly
 * one of the subcommands (init | extract-manifests | validate | check |
 * generate | review <component> [operation] | register-predicate |
 * verify-purity | remind-unverified), validates arguments at the boundary,
 * and resolves with the structured CliResult envelope. Pure-ish and testable:
 * no process.exit, no stdout writes. Never throws — every failure surface
 * (unknown command, malformed args, load errors, parse/validation errors,
 * staleness, internal failures) is a structured error (ADR-0010).
 */
import { handleCheck } from "./handlers/check.js";
import { handleExtractManifests } from "./handlers/extract.js";
import { handleGenerate } from "./handlers/generate.js";
import { handleInit } from "./handlers/init.js";
import {
	handleRegisterPredicate,
	handleRemindUnverified,
	handleVerifyPurity,
} from "./handlers/registerPredicate.js";
import { type ReviewFlag, handleReview } from "./handlers/review.js";
import { handleValidate } from "./handlers/validate.js";
import type { CliResult } from "./types.js";

const COMMANDS = new Set([
	"init",
	"extract-manifests",
	"validate",
	"check",
	"generate",
	"review",
	"register-predicate",
	"verify-purity",
	"remind-unverified",
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
			"Missing command — expected one of: init, extract-manifests, validate, check, generate, review <component> [operation], register-predicate <name> --source <Module.functionName>, verify-purity <name>, remind-unverified",
		);
	}
	if (!COMMANDS.has(command)) {
		return usageError(
			"UNKNOWN_COMMAND",
			`Unknown command "${command}" — expected one of: init, extract-manifests, validate, check, generate, review <component> [operation], register-predicate <name> --source <Module.functionName>, verify-purity <name>, remind-unverified`,
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
			if (rest.length > 0) {
				return usageError(
					"USAGE",
					`"validate" accepts no arguments — unexpected "${rest[0]}"`,
				);
			}
			return handleValidate(cwd);
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
		case "review": {
			let flag: ReviewFlag = null;
			const positionals: string[] = [];
			for (const arg of rest) {
				if (arg === "--approve" || arg === "--reject") {
					if (flag !== null) {
						return usageError(
							"USAGE",
							`"review" flags --approve and --reject are mutually exclusive — pass only one`,
						);
					}
					flag = arg === "--approve" ? "approve" : "reject";
					continue;
				}
				if (arg.startsWith("-")) {
					return usageError(
						"USAGE",
						`Unexpected flag "${arg}" for review — only --approve and --reject are supported`,
					);
				}
				positionals.push(arg);
			}
			if (positionals.length < 1 || positionals.length > 2) {
				return usageError(
					"USAGE",
					`review requires exactly one component and an optional operation — got ${positionals.length} argument(s)`,
				);
			}
			return handleReview(cwd, positionals[0], positionals[1], flag);
		}
		case "register-predicate": {
			const flags = new Set([
				"--source",
				"--params",
				"--paramTypes",
				"--sourceHash",
			]);
			let source: string | undefined;
			let params: string[] = [];
			let paramTypes: string[] = [];
			let sourceHash: string | undefined;
			let verifiedPure = false;
			const positionals: string[] = [];
			let index = 0;
			while (index < rest.length) {
				const arg = rest[index];
				if (arg === "--verifiedPure") {
					verifiedPure = true;
					index += 1;
					continue;
				}
				if (flags.has(arg)) {
					const value = rest[index + 1];
					if (value === undefined || value.startsWith("-")) {
						return usageError(
							"USAGE",
							`"${arg}" requires a value for register-predicate`,
						);
					}
					if (arg === "--source") {
						source = value;
					} else if (arg === "--params") {
						params = value === "" ? [] : value.split(",");
					} else if (arg === "--paramTypes") {
						paramTypes = value === "" ? [] : value.split(",");
					} else {
						sourceHash = value;
					}
					index += 2;
					continue;
				}
				if (arg.startsWith("-")) {
					return usageError(
						"USAGE",
						`Unexpected flag "${arg}" for register-predicate — supported flags: --source <Module.functionName>, --params <csv>, --paramTypes <csv>, --sourceHash <hash>, --verifiedPure`,
					);
				}
				positionals.push(arg);
				index += 1;
			}
			if (positionals.length !== 1) {
				return usageError(
					"USAGE",
					`register-predicate requires exactly one predicate name — got ${positionals.length} argument(s)`,
				);
			}
			if (source === undefined) {
				return usageError(
					"USAGE",
					"register-predicate requires --source <Module.functionName>",
				);
			}
			return handleRegisterPredicate(cwd, {
				name: positionals[0],
				source,
				params,
				paramTypes,
				sourceHash,
				verifiedPure,
			});
		}
		case "verify-purity": {
			const positionals: string[] = [];
			for (const arg of rest) {
				if (arg.startsWith("-")) {
					return usageError(
						"USAGE",
						`Unexpected flag "${arg}" for verify-purity — the command takes only a predicate name`,
					);
				}
				positionals.push(arg);
			}
			if (positionals.length !== 1) {
				return usageError(
					"USAGE",
					`verify-purity requires exactly one predicate name — got ${positionals.length} argument(s)`,
				);
			}
			return handleVerifyPurity(cwd, positionals[0]);
		}
		case "remind-unverified": {
			if (rest.length > 0) {
				return usageError(
					"USAGE",
					`"remind-unverified" accepts no arguments — unexpected "${rest[0]}"`,
				);
			}
			return handleRemindUnverified(cwd);
		}
		default: {
			// Unreachable: COMMANDS membership was checked above and every
			// command case returns. TS needs an explicit end path for string.
			return usageError(
				"UNKNOWN_COMMAND",
				`Unknown command "${command}" — expected one of: init, extract-manifests, validate, check, generate, review <component> [operation], register-predicate <name> --source <Module.functionName>, verify-purity <name>, remind-unverified`,
			);
		}
	}
}
