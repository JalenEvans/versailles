import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Predicate registry tooling (build-spec §13 milestone 8) — pinned against
 * docs/contracts/predicate-registry.contract.yaml (the contract_gate),
 * docs/specs/predicate-registry.md, build-spec §3.4 (predicates.json schema),
 * §4.1 (predicate_call IDENT), ADR-0003 (git audit trail: single-entry
 * read-modify-write, no in-band approval metadata), ADR-0006 (verifiedPure is
 * a human-only manual lint gate — never auto-set by the tool) and ADR-0010
 * (structured results, never an LLM).
 *
 * The milestone-8 registration CLI is implemented (register-predicate /
 * verify-purity / remind-unverified all route through src/cli/index.ts); the
 * tests below pin its fixed behavior so a regression fails here.
 *
 * ── Interface shape (what the PF implements) ───────────────────────────────
 *
 *   versailles register-predicate <name> --source <Module.functionName>
 *       [--params <csv>] [--paramTypes <csv>] [--sourceHash <hash>]
 *       [--verifiedPure]
 *   versailles verify-purity <name>
 *   versailles remind-unverified
 *
 * Flag parsing follows the established CLI-boundary pattern (review's
 * --approve/--reject, extract-manifests' --prune): `--`-prefixed args are
 * flags, everything else is positional; unknown flags and wrong positional
 * counts are structured USAGE errors (exit 1). `--params` / `--paramTypes`
 * are comma-separated lists (default []). `--verifiedPure` is the
 * registration-time manual lint gate: a HUMAN passes it to assert purity at
 * registration (ADR-0006); absent → verifiedPure false. `--sourceHash` is
 * optional; when provided the tool must mechanically verify it equals the
 * computed implementation hash before writing. returnType is ALWAYS the
 * literal "boolean" (contract invariant: returnType: 'boolean', §3.4).
 *
 * ── sourceHash reference computation (the PF must match this exactly) ─────
 *
 *   sourceHash(predicate) = FNV-1a (offset basis 0x811c9dc5, prime
 *   0x01000193, 8 lowercase hex chars — the EXACT algorithm of
 *   src/extractors/hash.ts computeSourceHash, reusing the static-analysis
 *   hash seam per the contract limits, WITHOUT becoming manifest derivation)
 *   over the UTF-8 bytes of the function declaration's source text exactly
 *   as the TypeScript static-analysis seam returns it (node.getText() on the
 *   resolved FunctionDeclaration: from `export`/`function` through the
 *   closing brace — no leading trivia, no trailing newline).
 *
 *   The test's fnv1aHex() helper below mirrors that algorithm byte-for-byte
 *   (verified against computeSourceHash in the SG's hash check) and the
 *   fixtures write the source file with a known exact declaration text, so
 *   the reference hash is computed independently of the PF's implementation.
 *   A body edit changes the declaration text → changes the hash (mechanical
 *   verification is not arbitrary).
 *
 * ── Output shapes (machine-readable output payload) ────────────────────────
 *
 * register-predicate success:
 *   output = { registered: "<name>", entry: { params, paramTypes,
 *             returnType: "boolean", sourceRef, sourceHash, verifiedPure } }
 *   ok true, exit 0. predicates.json gains/updates exactly that key.
 *
 * verify-purity success:
 *   output = { verified: "<name>", entry: <the updated entry> }
 *   ok true, exit 0. verifiedPure flipped true; sourceRef/sourceHash
 *   unchanged; exactly one key changed.
 *
 * remind-unverified:
 *   output = { unverified: [{ name, sourceRef }, ...] }   // sorted by name
 *   ok true, exit 0. predicates.json byte-identical afterwards — the
 *   reminder NEVER writes verifiedPure (ADR-0006).
 *
 * ── Error codes ────────────────────────────────────────────────────────────
 *
 * verify-purity on a non-existent predicate → { code: "NOT_FOUND", ... },
 * ok false, exit 1.
 * register-predicate with a name failing the IDENT rule (build-spec §4.1:
 * /^[A-Za-z_][A-Za-z0-9_]*$/ and not a reserved keyword) →
 * { code: "INVALID_PREDICATE_NAME", ... }, ok false, exit 1, nothing written.
 * register-predicate with a sourceRef that does not resolve to a function
 * under config.sourceRoots → { code: "SOURCE_REF_UNRESOLVED", ... }, ok
 * false, exit 1, nothing written.
 * register-predicate with a --sourceHash that does not match the computed
 * implementation hash → { code: "SOURCE_HASH_MISMATCH", ... }, ok false,
 * exit 1, nothing written.
 * Never UNKNOWN_COMMAND for a valid arg shape, never a throw (ADR-0010).
 *
 * ── Fixture strategy ───────────────────────────────────────────────────────
 *
 * Same as tests/review.test.ts: every test writes its own .versailles/
 * workspace into a fresh per-test mkdtemp subdir, directly (never through
 * the module under test), so fixture failures are distinguishable from CLI
 * failures. Predicate source files live under <cwd>/src/ (covered by the
 * seeded config.sourceRoots glob) exactly as the TS static analysis would
 * scan them.
 */

// The exact SEEDED_CONFIG written by initWorkspace (src/cli/init.ts); kept
// local so fixtures pin the loader's happy path against the seed.
const SEEDED_CONFIG = {
	grammarVersion: "1.0",
	schemaVersion: "1.0",
	sourceRoots: ["src/**/*.ts"],
	language: "typescript",
	testFramework: "vitest",
	generatedDir: ".versailles/generated",
	staleness: { blockOnStale: true },
};

// ── Fixture source (the exact declaration text the sourceHash pins) ────────
// IS_AVAILABLE_FN is byte-for-byte what the TS seam's node.getText() returns
// for the resolved FunctionDeclaration: `export function ...` through the
// closing brace, no leading trivia, no trailing newline. The file on disk is
// `${IS_AVAILABLE_FN}\n`. IS_AVAILABLE_FN_V2 is the same function with a
// different BODY — it MUST hash differently (mechanical verification).
const IS_AVAILABLE_FN = `export function isAvailable(amount: number): boolean {
	return amount >= 0;
}`;
const IS_AVAILABLE_FN_V2 = `export function isAvailable(amount: number): boolean {
	return amount >= 0 && amount <= 100;
}`;

const IS_IN_STOCK_FN = `export function isInStock(sku: string): boolean {
	return sku.length > 0;
}`;
const IS_SHIPPED_FN = `export function isShipped(orderId: number): boolean {
	return orderId > 0;
}`;

function inventorySource(): string {
	return `${IS_AVAILABLE_FN}\n${IS_IN_STOCK_FN}\n${IS_SHIPPED_FN}\n`;
}

// ── Reference FNV-1a (byte-compatible with src/extractors/hash.ts) ─────────
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The pinned sourceHash reference computation: FNV-1a over the UTF-8 bytes
 * of the function declaration text, 8 lowercase hex chars — the same
 * algorithm as computeSourceHash in src/extractors/hash.ts (verified by the
 * SG: computeSourceHash(fields) === fnv1aHex(serialized pairs) for the same
 * input). The PF must produce this exact value for the fixture declaration
 * texts above.
 */
function fnv1aHex(input: string): string {
	let hash = FNV_OFFSET_BASIS >>> 0;
	for (const byte of Buffer.from(input, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

// ── Workspace fixtures (mirrors tests/review.test.ts) ──────────────────────

function emptyPredicates(): unknown {
	return { version: "1.0", predicates: {} };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeWorkspaceFile(
	cwd: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	await writeJsonFile(join(cwd, ".versailles", fileName), value);
}

async function writeSource(
	cwd: string,
	fileName: string,
	content: string,
): Promise<void> {
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "src", fileName), content, "utf8");
}

/** Scaffolds a fresh workspace (empty stores) into its own temp subdir. */
async function freshWorkspace(
	name: string,
	configOverrides: Record<string, unknown> = {},
): Promise<string> {
	const cwd = join(tempRoot, name);
	await rm(cwd, { recursive: true, force: true });
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeWorkspaceFile(cwd, "config.json", {
		...SEEDED_CONFIG,
		...configOverrides,
	});
	await writeWorkspaceFile(cwd, "contracts.json", {
		version: "1.0",
		contracts: {},
	});
	await writeWorkspaceFile(cwd, "manifests.json", {
		version: "1.0",
		manifests: {},
	});
	await writeWorkspaceFile(cwd, "predicates.json", emptyPredicates());
	return cwd;
}

/**
 * Predicate-registry workspace: real source under <cwd>/src/ (covered by
 * config.sourceRoots) with three exported predicate functions, plus empty
 * stores. Tests overlay predicates.json fixtures onto this base.
 */
async function seedPredicateWorkspace(name: string): Promise<string> {
	const cwd = await freshWorkspace(name);
	await writeSource(cwd, "Inventory.ts", inventorySource());
	return cwd;
}

async function readPredicatesFile(cwd: string): Promise<string> {
	return readFile(join(cwd, ".versailles", "predicates.json"), "utf8");
}

/**
 * Top-level keys whose values differ between two record objects (added,
 * removed, or changed). Semantic comparison (JSON.stringify per value) —
 * this is the "the diff touches only that predicate entry" pin for a
 * single-entry read-modify-write (ADR-0003, predicate-registry.contract.yaml
 * assert: "register_predicate changes exactly one key of predicates.json").
 */
function changedTopLevelKeys(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	const changed: string[] = [];
	for (const key of keys) {
		const inBefore = Object.prototype.hasOwnProperty.call(before, key);
		const inAfter = Object.prototype.hasOwnProperty.call(after, key);
		const same =
			inBefore === inAfter &&
			JSON.stringify(before[key]) === JSON.stringify(after[key]);
		if (!same) {
			changed.push(key);
		}
	}
	return changed.sort();
}

/**
 * Recursively collects any schema key carrying approval metadata
 * (approvedBy / approvedAt or equivalents) — ADR-0003 assert: a schema lint
 * of predicates.json finds none (git is the audit trail, not in-band fields).
 */
function findApprovalMetadataKeys(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) =>
			findApprovalMetadataKeys(item, `${path}[${index}]`),
		);
	}
	if (value !== null && typeof value === "object") {
		const found: string[] = [];
		for (const [key, child] of Object.entries(value)) {
			if (/approvedBy|approvedAt/i.test(key)) {
				found.push(`${path}.${key}`);
			}
			found.push(...findApprovalMetadataKeys(child, `${path}.${key}`));
		}
		return found;
	}
	return [];
}

/** The schema-conformant §3.4 entry the fixtures use for a registered predicate. */
type PredicateEntry = {
	params: string[];
	paramTypes: string[];
	returnType: string;
	sourceRef: string;
	sourceHash: string;
	verifiedPure: boolean;
};

// ── Red-phase import ───────────────────────────────────────────────────────
// Same shape contract as tests/cli.test.ts: the machine-readable CliResult
// envelope from src/cli/index.ts.
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
let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-predicate-"));
	({ runCli } = await import("../src/cli/index.js"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── register-predicate: single-entry read-modify-write (ADR-0003) ──────────

describe("runCli register-predicate — single-entry read-modify-write (predicate-registry.contract.yaml, ADR-0003)", () => {
	it("adds exactly the named predicate entry — other entries semantically identical, no approval metadata, exit 0, structured output", async () => {
		const cwd = await seedPredicateWorkspace("pr-register-single");
		// A pre-existing entry that must survive semantically identical (the
		// "rest of the file" a single-entry write must never touch).
		await writeWorkspaceFile(cwd, "predicates.json", {
			version: "1.0",
			predicates: {
				isInStock: {
					params: ["sku"],
					paramTypes: ["string"],
					returnType: "boolean",
					sourceRef: "Inventory.isInStock",
					sourceHash: "abc12345",
					verifiedPure: true,
				},
			},
		});
		const before = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, unknown>;
		};

		const result = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
				"--params",
				"amount",
				"--paramTypes",
				"number",
			],
			{ cwd },
		);

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const after = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		// Contract assert: the diff touches ONLY the named predicate entry.
		expect(changedTopLevelKeys(before.predicates, after.predicates)).toEqual([
			"isAvailable",
		]);
		// The pre-existing entry is semantically identical — not a full-file
		// rewrite (ADR-0003).
		expect(after.predicates.isInStock).toEqual(before.predicates.isInStock);

		// The new entry conforms to the §3.4 schema exactly.
		expect(after.predicates.isAvailable).toEqual({
			params: ["amount"],
			paramTypes: ["number"],
			returnType: "boolean",
			sourceRef: "Inventory.isAvailable",
			sourceHash: fnv1aHex(IS_AVAILABLE_FN),
			verifiedPure: false,
		});

		// Structured machine-readable output (never a bare string / throw).
		const output = result.output as {
			registered?: string;
			entry?: PredicateEntry;
		};
		expect(output.registered).toBe("isAvailable");
		expect(output.entry).toEqual(after.predicates.isAvailable);

		// No in-band approval metadata anywhere (ADR-0003: git is the trail).
		expect(findApprovalMetadataKeys(after)).toEqual([]);
		expect(findApprovalMetadataKeys(output.entry)).toEqual([]);
	});
});

