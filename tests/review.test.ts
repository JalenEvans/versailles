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
 * Human review flow (PR 3 scope) — pinned against
 * docs/contracts/review.contract.yaml (the contract_gate), docs/specs/review.md,
 * build-spec §11, ADR-0003 (no approval metadata; git is the audit trail;
 * single-object merge commits), ADR-0010 (no in-tool LLM) and the glossary
 * (`contractDeclined`).
 *
 * ══ RED-PHASE NOTE ════════════════════════════════════════════════════════
 * src/cli/handlers/review.ts is currently a routing-only stub that returns
 * REVIEW_NOT_AVAILABLE (exit 1) for every valid arg shape (PR 2 scope), and
 * the CLI boundary in src/cli/index.ts REJECTS all flags for review as USAGE.
 * Every behavior test below therefore FAILS today — the expected Red state.
 * The Power Forward implements the PR 3 review flow to these pins.
 *
 * ── Interface shape (what the PF implements) ───────────────────────────────
 *
 *   versailles review <component>                      → scoped review view of
 *                                                        the staged component
 *   versailles review <component> <operation>          → scoped review view of
 *                                                        the staged operation
 *   versailles review <component> [operation] --approve → approve: single-object
 *                                                        read-modify-write merge
 *                                                        into contracts.json
 *   versailles review <component> [operation] --reject  → reject: write nothing
 *
 * `--approve` / `--reject` are mutually exclusive and validated at the CLI
 * boundary (the established flag pattern: extract-manifests accepts --prune;
 * docs/contracts/versailles.contract.yaml `can` clause). Today the boundary
 * rejects ALL flags for review as USAGE — the PF must extend the review case
 * to accept exactly these two flags and still reject any other flag.
 *
 * ── Staging convention (how staged objects arrive) ─────────────────────────
 *
 * Staging lives OUTSIDE the tool (ADR-0010; docs/domains/review.md
 * "StagedContract ... the staging side lives outside the tool"). An external
 * agent writes ONE contract object per staged file:
 *
 *   .versailles/staged/<component>.json            → ComponentContract shape
 *                                                   ({ invariants, operations })
 *   .versailles/staged/<component>.<operation>.json → ContractOperation shape
 *                                                   ({ id, params,
 *                                                     preconditions,
 *                                                     postconditions, effects,
 *                                                     sourceHash })
 *
 * The review flow consumes these as-is (ADR-0010 "consume as-is, without
 * re-authoring") — the file is never a whole contracts.json copy.
 *
 * ── Output shapes (machine-readable output payload) ────────────────────────
 *
 * review view (no flag):
 *   output = {
 *     component: string,            // "OrderService"
 *     operation: string | null,     // "withdraw" | null
 *     contract: unknown,            // the staged object AS AUTHORED (deep-equal)
 *     exprViews: [                  // parser-sanity presentation (build-spec §11)
 *       { id, clause, expr, ast },  // clause = invariants|preconditions|postconditions
 *       ...
 *     ],
 *   }
 *   Non-blocking validator warnings for the staged object surface in
 *   result.warnings (the established envelope convention — check surfaces
 *   STALE there). ok true, exit 0.
 *
 * approve:
 *   output = { merged: "OrderService" | "OrderService.withdraw",
 *              contract: <the object as merged> }   // no approval metadata
 *   contracts.json updated by read-modify-write of exactly that key. ok true,
 *   exit 0.
 *
 * reject:
 *   output = { declined: "OrderService" | "OrderService.withdraw" }
 *   contracts.json byte-identical to its prior state (glossary:
 *   contractDeclined). ok true, exit 0.
 *
 * ── Error codes ────────────────────────────────────────────────────────────
 *
 * Unknown component/operation, or approve/reject with NO staged object for
 * the target → structured error { code: "NOT_FOUND", ... } in errors, ok
 * false, exit 1 (docs/contracts/versailles.contract.yaml run_review example:
 * `run_review('UnknownComponent')` → `{ code: 'NOT_FOUND', ... }`, exit 1).
 * Never REVIEW_NOT_AVAILABLE, never UNKNOWN_COMMAND, never a throw.
 *
 * approve on a staged object that FAILS parse → structured PARSE_ERROR, ok
 * false, exit 1, contracts.json unchanged (contract approve.requires: "the
 * staged contract object has passed validation (no hard errors)").
 *
 * ── Fixture strategy ───────────────────────────────────────────────────────
 *
 * Same as tests/cli.test.ts: every test writes its own .versailles/ workspace
 * into a fresh per-test mkdtemp subdir, directly (never through the module
 * under test), so fixture failures are distinguishable from CLI failures.
 * Staged objects are written to .versailles/staged/ exactly as the
 * external-agent flow would. Manifests ground the staged exprs so the
 * happy-path fixtures are semantically valid through the real loader.
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

const ORDER_SERVICE = "OrderService";
const CUSTOMER_SERVICE = "CustomerService";

/** Staged component-scope object (component-scope contract) — valid through the real parser+validator. */
const ORDER_SERVICE_STAGED = {
	invariants: [{ id: "OrderService.inv0", expr: "balance >= 0" }],
	operations: {
		withdraw: {
			id: "OrderService.withdraw",
			params: [{ name: "amount", type: "number" }],
			preconditions: [
				{ id: "OrderService.withdraw.pre0", expr: "amount >= 10" },
				{ id: "OrderService.withdraw.pre1", expr: "amount <= 100" },
			],
			postconditions: [
				{
					id: "OrderService.withdraw.post0",
					expr: "old(balance) - amount == balance",
				},
				{
					id: "OrderService.withdraw.post1",
					expr: "old(balance) >= balance",
				},
			],
			effects: [{ field: "balance", kind: "mutate" }],
			sourceHash: "withdraw-hash",
		},
	},
};

/** Staged operation-scope object (operation-scope contract). */
const WITHDRAW_OPERATION = ORDER_SERVICE_STAGED.operations.withdraw;

/** A second merged component — the "rest of the file" that must never leak into a scoped view. */
const CUSTOMER_CONTRACT = {
	invariants: [],
	operations: {
		upgrade: {
			id: "CustomerService.upgrade",
			params: [{ name: "newTier", type: "enum<GOLD,SILVER>" }],
			preconditions: [
				{ id: "CustomerService.upgrade.pre0", expr: "newTier != null" },
			],
			postconditions: [],
			effects: [],
			sourceHash: "upgrade-hash",
		},
	},
};

/** contracts.json with a different component present — the "rest of the file" that must never leak into a scoped view. */
function contractsWithCustomer(): unknown {
	return {
		version: "1.0",
		contracts: {
			[CUSTOMER_SERVICE]: CUSTOMER_CONTRACT,
		},
	};
}

/** Manifests grounding both fixture components so staged exprs resolve (no hard errors). */
function manifestsReview(): unknown {
	return {
		version: "1.0",
		manifests: {
			[ORDER_SERVICE]: {
				sourceHash: "man-os",
				fields: { balance: "number", status: "string" },
			},
			[CUSTOMER_SERVICE]: {
				sourceHash: "man-cs",
				fields: { newTier: "string", tier: "string" },
			},
		},
	};
}

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

/** Writes one staged contract object (external-agent flow convention, ADR-0010). */
async function writeStaged(
	cwd: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	await mkdir(join(cwd, ".versailles", "staged"), { recursive: true });
	await writeJsonFile(join(cwd, ".versailles", "staged", fileName), value);
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
 * Review workspace: CustomerService already merged in contracts.json (the
 * "rest of the file" that scoped views must never leak) plus grounded
 * manifests. Tests overlay staged objects onto this base.
 */
async function seedReviewWorkspace(name: string): Promise<string> {
	const cwd = await freshWorkspace(name);
	await writeWorkspaceFile(cwd, "contracts.json", contractsWithCustomer());
	await writeWorkspaceFile(cwd, "manifests.json", manifestsReview());
	return cwd;
}

async function stageComponent(
	cwd: string,
	component: string,
	value: unknown,
): Promise<void> {
	await writeStaged(cwd, `${component}.json`, value);
}

async function stageOperation(
	cwd: string,
	component: string,
	operation: string,
	value: unknown,
): Promise<void> {
	await writeStaged(cwd, `${component}.${operation}.json`, value);
}

async function readContractsFile(cwd: string): Promise<string> {
	return readFile(join(cwd, ".versailles", "contracts.json"), "utf8");
}

/**
 * Top-level keys whose values differ between two record objects (added,
 * removed, or changed). Semantic comparison (JSON.stringify per value) —
 * this is the "the diff touches only that object" pin for a single-object
 * read-modify-write merge (ADR-0003, review.contract.yaml assert).
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
 * of contracts.json finds none.
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

/** The exact parser-sanity presentation for the staged OrderService (verified against src/core/parser.ts). */
const EXPECTED_EXPR_VIEWS = [
	{
		id: "OrderService.inv0",
		clause: "invariants",
		expr: "balance >= 0",
		ast: {
			type: "compare",
			op: ">=",
			left: { type: "fieldRef", path: ["balance"] },
			right: { type: "literal", value: 0 },
		},
	},
	{
		id: "OrderService.withdraw.pre0",
		clause: "preconditions",
		expr: "amount >= 10",
		ast: {
			type: "compare",
			op: ">=",
			left: { type: "fieldRef", path: ["amount"] },
			right: { type: "literal", value: 10 },
		},
	},
	{
		id: "OrderService.withdraw.pre1",
		clause: "preconditions",
		expr: "amount <= 100",
		ast: {
			type: "compare",
			op: "<=",
			left: { type: "fieldRef", path: ["amount"] },
			right: { type: "literal", value: 100 },
		},
	},
	{
		id: "OrderService.withdraw.post0",
		clause: "postconditions",
		expr: "old(balance) - amount == balance",
		ast: {
			type: "compare",
			op: "==",
			left: {
				type: "arithmetic",
				op: "-",
				left: {
					type: "old",
					ref: { type: "fieldRef", path: ["balance"] },
				},
				right: { type: "fieldRef", path: ["amount"] },
			},
			right: { type: "fieldRef", path: ["balance"] },
		},
	},
	{
		id: "OrderService.withdraw.post1",
		clause: "postconditions",
		expr: "old(balance) >= balance",
		ast: {
			type: "compare",
			op: ">=",
			left: {
				type: "old",
				ref: { type: "fieldRef", path: ["balance"] },
			},
			right: { type: "fieldRef", path: ["balance"] },
		},
	},
];

type ReviewViewOutput = {
	component: string;
	operation: string | null;
	contract: unknown;
	exprViews: {
		id: string;
		clause: "invariants" | "preconditions" | "postconditions";
		expr: string;
		ast: unknown;
	}[];
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
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-review-"));
	({ runCli } = await import("../src/cli/index.js"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── Scoped review view (build-spec §11, review.contract.yaml) ──────────────

describe("runCli review — scoped review view (build-spec §11, review.contract.yaml)", () => {
	it("review <component> returns a scoped view of the staged component — exit 0, never the whole contracts.json", async () => {
		const cwd = await seedReviewWorkspace("rv-scoped-component");
		await stageComponent(cwd, ORDER_SERVICE, ORDER_SERVICE_STAGED);

		const result = await runCli(["review", ORDER_SERVICE], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const output = result.output as ReviewViewOutput;
		expect(output.component).toBe(ORDER_SERVICE);
		expect(output.operation).toBeNull();
		// Consumed as-authored (ADR-0010): the view carries the staged object
		// itself, never a re-authored or full-file copy.
		expect(output.contract).toEqual(ORDER_SERVICE_STAGED);

		// Scoping discipline: the OTHER component merged in contracts.json must
		// never leak into the review view of this component.
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(CUSTOMER_SERVICE);
		expect(serialized).not.toContain("CustomerService.upgrade");
		expect(serialized).not.toContain("newTier != null");
	});

	it("review view presents every raw expr string alongside its parsed AST — the parser-sanity check (build-spec §11)", async () => {
		const cwd = await seedReviewWorkspace("rv-parser-sanity");
		await stageComponent(cwd, ORDER_SERVICE, ORDER_SERVICE_STAGED);

		const result = await runCli(["review", ORDER_SERVICE], { cwd });
		expect(result.ok).toBe(true);

		const output = result.output as ReviewViewOutput;
		const byId = (a: { id: string }, b: { id: string }) =>
			a.id.localeCompare(b.id);
		expect([...output.exprViews].sort(byId)).toEqual(
			[...EXPECTED_EXPR_VIEWS].sort(byId),
		);
	});

	it("review <component> <operation> returns ONLY the operation sub-object — component invariants never leak", async () => {
		const cwd = await seedReviewWorkspace("rv-scoped-operation");
		await stageOperation(cwd, ORDER_SERVICE, "withdraw", WITHDRAW_OPERATION);

		const result = await runCli(["review", ORDER_SERVICE, "withdraw"], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const output = result.output as ReviewViewOutput;
		expect(output.component).toBe(ORDER_SERVICE);
		expect(output.operation).toBe("withdraw");
		expect(output.contract).toEqual(WITHDRAW_OPERATION);

		const serialized = JSON.stringify(result);
		// The operation view shows its own pre/postconditions...
		expect(serialized).toContain("amount >= 10");
		expect(serialized).toContain("old(balance) - amount == balance");
		// ...but never the component's invariants (scoped to the operation).
		expect(serialized).not.toContain("balance >= 0");
	});
});

// ── Unknown component/operation (versailles.contract.yaml run_review) ──────

describe("runCli review — unknown targets are structured NOT_FOUND, exit 1", () => {
	it.each([
		["review", ["review", "Nope"], "unknown component"],
		["review", ["review", ORDER_SERVICE, "noSuchOp"], "unknown operation"],
	])(
		"%s with %s → ok false, NOT_FOUND in errors, exit 1 — never REVIEW_NOT_AVAILABLE, never a throw",
		async (_label, argv) => {
			const cwd = await seedReviewWorkspace("rv-not-found");
			await stageComponent(cwd, ORDER_SERVICE, ORDER_SERVICE_STAGED);

			const result = await runCli(argv, { cwd });

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.errors).toContainEqual(
				expect.objectContaining({ code: "NOT_FOUND" }),
			);
			expect(result.errors).not.toContainEqual(
				expect.objectContaining({ code: "REVIEW_NOT_AVAILABLE" }),
			);
		},
	);
});

// ── Approval: single-object merge, no metadata (ADR-0003) ──────────────────

describe("runCli review --approve — single-object read-modify-write merge (ADR-0003, build-spec §11)", () => {
	it("approves a staged component into contracts.json: exactly one key added, no approval metadata anywhere", async () => {
		const cwd = await seedReviewWorkspace("rv-approve");
		// contracts.json does NOT contain OrderService yet (staged only).
		const before = JSON.parse(await readContractsFile(cwd)) as {
			contracts: Record<string, unknown>;
		};
		await stageComponent(cwd, ORDER_SERVICE, ORDER_SERVICE_STAGED);

		const result = await runCli(["review", ORDER_SERVICE, "--approve"], {
			cwd,
		});

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);

		const output = result.output as { merged?: string; contract?: unknown };
		expect(output.merged).toBe(ORDER_SERVICE);

		// The merge is a read-modify-write of exactly that key (ADR-0003):
		// the staged object lands under its component key...
		const after = JSON.parse(await readContractsFile(cwd)) as {
			contracts: Record<string, unknown>;
		};
		expect(after.contracts[ORDER_SERVICE]).toEqual(ORDER_SERVICE_STAGED);
		// ...and the diff touches ONLY that object — nothing else changed.
		expect(changedTopLevelKeys(before.contracts, after.contracts)).toEqual([
			ORDER_SERVICE,
		]);

		// No approval metadata in the schema (ADR-0003 assert): neither the
		// merged contracts.json nor the output payload carries approvedBy /
		// approvedAt (or equivalents).
		expect(findApprovalMetadataKeys(after)).toEqual([]);
		expect(findApprovalMetadataKeys(output.contract)).toEqual([]);
	});

	it("approves a staged operation into an existing component — the diff touches only the operation key", async () => {
		const cwd = await seedReviewWorkspace("rv-approve-op");
		// OrderService already merged with a different operation; withdraw is
		// staged for review.
		await writeWorkspaceFile(cwd, "contracts.json", {
			version: "1.0",
			contracts: {
				[CUSTOMER_SERVICE]: CUSTOMER_CONTRACT,
				[ORDER_SERVICE]: {
					invariants: [],
					operations: {
						setStatus: {
							id: "OrderService.setStatus",
							params: [{ name: "newStatus", type: "string" }],
							preconditions: [
								{
									id: "OrderService.setStatus.pre0",
									expr: 'newStatus in ["ACTIVE", "FROZEN"]',
								},
							],
							postconditions: [],
							effects: [{ field: "status", kind: "mutate" }],
							sourceHash: "setstatus-hash",
						},
					},
				},
			},
		});
		const before = JSON.parse(await readContractsFile(cwd)) as {
			contracts: Record<string, { operations: Record<string, unknown> }>;
		};
		await stageOperation(cwd, ORDER_SERVICE, "withdraw", WITHDRAW_OPERATION);

		const result = await runCli(
			["review", ORDER_SERVICE, "withdraw", "--approve"],
			{ cwd },
		);

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect((result.output as { merged?: string }).merged).toBe(
			"OrderService.withdraw",
		);

		const after = JSON.parse(await readContractsFile(cwd)) as {
			contracts: Record<string, { operations: Record<string, unknown> }>;
		};
		// The staged operation is merged under its key...
		expect(after.contracts[ORDER_SERVICE].operations.withdraw).toEqual(
			WITHDRAW_OPERATION,
		);
		// ...the pre-existing operation is untouched...
		expect(after.contracts[ORDER_SERVICE].operations.setStatus).toEqual(
			before.contracts[ORDER_SERVICE].operations.setStatus,
		);
		// ...and the operation-level diff touches exactly one key.
		expect(
			changedTopLevelKeys(
				before.contracts[ORDER_SERVICE].operations,
				after.contracts[ORDER_SERVICE].operations,
			),
		).toEqual(["withdraw"]);

		// Still no approval metadata after an operation merge.
		expect(findApprovalMetadataKeys(after)).toEqual([]);
	});

	it("refuses to approve a staged object that fails parse — structured PARSE_ERROR, exit 1, contracts.json unchanged", async () => {
		const cwd = await seedReviewWorkspace("rv-approve-invalid");
		await stageComponent(cwd, ORDER_SERVICE, {
			invariants: [],
			operations: {
				placeOrder: {
					id: "OrderService.placeOrder",
					params: [],
					preconditions: [],
					postconditions: [
						{
							id: "OrderService.placeOrder.post0",
							expr: "total = 100",
						},
					],
					effects: [],
					sourceHash: "abc123",
				},
			},
		});
		const before = await readContractsFile(cwd);

		const result = await runCli(["review", ORDER_SERVICE, "--approve"], {
			cwd,
		});

		// contract approve.requires: "the staged contract object has passed
		// validation (no hard errors)" — a parse-error staged object must never
		// merge.
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "PARSE_ERROR" }),
		);
		expect(await readContractsFile(cwd)).toBe(before);
	});

	it("approve with NO staged object → structured NOT_FOUND, exit 1, contracts.json unchanged", async () => {
		const cwd = await seedReviewWorkspace("rv-approve-missing");
		// No .versailles/staged/OrderService.json exists.
		const before = await readContractsFile(cwd);

		const result = await runCli(["review", ORDER_SERVICE, "--approve"], {
			cwd,
		});

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
		expect(await readContractsFile(cwd)).toBe(before);
	});
});

// ── Rejection: write nothing (glossary: contractDeclined) ──────────────────

describe("runCli review --reject — writes nothing (glossary: contractDeclined)", () => {
	it("reject leaves contracts.json byte-identical — no merge, no audit-trail artifact", async () => {
		const cwd = await seedReviewWorkspace("rv-reject");
		await stageComponent(cwd, ORDER_SERVICE, ORDER_SERVICE_STAGED);
		const before = await readContractsFile(cwd);

		const result = await runCli(["review", ORDER_SERVICE, "--reject"], { cwd });

		// Rejection is a successful completion of the reject operation: the
		// reviewer declined, the tool wrote nothing.
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect((result.output as { declined?: string }).declined).toBe(
			ORDER_SERVICE,
		);

		// contract assert: "after a reject operation, contracts.json content is
		// byte-identical to its prior state."
		expect(await readContractsFile(cwd)).toBe(before);
	});
});

// ── Non-blocking validator warnings in the view (ADR-0004) ─────────────────

describe("runCli review — surfaces non-blocking validator warnings (ADR-0004, build-spec §11)", () => {
	it("a staged object referencing a low-confidence field shows LOW_CONFIDENCE_FIELD in warnings, ok true, exit 0", async () => {
		const cwd = await freshWorkspace("rv-warnings");
		// balance is declared with the ADR-0004 extension form — inferred
		// confidence → LOW_CONFIDENCE_FIELD warning, never a hard error.
		await writeWorkspaceFile(cwd, "manifests.json", {
			version: "1.0",
			manifests: {
				[ORDER_SERVICE]: {
					sourceHash: "man-os",
					fields: {
						balance: { type: "number", confidence: "inferred" },
						status: "string",
					},
				},
			},
		});
		await stageComponent(cwd, ORDER_SERVICE, ORDER_SERVICE_STAGED);

		const result = await runCli(["review", ORDER_SERVICE], { cwd });

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ code: "LOW_CONFIDENCE_FIELD" }),
		);
	});
});

