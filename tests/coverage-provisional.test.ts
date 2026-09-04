import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { ClauseKind, Node } from "../packages/core/src/core/parser.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../packages/core/src/loader/workspace.js";
import {
	coverageManifest,
	emitSuite,
	planTestCases,
} from "../packages/engine/src/generator/index.js";
import type {
	CoverageManifest,
	EmittedFile,
	PlannedSuite,
} from "../packages/engine/src/generator/index.js";

/**
 * VERSAILLES-186 — greenfield coverage is PROVISIONAL, never verified.
 *
 * Pinned against docs/specs/deterministic-generation.md §20 (coverage
 * semantics) and the VERSAILLES-186 must_not constraint:
 *
 *   "The generator must_not present greenfield coverage as verified — when
 *    manifests/source are absent and the generated tests cannot load,
 *    coverage.json must report the coverage as provisional (tests generated
 *    and traced, not executable), never as verified coverage."
 *
 * ── The bug (current code, RED) ─────────────────────────────────────────
 *
 * On the greenfield path — contracts only, no manifests, no source — the
 * generator still emits `coverage.json` (and `// traces:` comments) that read
 * as VERIFIED coverage. But the generated tests cannot even load until the
 * source exists (the deliberate TDD-Red phase, ADR-0011), so claiming
 * verified coverage is false.
 *
 * Current surface:
 *   - coverageManifest(suite) returns `{ coverage }` with NO status field
 *     (packages/engine/src/generator/planner.ts:414-428).
 *   - coverage.json is written verbatim from that manifest
 *     (packages/cli/src/cli/handlers/generate.ts:109-113) → no status key.
 *   - the vitest emitter header always renders the verified-style
 *     `// traces: "id", ...` line (packages/engine/src/generator/emitters/
 *     vitest.ts:178-180) — even on greenfield.
 *
 * ── Pinned surface (what the implementation must produce) ───────────────
 *
 * CoverageManifest gains a status discriminator:
 *
 *   export type CoverageManifest = {
 *     coverage: Record<string, string[]>;          // unchanged — §9.3 map
 *     status: "verified" | "provisional";          // NEW (VERSAILLES-186)
 *   };
 *
 *   - brownfield (manifests present, module imports resolvable):
 *       { coverage: {...}, status: "verified" }
 *   - greenfield (contracts only, no manifests/source):
 *       { coverage: {...}, status: "provisional" }
 *
 * The generated file header trace comment (vitest.ts:178-180) must mirror the
 * status: brownfield keeps the byte-identical `// traces: "id", ...` verified
 * form; greenfield emits a provisional-marked variant that never reads as the
 * verified form — e.g. `// traces (provisional): "id", ...` — while still
 * listing the traced clause ids.
 *
 * No existing test pins greenfield-as-verified (the bug is untested); the
 * brownfield surface is regression-guarded here so the fix cannot regress it.
 */

const ACCOUNT = "AccountService";

const CLAUSE_IDS = [
	"AccountService.inv0",
	"AccountService.withdraw.pre0",
	"AccountService.withdraw.pre1",
	"AccountService.withdraw.post0",
];

// ── Unit fixtures (in-memory contexts, mirroring tests/generator.test.ts) ──

function contractsFixture(): ContractsFile {
	return {
		contracts: {
			[ACCOUNT]: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "AccountService.withdraw.pre0", expr: "amount >= 10" },
							{ id: "AccountService.withdraw.pre1", expr: "amount <= 100" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	};
}

/** Brownfield manifests store: the component IS tracked (source exists). */
function manifestsFixture(): ManifestsFile {
	return {
		manifests: {
			[ACCOUNT]: {
				sourceHash: "man-account",
				fields: { balance: "number" },
			},
		},
	};
}

function makeConfig(): WorkspaceConfig {
	return {
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: false },
	};
}

/**
 * Parses every fixture expr with the real parser so the context carries real
 * ASTs in parsedContracts (the shape the loader produces, build-spec §6).
 * Throws only on a fixture-authoring error — never a generator behaviour.
 */
function parseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (clauses: ContractClause[], kind: ClauseKind): void => {
		for (const clause of clauses) {
			const result = parseExpression(clause.expr, kind, clause.id);
			if (!result.ok) {
				throw new Error(
					`fixture parse failed for ${clause.id}: ${JSON.stringify(result.errors)}`,
				);
			}
			parsed[clause.id] = result.ast;
		}
	};
	for (const component of Object.values(contracts.contracts)) {
		walk(component.invariants ?? [], "invariants");
		for (const operation of Object.values(component.operations ?? {})) {
			walk(operation.preconditions ?? [], "preconditions");
			walk(operation.postconditions ?? [], "postconditions");
		}
	}
	return parsed;
}

/**
 * Brownfield context: manifests present (the component is tracked, module
 * imports resolvable). Mirrors makeContext() in tests/generator.test.ts.
 */