// ── sourceHash mechanical verification against source ──────────────────────

describe("runCli register-predicate — sourceRef + sourceHash mechanically verified against source (contract requires, §3.4)", () => {
	it("records sourceRef (Module.functionName) and a sourceHash that verifiably derives from the function implementation", async () => {
		const cwd = await seedPredicateWorkspace("pr-hash-derives");

		const result = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
			],
			{ cwd },
		);

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);

		const after = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		expect(after.predicates.isAvailable.sourceRef).toBe(
			"Inventory.isAvailable",
		);
		// The stored hash equals the reference computation over the exact
		// declaration text — it is NOT arbitrary and NOT the whole file.
		expect(after.predicates.isAvailable.sourceHash).toBe(
			fnv1aHex(IS_AVAILABLE_FN),
		);
	});

	it("sourceHash changes when the function body changes — re-registration (update) records the new implementation hash", async () => {
		const cwd = await seedPredicateWorkspace("pr-hash-body-change");
		// Register against the V1 body.
		const first = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
			],
			{ cwd },
		);
		expect(first.ok).toBe(true);
		const afterFirst = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		expect(afterFirst.predicates.isAvailable.sourceHash).toBe(
			fnv1aHex(IS_AVAILABLE_FN),
		);

		// Mutate the function BODY in place, then register again (update).
		await writeSource(cwd, "Inventory.ts", `${IS_AVAILABLE_FN_V2}\n`);
		const second = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
			],
			{ cwd },
		);
		expect(second.ok).toBe(true);

		const afterSecond = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		// The stored hash now matches the V2 body and differs from the V1
		// body — the hash verifiably tracks the implementation.
		expect(afterSecond.predicates.isAvailable.sourceHash).toBe(
			fnv1aHex(IS_AVAILABLE_FN_V2),
		);
		expect(afterSecond.predicates.isAvailable.sourceHash).not.toBe(
			fnv1aHex(IS_AVAILABLE_FN),
		);
	});
});