// ── No LLM (ADR-0010) ──────────────────────────────────────────────────────

describe("review — no LLM call sites in the review flow (ADR-0010)", () => {
	it("the review handler and review-context modules contain no LLM client call patterns", async () => {
		const reviewHandler = fileURLToPath(
			new URL("../src/cli/handlers/review.ts", import.meta.url),
		);
		const reviewContextDir = fileURLToPath(
			new URL("../src/review", import.meta.url),
		);
		const files = [reviewHandler];
		try {
			const entries = await readdir(reviewContextDir);
			for (const entry of entries) {
				if (entry.endsWith(".ts")) {
					files.push(join(reviewContextDir, entry));
				}
			}
		} catch {
			// src/review/ absent or empty (currently a .gitkeep) — nothing to scan.
		}

		// Curated LLM-client signals, not the bare word "LLM" (which appears in
		// ADR-0010 comments). If the review flow ever grows an LLM client this
		// guard flags it (review.contract.yaml assert: no LLM call sites).
		const llmClientPattern =
			/openai|anthropic|langchain|@ai-sdk|ollama|cohere|groq|chat\.completions|createChatCompletion|api[_-]?key/i;

		for (const file of files) {
			const content = await readFile(file, "utf8");
			expect(content, file).not.toMatch(llmClientPattern);
		}
	});
});