function makeBrownfieldContext(): VersaillesContext {
	const contracts = contractsFixture();
	return {
		config: makeConfig(),
		contracts,
		manifests: manifestsFixture(),
		predicates: { predicates: {} },
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

/**
 * Greenfield context: contracts ONLY — manifests absent (the loader tolerates
 * missing manifests.json when contracts.json is present, workspace.ts:720-735;
 * context.manifests is null). The generated tests import a source that does
 * not exist yet (TDD-Red, ADR-0011).
 */
function makeGreenfieldContext(): VersaillesContext {
	const contracts = contractsFixture();
	return {
		config: makeConfig(),
		contracts,
		manifests: null,
		predicates: { predicates: {} },
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

/**
 * The NEW coverage-manifest surface (VERSAILLES-186): the §9.3 clause→test map
 * plus a status discriminator. The runtime type today is
 * `{ coverage: Record<string, string[]> }` — `status` is absent until the fix
 * lands, which is exactly what these tests pin (RED now, GREEN after).
 */
type CoverageManifest186 = CoverageManifest & {
	status?: "verified" | "provisional";
};

/** The file-header `// traces` line (the first one — vitest.ts:178-180). */
function headerTraceLine(content: string): string | undefined {
	return content
		.split("\n")
		.find((line) => line.trimStart().startsWith("// traces"));
}

// ── coverageManifest status (planner.ts:414-428) ─────────────────────────

describe("coverageManifest — verified vs provisional (VERSAILLES-186)", () => {
	it("brownfield: reports status 'verified' and keeps the full clause→test map (regression guard)", () => {
		const suite = planTestCases(makeBrownfieldContext());
		const manifest: CoverageManifest186 = coverageManifest(suite);

		// The §9.3 map is unchanged — every clause still traces its tests.
		expect(manifest.coverage).toBeDefined();
		for (const clauseId of CLAUSE_IDS) {
			expect(Array.isArray(manifest.coverage[clauseId])).toBe(true);
		}
		// NEW (VERSAILLES-186): brownfield coverage is VERIFIED — manifests
		// present, module imports resolvable, the generated tests can load.
		expect(manifest.status).toBe("verified");
	});

	it("greenfield: reports status 'provisional' — tests generated and traced, not executable", () => {
		const suite = planTestCases(makeGreenfieldContext());
		const manifest: CoverageManifest186 = coverageManifest(suite);

		// The §9.3 map is still fully populated — greenfield keeps traceability
		// (zero-coverage clauses stay detectable); only the status changes.
		expect(manifest.coverage).toBeDefined();
		for (const clauseId of CLAUSE_IDS) {
			expect(Array.isArray(manifest.coverage[clauseId])).toBe(true);
		}
		// NEW (VERSAILLES-186): greenfield coverage is PROVISIONAL — the
		// generated tests cannot load until the source exists (TDD-Red,
		// ADR-0011), so the manifest must NEVER read as verified coverage.
		expect(manifest.status).toBe("provisional");
		expect(manifest.status).not.toBe("verified");
	});
});

// ── Generated-file `// traces:` comment (emitters/vitest.ts:178-180) ─────

describe("emitSuite vitest header — traces comment verified vs provisional (VERSAILLES-186)", () => {
	it("brownfield: header keeps the verified '// traces:' form (regression guard)", () => {
		const suite = planTestCases(makeBrownfieldContext());
		const files = emitSuite(suite, "vitest");
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const header = headerTraceLine(file.content);
			expect(header, `missing // traces header in ${file.path}`).toBeDefined();
			// Brownfield reports VERIFIED coverage: the byte-identical
			// `// traces: "id", ...` form is preserved.
			expect(header?.startsWith("// traces:")).toBe(true);
		}
	});

	it("greenfield: header must not read as verified; surfaces provisional and still lists clause ids", () => {
		const suite = planTestCases(makeGreenfieldContext());
		const files = emitSuite(suite, "vitest");
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const header = headerTraceLine(file.content);
			expect(header, `missing // traces header in ${file.path}`).toBeDefined();
			// VERSAILLES-186: on greenfield the trace comment must not read as
			// the verified form — the header line is no longer the bare
			// `// traces: "id", ...`.
			expect(
				header?.startsWith("// traces:"),
				`greenfield header must not read as verified coverage: ${header}`,
			).toBe(false);
			// ...and it surfaces the provisional state explicitly, aligned
			// with the coverageManifest `status: "provisional"` field (e.g.
			// `// traces (provisional): "id", ...`).
			expect(
				header,
				`greenfield header must surface provisional coverage: ${header}`,
			).toContain("provisional");
			// Traceability survives: the traced clause ids are still listed.
			for (const clauseId of CLAUSE_IDS) {
				expect(header).toContain(JSON.stringify(clauseId));
			}
		}
	});
});

// ── coverage.json artifact (generate handler, generate.ts:109-113) ────────

// In-process runCli (mirrors tests/cli.test.ts) — no dist/ build needed.
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

beforeAll(async () => {
	({ runCli } = await import("../packages/cli/src/cli/index.js"));
});

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Seeds a contracts-only (greenfield) workspace: config + contracts ONLY. */
async function seedGreenfieldWorkspace(name: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), `versailles-186-gf-${name}-`));
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await writeJsonFile(join(cwd, ".versailles", "config.json"), {
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: true },
	});
	await writeJsonFile(join(cwd, ".versailles", "contracts.json"), {
		contracts: {
			[ACCOUNT]: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "AccountService.withdraw.pre0", expr: "amount >= 10" },
							{ id: "AccountService.withdraw.pre1", expr: "amount <= 100" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	});
	return cwd;
}