// ── verifiedPure defaults false (ADR-0006) ─────────────────────────────────

describe("runCli register-predicate — verifiedPure is a human-only gate, never auto-true (ADR-0006, build-spec §14 default)", () => {
	it("a plain registration (no purity flag) records verifiedPure false — no code path auto-sets it", async () => {
		const cwd = await seedPredicateWorkspace("pr-default-false");

		const result = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
			],
			{ cwd },
		);

		expect(result.ok).toBe(true);
		const after = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		expect(after.predicates.isAvailable.verifiedPure).toBe(false);
	});

	it("only the registration-time manual lint flag (--verifiedPure) records true — a human asserted purity at registration", async () => {
		const cwd = await seedPredicateWorkspace("pr-gate-true");

		const result = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
				"--verifiedPure",
			],
			{ cwd },
		);

		expect(result.ok).toBe(true);
		const after = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		expect(after.predicates.isAvailable.verifiedPure).toBe(true);
	});
});

// ── verify-purity: the post-lint flip (ADR-0006, ADR-0003) ─────────────────

describe("runCli verify-purity — flips verifiedPure true for an existing entry after manual lint (ADR-0006)", () => {
	it("flips verifiedPure to true — sourceRef and sourceHash unchanged, single-key write, exit 0", async () => {
		const cwd = await seedPredicateWorkspace("pr-verify");
		// isAvailable is unverified (pending human lint); isInStock already
		// verified — the "rest of the file" that must survive.
		await writeWorkspaceFile(cwd, "predicates.json", {
			version: "1.0",
			predicates: {
				isAvailable: {
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Inventory.isAvailable",
					sourceHash: "deadbeef",
					verifiedPure: false,
				},
				isInStock: {
					params: ["sku"],
					paramTypes: ["string"],
					returnType: "boolean",
					sourceRef: "Inventory.isInStock",
					sourceHash: "cafebabe",
					verifiedPure: true,
				},
			},
		});
		const before = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};

		const result = await runCli(["verify-purity", "isAvailable"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const after = JSON.parse(await readPredicatesFile(cwd)) as {
			predicates: Record<string, PredicateEntry>;
		};
		// The flip is a single-entry read-modify-write (ADR-0003).
		expect(changedTopLevelKeys(before.predicates, after.predicates)).toEqual([
			"isAvailable",
		]);
		expect(after.predicates.isAvailable.verifiedPure).toBe(true);
		// The verification records a HUMAN decision — it never recomputes or
		// rewrites sourceRef / sourceHash (verify_purity.ensures).
		expect(after.predicates.isAvailable.sourceRef).toBe(
			before.predicates.isAvailable.sourceRef,
		);
		expect(after.predicates.isAvailable.sourceHash).toBe(
			before.predicates.isAvailable.sourceHash,
		);
		// The already-verified entry is untouched.
		expect(after.predicates.isInStock).toEqual(before.predicates.isInStock);

		const output = result.output as {
			verified?: string;
			entry?: PredicateEntry;
		};
		expect(output.verified).toBe("isAvailable");
		expect(output.entry?.verifiedPure).toBe(true);
	});

	it("verifying a NON-existent predicate → structured NOT_FOUND, exit 1, predicates.json unchanged", async () => {
		const cwd = await seedPredicateWorkspace("pr-verify-notfound");
		await writeWorkspaceFile(cwd, "predicates.json", {
			version: "1.0",
			predicates: {
				isAvailable: {
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Inventory.isAvailable",
					sourceHash: "deadbeef",
					verifiedPure: false,
				},
			},
		});
		const before = await readPredicatesFile(cwd);

		const result = await runCli(["verify-purity", "doesNotExist"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
		expect(await readPredicatesFile(cwd)).toBe(before);
	});
});

// ── Center W4: verify-purity TOCTOU degenerate write (Red-phase regression pin) ─
// Current: handleVerifyPurity (src/cli/handlers/registerPredicate.ts) checks
// the entry exists ONCE (via loadWorkspace), then re-reads the file and
// writes `{ ...current, verifiedPure: true }`. If the re-read entry is
// missing or not a conforming record, `{ ...undefined, verifiedPure: true }`
// writes a DEGENERATE `{ verifiedPure: true }` entry — sourceRef/sourceHash
// dropped. The true TOCTOU race (entry deleted between the two reads) is not
// reproducible in-process; the reproducible proxy is a PRESENT but
// non-conforming entry (a record missing the §3.4 required sourceRef /
// sourceHash fields), which exercises the exact same unsafe write path.
// FIXED: verify-purity re-checks the entry shape before writing — a missing
// or non-conforming entry is a structured error, exit 1, predicates.json
// byte-identical (no degenerate write).

describe("runCli verify-purity — re-checks the entry shape before writing (Center W4)", () => {
	it("an entry that is present but not a conforming §3.4 record (sourceRef/sourceHash missing) → structured error, exit 1, predicates.json unchanged — never a degenerate write", async () => {
		const cwd = await seedPredicateWorkspace("pr-verify-malformed");
		await writeWorkspaceFile(cwd, "predicates.json", {
			version: "1.0",
			predicates: {
				// Present at the first check, but not a conforming entry — the
				// degenerate `{ verifiedPure: true }` write must NOT happen.
				bogus: { verifiedPure: false },
			},
		});
		const before = await readPredicatesFile(cwd);

		const result = await runCli(["verify-purity", "bogus"], { cwd });

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(
			result.errors.some((error) => /NOT_FOUND|INVALID|ENTRY/.test(error.code)),
		).toBe(true);
		// No write at all: the malformed entry is untouched and no degenerate
		// `{ verifiedPure: true }` entry appears in the file.
		expect(await readPredicatesFile(cwd)).toBe(before);
	});
});

// ── remind-unverified: the purity-check reminder (build-spec §13 ms 8) ─────

describe("runCli remind-unverified — surfaces only unverified predicates, never writes (predicate-registry.contract.yaml)", () => {
	it("returns exactly the entries with verifiedPure missing or false (with sourceRef), sorted by name — never the verified one, predicates.json byte-identical", async () => {
		const cwd = await seedPredicateWorkspace("pr-remind");
		// isAvailable: verified (true) — must NOT be reported.
		// isInStock: verifiedPure false — MUST be reported.
		// isShipped: verifiedPure MISSING — MUST be reported (the validator
		// treats missing the same as false).
		await writeWorkspaceFile(cwd, "predicates.json", {
			version: "1.0",
			predicates: {
				isAvailable: {
					params: ["amount"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Inventory.isAvailable",
					sourceHash: "deadbeef",
					verifiedPure: true,
				},
				isInStock: {
					params: ["sku"],
					paramTypes: ["string"],
					returnType: "boolean",
					sourceRef: "Inventory.isInStock",
					sourceHash: "cafebabe",
					verifiedPure: false,
				},
				isShipped: {
					params: ["orderId"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Inventory.isShipped",
					sourceHash: "1234abcd",
					// verifiedPure intentionally absent.
				},
			},
		});
		const before = await readPredicatesFile(cwd);

		const result = await runCli(["remind-unverified"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		// Exactly the two unverified entries, each with its sourceRef, sorted
		// by name (ADR-0002 determinism); isAvailable (verified) is absent.
		const output = result.output as {
			unverified?: { name: string; sourceRef: string }[];
		};
		expect(output.unverified).toEqual([
			{ name: "isInStock", sourceRef: "Inventory.isInStock" },
			{ name: "isShipped", sourceRef: "Inventory.isShipped" },
		]);
		expect(JSON.stringify(output.unverified)).not.toContain("isAvailable");

		// The reminder only REPORTS — it never writes verifiedPure (ADR-0006,
		// remind_unverified.ensures) and never touches the file.
		expect(await readPredicatesFile(cwd)).toBe(before);
	});

	it("no unverified predicates → empty list, exit 0", async () => {
		const cwd = await seedPredicateWorkspace("pr-remind-none");
		await writeWorkspaceFile(cwd, "predicates.json", {
			version: "1.0",
			predicates: {
				isAvailable: {
					params: [],
					paramTypes: [],
					returnType: "boolean",
					sourceRef: "Inventory.isAvailable",
					sourceHash: "deadbeef",
					verifiedPure: true,
				},
			},
		});
		const before = await readPredicatesFile(cwd);

		const result = await runCli(["remind-unverified"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect((result.output as { unverified?: unknown[] }).unverified).toEqual(
			[],
		);
		expect(await readPredicatesFile(cwd)).toBe(before);
	});
});

// ── Registration failure modes: nothing invented (ADR-0005 discipline) ─────

describe("runCli register-predicate — unresolvable sourceRef / mismatched hash → structured error, exit 1, nothing written", () => {
	it("a sourceRef that does not resolve to a function under config.sourceRoots → SOURCE_REF_UNRESOLVED, predicates.json unchanged", async () => {
		const cwd = await seedPredicateWorkspace("pr-unresolved");
		const before = await readPredicatesFile(cwd);

		// Inventory.isAvailable exists, but the function name does not.
		const result = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.doesNotExist",
			],
			{ cwd },
		);

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "SOURCE_REF_UNRESOLVED" }),
		);
		expect(await readPredicatesFile(cwd)).toBe(before);
	});

	it("a sourceHash that does not match the actual function implementation → SOURCE_HASH_MISMATCH, predicates.json unchanged", async () => {
		const cwd = await seedPredicateWorkspace("pr-hash-mismatch");
		const before = await readPredicatesFile(cwd);

		// The caller pre-commits a hash that is NOT the implementation hash
		// (fnv1aHex(IS_AVAILABLE_FN)) — mechanical verification must refuse.
		const result = await runCli(
			[
				"register-predicate",
				"isAvailable",
				"--source",
				"Inventory.isAvailable",
				"--sourceHash",
				"deadbeef",
			],
			{ cwd },
		);

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "SOURCE_HASH_MISMATCH" }),
		);
		expect(await readPredicatesFile(cwd)).toBe(before);
	});
});

// ── Invalid predicate name (build-spec §4.1 IDENT) ─────────────────────────

describe("runCli register-predicate — invalid predicate names are structured errors (build-spec §4.1 IDENT)", () => {
	it.each([
		["is-available", "hyphen is not an IDENT character"],
		["9lives", "leading digit is not an IDENT start"],
		["and", "reserved keyword cannot be a predicate_call IDENT"],
	])(
		"rejects name %s (%s) → INVALID_PREDICATE_NAME, exit 1, nothing written",
		async (name) => {
			const cwd = await seedPredicateWorkspace("pr-invalid-name");
			const before = await readPredicatesFile(cwd);

			const result = await runCli(
				["register-predicate", name, "--source", "Inventory.isAvailable"],
				{ cwd },
			);

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.errors).toContainEqual(
				expect.objectContaining({ code: "INVALID_PREDICATE_NAME" }),
			);
			expect(await readPredicatesFile(cwd)).toBe(before);
		},
	);
});

