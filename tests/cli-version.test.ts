import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Root-level version flags (VERSAILLES-168 Phase 3, VERSAILLES-171):
 * `versailles -v` / `versailles --version` print the tool version and exit 0
 * from ANY directory — even one with no .versailles/ workspace — because the
 * flags short-circuit BEFORE command dispatch. `--verbose` stays long-only on
 * validate; subcommands NEVER accept `-v` / `--version`.
 *
 * These tests FAIL against the current implementation:
 * - `-v` / `--version` route to UNKNOWN_COMMAND (exit 1) today — the flags
 *   are not recognized anywhere.
 *
 * The Power Forward implements the GREEN phase (root-level version handling
 * in src/cli/index.ts dispatch) to turn these red pins green.
 *
 * ── Pinned output shape ───────────────────────────────────────────────────
 *
 * The version flags preserve the CliResult envelope and carry the tool version
 * in the machine-readable `output` payload:
 *
 * ```ts
 * output: { version: string }  // the package version (package.json "version"),
 *                              // e.g. "0.1.0" — the CLI is published as
 *                              // versailles-dbc (repo-root package.json).
 * ```
 *
 * Root-level only: `-v` / `--version` as argv[0] short-circuit before the
 * command table is consulted. When they appear AFTER a subcommand they are
 * ordinary unexpected arguments → USAGE exit 1 (validate accepts only
 * --verbose; check accepts no flags).
 *
 * ── Fixture strategy ──────────────────────────────────────────────────────
 *
 * The "works from ANY directory" pin runs against an EMPTY mkdtemp dir — no
 * .versailles/ workspace at all. If dispatch ran (or the flag were treated as
 * a command), the missing workspace or unknown command would surface a
 * MISSING_FILE / UNKNOWN_COMMAND error. The version assertions read the
 * repo-root package.json "version" so the pin tracks the published package
 * (tests/package.test.ts REPO_ROOT convention).
 */

// ── Module import ──────────────────────────────────────────────────────────

type CliErrorShape = {
	code: string;
	field?: string;
	detail: string;
	ids?: string[];
};
type CliResultShape = {
	ok: boolean;
	errors: CliErrorShape[];
	warnings: CliErrorShape[];
	exitCode: 0 | 1 | 2;
	output?: unknown;
};
type RunCli = (
	argv: string[],
	options?: { cwd?: string },
) => Promise<CliResultShape>;

let runCli!: RunCli;

let emptyDir: string;
let pkgVersion: string;

beforeAll(async () => {
	({ runCli } = await import("../packages/cli/src/cli/index.js"));
	// A directory with NO .versailles/ — the version flags must succeed here
	// without ever loading a workspace (short-circuit before dispatch).
	emptyDir = await mkdtemp(join(tmpdir(), "versailles-version-empty-"));
	// The tool version is the repo-root package version (the CLI is published
	// as versailles-dbc). Read it dynamically so the pin tracks the package.
	const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
	const pkg = JSON.parse(
		await readFile(join(REPO_ROOT, "package.json"), "utf8"),
	) as { version?: string };
	pkgVersion = pkg.version ?? "";
});

afterAll(async () => {
	await rm(emptyDir, { recursive: true, force: true });
});

describe("runCli -v / --version — root-level version flags short-circuit before dispatch (VERSAILLES-168 P3)", () => {
	it.each([["-v"], ["--version"]])(
		"`%s` from a directory with NO .versailles/ → ok true, exit 0, output carries the tool version",
		async (flag) => {
			const result = await runCli([flag], { cwd: emptyDir });

			expect(result.ok).toBe(true);
			expect(result.exitCode).toBe(0);
			expect(result.errors).toEqual([]);
			expect(result.warnings).toEqual([]);
			// Machine-readable version payload (pins the exact current
			// package version "0.1.0" — repo-root package.json).
			expect(result.output).toMatchObject({ version: pkgVersion });
			expect(JSON.stringify(result.output)).toMatch(/0\.1\.0/);
		},
	);

	it("short-circuits BEFORE dispatch: `-v` from an empty cwd never attempts a workspace load — no MISSING_FILE / UNKNOWN_COMMAND", async () => {
		const result = await runCli(["-v"], { cwd: emptyDir });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		// If dispatch ran, the missing .versailles/ would surface MISSING_FILE;
		// if -v were treated as a command, it would surface UNKNOWN_COMMAND.
		expect(
			result.errors.some((error) =>
				/MISSING_FILE|UNKNOWN_COMMAND|USAGE/.test(error.code),
			),
		).toBe(false);
	});

	it("`validate -v` → USAGE error exit 1 — version flags are ROOT-LEVEL only; --verbose stays the only validate flag", async () => {
		const result = await runCli(["validate", "-v"], { cwd: emptyDir });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});

	it("`check -v` → USAGE error exit 1 — check supports no flags", async () => {
		const result = await runCli(["check", "-v"], { cwd: emptyDir });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "USAGE" }),
		);
	});
});