/**
 * Seeds a brownfield workspace: config + contracts + manifests (with a
 * resolvable sourcePath) + the real source file under src/ — module imports
 * resolvable, the canonical brownfield/verified setup.
 */
async function seedBrownfieldWorkspace(name: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), `versailles-186-bf-${name}-`));
	await mkdir(join(cwd, ".versailles"), { recursive: true });
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeJsonFile(join(cwd, ".versailles", "config.json"), {
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: true },
	});
	await writeJsonFile(join(cwd, ".versailles", "contracts.json"), {
		contracts: {
			[ACCOUNT]: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "AccountService.withdraw.pre0", expr: "amount >= 10" },
							{ id: "AccountService.withdraw.pre1", expr: "amount <= 100" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	});
	await writeJsonFile(join(cwd, ".versailles", "manifests.json"), {
		manifests: {
			[ACCOUNT]: {
				sourceHash: "man-account",
				fields: { balance: "number" },
				sourcePath: "src/AccountService.ts",
			},
		},
	});
	// The real source — module imports genuinely resolvable (brownfield).
	await writeFile(
		join(cwd, "src", "AccountService.ts"),
		`export class AccountService {\n\tprivate static balance = 0;\n\tstatic withdraw(amount: number): number {\n\t\tif (amount < 10 || amount > 100) {\n\t\t\tthrow new Error("amount out of range");\n\t\t}\n\t\treturn amount;\n\t}\n}\n`,
		"utf8",
	);
	return cwd;
}

/** Parses generated/coverage.json, typed with the VERSAILLES-186 status. */
async function readCoverageJson(
	cwd: string,
): Promise<{ coverage: Record<string, string[]>; status?: string }> {
	const raw = await readFile(
		join(cwd, ".versailles", "generated", "coverage.json"),
		"utf8",
	);
	return JSON.parse(raw) as {
		coverage: Record<string, string[]>;
		status?: string;
	};
}

describe("generate artifact — coverage.json status (VERSAILLES-186)", () => {
	it("greenfield (contracts only): coverage.json reports status 'provisional' — never verified", async () => {
		const cwd = await seedGreenfieldWorkspace("artifact");
		try {
			const result = await runCli(["generate"], { cwd });
			expect(result.ok).toBe(true);
			expect(result.exitCode).toBe(0);

			const coverage = await readCoverageJson(cwd);
			// The §9.3 map is unchanged on greenfield — traceability holds.
			expect(typeof coverage.coverage).toBe("object");
			for (const clauseId of CLAUSE_IDS) {
				expect(coverage.coverage[clauseId]).toBeDefined();
				expect(Array.isArray(coverage.coverage[clauseId])).toBe(true);
			}
			// VERSAILLES-186 must_not constraint: greenfield coverage is
			// provisional (tests generated and traced, not executable —
			// the module import cannot load until the source exists,
			// TDD-Red ADR-0011) — NEVER verified coverage.
			expect(coverage.status).toBe("provisional");
			expect(coverage.status).not.toBe("verified");

			// The emitted file surface mirrors the manifest: the header
			// trace comment does not read as verified coverage either.
			const generatedTest = await readFile(
				join(cwd, ".versailles", "generated", "AccountService.test.ts"),
				"utf8",
			);
			const header = headerTraceLine(generatedTest);
			expect(header).toBeDefined();
			expect(header?.startsWith("// traces:")).toBe(false);
			expect(header).toContain("provisional");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("brownfield (manifests + source present): coverage.json reports status 'verified' and keeps the clause→test map (regression guard)", async () => {
		const cwd = await seedBrownfieldWorkspace("artifact");
		try {
			const result = await runCli(["generate"], { cwd });
			expect(result.ok).toBe(true);
			expect(result.exitCode).toBe(0);

			const coverage = await readCoverageJson(cwd);
			// The §9.3 map is unchanged on brownfield — the regression
			// guard: the existing verified surface keeps its shape.
			expect(typeof coverage.coverage).toBe("object");
			for (const clauseId of CLAUSE_IDS) {
				expect(coverage.coverage[clauseId]).toBeDefined();
				expect(Array.isArray(coverage.coverage[clauseId])).toBe(true);
			}
			// VERSAILLES-186: brownfield coverage is VERIFIED — manifests
			// present, module imports resolvable, tests can load.
			expect(coverage.status).toBe("verified");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