// ── No LLM (ADR-0010) ──────────────────────────────────────────────────────

describe("predicate-registry tooling — no LLM call sites (ADR-0010)", () => {
	it("src/predicates/ and the registration CLI handler contain no LLM client call patterns", async () => {
		// Curated LLM-client signals, not the bare word "LLM" (which appears
		// in ADR-0010 comments). Same guard as the review flow's test.
		const llmClientPattern =
			/openai|anthropic|langchain|@ai-sdk|ollama|cohere|groq|chat\.completions|createChatCompletion|api[_-]?key/i;

		// The registry core lives under src/predicates/ (mirroring how the
		// review flow's core lives under src/review/). Absent → nothing to
		// scan (same convention as review.test.ts).
		const predicatesDir = fileURLToPath(
			new URL("../src/predicates", import.meta.url),
		);
		try {
			const entries = await readdir(predicatesDir);
			for (const entry of entries) {
				if (entry.endsWith(".ts")) {
					const content = await readFile(join(predicatesDir, entry), "utf8");
					expect(content, `src/predicates/${entry}`).not.toMatch(
						llmClientPattern,
					);
				}
			}
		} catch {
			// src/predicates/ absent — nothing to scan.
		}

		// The registration CLI handler lives under src/cli/handlers/ with a
		// name matching the register-predicate command (the handlers/
		// convention: review.ts → review, extract.ts → extract-manifests, ...).
		// The scan asserts it exists and carries no LLM client code.
		const handlersDir = fileURLToPath(
			new URL("../src/cli/handlers", import.meta.url),
		);
		const handlerEntries = (await readdir(handlersDir)).filter(
			(entry) => entry.endsWith(".ts") && /predicate|register/i.test(entry),
		);
		expect(
			handlerEntries.length,
			"a registration CLI handler matching /predicate|register/i must exist under src/cli/handlers/",
		).toBeGreaterThan(0);
		for (const entry of handlerEntries) {
			const content = await readFile(join(handlersDir, entry), "utf8");
			expect(content, entry).not.toMatch(llmClientPattern);
		}
	});
});
