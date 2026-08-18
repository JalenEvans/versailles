import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	computeSourceHash,
	extractManifests,
	mergeManifests,
} from "../src/extractors/index.js";
import type {
	ExtractorResult,
	ExtractorWarning,
	FieldEntry,
	ManifestEntry,
	ManifestMap,
} from "../src/extractors/index.js";

/**
 * Manifest extractor — pinned against build-spec §3.3 (manifests.json,
 * typeRef grammar), §7 (manifest extractor, structural sourceHash), the
 * manifest-extraction contract (docs/contracts/manifest-extraction.contract.yaml)
 * and ADR-0002 (determinism) / ADR-0004 (permissive typing).
 *
 * The extractor derives the grounding layer of the pipeline — manifests.json —
 * from real TypeScript source via static analysis (ts.createProgram + type
 * checker): declared field types resolve to the typeRef grammar, generics map
 * to list<T>, literal-only unions map to enum<...>, nested/related types are
 * added transitively to the flat map, and per-entry sourceHash values are
 * computed from the SORTED field name+type pairs plus the sorted method
 * signature records (never the full source file, never method bodies), so
 * body-only edits never trigger false staleness.
 *
 * ── Module contract ────────────────────────────────────────────────────────
 *
 * Module: src/extractors/index.ts (compiled to index.js)
 * Exports: extractManifests, computeSourceHash, mergeManifests (+ the types)
 *
 * ```ts
 * export type FieldEntry = { name: string; typeRef: string; confidence: "high" | "low" };
 * export type MethodMetadata = { static: boolean; params: string[]; returnType?: string };
 * export type ManifestEntry = { component: string; fields: FieldEntry[]; methods: Record<string, MethodMetadata>; sourceHash: string; sourcePath: string; confidence: "high" | "low" };
 * export type ManifestMap = Record<string, ManifestEntry>;
 * export type ExtractorWarning = { code: string; component: string; field: string; detail: string };
 * export type ExtractorResult = { manifests: ManifestMap; warnings: ExtractorWarning[] };
 * export declare function extractManifests(sourceRoots: string[], projectRoot?: string): ExtractorResult; // SYNCHRONOUS
 * export declare function computeSourceHash(fields: FieldEntry[], methods?: Record<string, MethodMetadata>): string;
 * export declare function mergeManifests(existing: ManifestMap, extracted: ManifestMap, options: { prune: boolean }): ManifestMap; // pure
 * ```
 *
 * ── Ambiguities resolved by these tests ────────────────────────────────────
 *
 * 1. extractManifests is SYNCHRONOUS and takes source root DIRECTORY paths
 *    (glob expansion is a CLI concern); it scans every *.ts file under each
 *    root recursively (the boundary test pins the recursion and the
 *    never-outside-root guarantee). The optional projectRoot (the CLI's cwd)
 *    anchors sourcePath to the PROJECT root (VERSAILLES-24): a component at
 *    <projectRoot>/src/order.ts records "src/order.ts", never "order.ts" —
 *    so the generator's join(cwd, sourcePath) resolves to the real file.
 * 2. Per-field confidence: "high" for type-checker-declared types, "low" for
 *    types that can only be inferred (e.g. an untyped property initializer
 *    `balance = 0`). Entry-level confidence is "low" when any field is low.
 * 3. Warning code: LOW_CONFIDENCE_FIELD — the same code the loader already
 *    surfaces for low-confidence manifest fields (tests/loader.test.ts), so
 *    the extractor's warning tier feeds the validator's warning tier as-is.
 * 4. A component's entry sourceHash equals computeSourceHash over that
 *    entry's fields plus method signature records (sorted, bodies excluded) —
 *    the extractor delegates to the pure function; describe 3 pins that tie
 *    directly.
 * 5. mergeManifests is pure: it returns a NEW ManifestMap and never mutates
 *    either input (the purity test deep-freezes both inputs).
 * 6. extractManifests must never throw on inferable-only fields — a
 *    low-confidence field produces a warning, never a hard error (ADR-0004).
 *
 * ── Fixture strategy ───────────────────────────────────────────────────────
 *
 * Every test writes its own .ts fixtures into a fresh per-test mkdtemp
 * subdir (recursive mkdir), so no test shares on-disk state with another and
 * the extractor's real file-scanning path is exercised end to end. Fixtures:
 * account.ts (class Account { balance: number; owner: string; tags: string[]
 * }), customer.ts (interface Customer { id: number; status: "ACTIVE" |
 * "FROZEN" }), order.ts (Order { id; items: OrderItem[] } + OrderItem { sku;
 * qty } added transitively), member.ts (optional field nickname?: string),
 * profile.ts (an inferred field via `balance = 0` → low confidence),
 * ledger body-A/body-B variants (same fields, different method bodies → same
 * structural hash) and ledger with a field added (→ different hash), plus an
 * outside-sourceRoots fixture (secret.ts) that must never be scanned.
 */

// ── Fixture sources ────────────────────────────────────────────────────────

const ACCOUNT_SOURCE = `
export class Account {
	balance: number;
	owner: string;
	tags: string[];
}
`;

const CUSTOMER_SOURCE = `
export interface Customer {
	id: number;
	status: "ACTIVE" | "FROZEN";
}
`;

const ORDER_SOURCE = `
export class Order {
	id: number;
	items: OrderItem[];
}

export class OrderItem {
	sku: string;
	qty: number;
}
`;

const MEMBER_SOURCE = `
export class Member {
	name: string;
	nickname?: string;
}
`;

// `balance = 0` has no declared type — only inferable via the initializer
// (number). ADR-0004: it must be flagged low-confidence and warn, never
// block. `name: string` stays high-confidence.
const PROFILE_SOURCE = `
export class Profile {
	name: string;
	balance = 0;
}
`;

// Body-A vs Body-B differ only in the method body; the field set and types
// are identical, so both must hash identically (build-spec §7).
const LEDGER_BODY_A = `
export class Ledger {
	total: number;
	entries: string[];

	getSum(): number {
		return this.total;
	}
}
`;

const LEDGER_BODY_B = `
export class Ledger {
	total: number;
	entries: string[];

	getSum(): number {
		return this.total * 2;
	}
}
`;

// Same class shape plus one extra field: the structural hash MUST differ
// from body-A/body-B (build-spec §7).
const LEDGER_FIELD_ADDED = `
export class Ledger {
	total: number;
	entries: string[];
	audit: string;

	getSum(): number {
		return this.total;
	}
}
`;

const SECRET_SOURCE = `
export class Secret {
	token: string;
}
`;

// ── Fixture helpers ────────────────────────────────────────────────────────

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-extractor-"));
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

/** Creates a fresh per-test subdir under the shared temp root. */
async function fixtureDir(name: string): Promise<string> {
	const dir = join(tempRoot, name);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	return dir;
}

/** Writes a fixture file (creating parent dirs), returning its absolute path. */
async function writeFixture(
	dir: string,
	relativePath: string,
	source: string,
): Promise<string> {
	const filePath = join(dir, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `${source}\n`, "utf8");
	return filePath;
}

/** Finds a field by name inside a manifest entry. */
function fieldOf(entry: ManifestEntry, name: string): FieldEntry | undefined {
	return entry.fields.find((field) => field.name === name);
}

/** Builds a ManifestEntry with the fixed sourcePath derived from the component. */
function manifestEntry(
	component: string,
	fields: FieldEntry[],
	sourceHash: string,
): ManifestEntry {
	return {
		component,
		fields,
		sourceHash,
		sourcePath: `${component.toLowerCase()}.ts`,
		confidence: "high",
	};
}

// ── Describe 1: basic typeRef resolution (build-spec §3.3) ────────────────

describe("extractManifests — basic typeRef resolution (build-spec §3.3)", () => {
	it("maps class fields to primitive typeRefs", async () => {
		const dir = await fixtureDir("t1-primitives");
		await writeFixture(dir, "account.ts", ACCOUNT_SOURCE);

		const result = extractManifests([dir]);

		const account = result.manifests.Account;
		expect(account).toBeDefined();
		expect(fieldOf(account, "balance")).toEqual({
			name: "balance",
			typeRef: "number",
			confidence: "high",
		});
		expect(fieldOf(account, "owner")).toEqual({
			name: "owner",
			typeRef: "string",
			confidence: "high",
		});
	});

	it("maps a TS generic array field to list<T>", async () => {
		const dir = await fixtureDir("t2-generic-array");
		await writeFixture(dir, "account.ts", ACCOUNT_SOURCE);

		const result = extractManifests([dir]);

		expect(fieldOf(result.manifests.Account, "tags")).toEqual({
			name: "tags",
			typeRef: "list<string>",
			confidence: "high",
		});
	});

	it("maps a literal-only union to enum<...>", async () => {
		const dir = await fixtureDir("t3-literal-union");
		await writeFixture(dir, "customer.ts", CUSTOMER_SOURCE);

		const result = extractManifests([dir]);

		const customer = result.manifests.Customer;
		expect(customer).toBeDefined();
		expect(fieldOf(customer, "id")).toEqual({
			name: "id",
			typeRef: "number",
			confidence: "high",
		});
		expect(fieldOf(customer, "status")).toEqual({
			name: "status",
			typeRef: "enum<ACTIVE,FROZEN>",
			confidence: "high",
		});
	});

	it("adds nested/related types transitively to the flat map", async () => {
		const dir = await fixtureDir("t4-transitive");
		await writeFixture(dir, "order.ts", ORDER_SOURCE);

		const result = extractManifests([dir]);

		// Order references OrderItem — the items[].sku path must resolve via a
		// sibling OrderItem entry in the same flat map (build-spec §3.3).
		const order = result.manifests.Order;
		expect(order).toBeDefined();
		expect(fieldOf(order, "id")).toEqual({
			name: "id",
			typeRef: "number",
			confidence: "high",
		});
		expect(fieldOf(order, "items")).toEqual({
			name: "items",
			typeRef: "list<OrderItem>",
			confidence: "high",
		});

		const orderItem = result.manifests.OrderItem;
		expect(orderItem).toBeDefined();
		expect(fieldOf(orderItem, "sku")).toEqual({
			name: "sku",
			typeRef: "string",
			confidence: "high",
		});
		expect(fieldOf(orderItem, "qty")).toEqual({
			name: "qty",
			typeRef: "number",
			confidence: "high",
		});
	});

	it("maps an optional field to optional<T>", async () => {
		const dir = await fixtureDir("t5-optional");
		await writeFixture(dir, "member.ts", MEMBER_SOURCE);

		const result = extractManifests([dir]);

		const member = result.manifests.Member;
		expect(member).toBeDefined();
		expect(fieldOf(member, "name")).toEqual({
			name: "name",
			typeRef: "string",
			confidence: "high",
		});
		expect(fieldOf(member, "nickname")).toEqual({
			name: "nickname",
			typeRef: "optional<string>",
			confidence: "high",
		});
	});
});

// ── Describe 2: computeSourceHash structural hash (build-spec §7) ─────────

const HASH_FIELDS: FieldEntry[] = [
	{ name: "balance", typeRef: "number", confidence: "high" },
	{ name: "owner", typeRef: "string", confidence: "high" },
];

describe("computeSourceHash — structural hash over sorted field name+type pairs (build-spec §7)", () => {
	it("is deterministic for the same field set", () => {
		// Two calls on the same array also guard against input mutation.
		const first = computeSourceHash(HASH_FIELDS);
		const second = computeSourceHash(HASH_FIELDS);

		expect(first).toBe(second);
		expect(first.length).toBeGreaterThan(0);
	});

	it("ignores field order (sorted name+type pairs)", () => {
		const reversed = [...HASH_FIELDS].reverse();

		expect(computeSourceHash(HASH_FIELDS)).toBe(computeSourceHash(reversed));
	});

	it("ignores per-field confidence", () => {
		const relabeled = HASH_FIELDS.map((field) => ({
			...field,
			confidence: "low" as const,
		}));

		expect(computeSourceHash(HASH_FIELDS)).toBe(computeSourceHash(relabeled));
	});

	it("changes when a field is added", () => {
		const extended = [
			...HASH_FIELDS,
			{ name: "tags", typeRef: "list<string>", confidence: "high" },
		];

		expect(computeSourceHash(HASH_FIELDS)).not.toBe(
			computeSourceHash(extended),
		);
	});

	it("changes when a field is removed", () => {
		const reduced = HASH_FIELDS.slice(0, 1);

		expect(computeSourceHash(HASH_FIELDS)).not.toBe(computeSourceHash(reduced));
	});

	it("changes when a field is retyped", () => {
		const retyped = HASH_FIELDS.map((field) =>
			field.name === "balance"
				? { ...field, typeRef: "boolean" as const }
				: field,
		);

		expect(computeSourceHash(HASH_FIELDS)).not.toBe(computeSourceHash(retyped));
	});

	it("is defined and non-empty for the empty field set", () => {
		// An empty component still needs a stable, non-empty hash so the
		// staleness check (§8) can compare against it.
		const emptyHash = computeSourceHash([]);

		expect(typeof emptyHash).toBe("string");
		expect(emptyHash.length).toBeGreaterThan(0);
	});
});

// ── Describe 3: extractor structural sourceHash (build-spec §7) ───────────

describe("extractManifests — structural sourceHash (build-spec §7)", () => {
	it("produces the same sourceHash when only method bodies change", async () => {
		const dirA = await fixtureDir("h1-body-a");
		await writeFixture(dirA, "ledger.ts", LEDGER_BODY_A);
		const dirB = await fixtureDir("h1-body-b");
		await writeFixture(dirB, "ledger.ts", LEDGER_BODY_B);

		const resultA = extractManifests([dirA]);
		const resultB = extractManifests([dirB]);

		expect(resultA.manifests.Ledger).toBeDefined();
		expect(resultB.manifests.Ledger).toBeDefined();
		// The entry hash must equal the pure structural hash of its own field
		// set plus method signature records — the extractor delegates to
		// computeSourceHash.
		expect(resultA.manifests.Ledger.sourceHash).toBe(
			computeSourceHash(
				resultA.manifests.Ledger.fields,
				resultA.manifests.Ledger.methods,
			),
		);
		// Body-only edits never change the structural shape.
		expect(resultB.manifests.Ledger.sourceHash).toBe(
			resultA.manifests.Ledger.sourceHash,
		);
	});

	it("produces a different sourceHash when a field is added", async () => {
		const dirA = await fixtureDir("h2-body-a");
		await writeFixture(dirA, "ledger.ts", LEDGER_BODY_A);
		const dirC = await fixtureDir("h2-field-added");
		await writeFixture(dirC, "ledger.ts", LEDGER_FIELD_ADDED);

		const resultA = extractManifests([dirA]);
		const resultC = extractManifests([dirC]);

		expect(resultC.manifests.Ledger).toBeDefined();
		expect(resultC.manifests.Ledger.sourceHash).not.toBe(
			resultA.manifests.Ledger.sourceHash,
		);
	});
});

// ── Describe 4: permissive typing, inferred fields warn (ADR-0004) ────────

describe("extractManifests — permissive typing, inferred fields warn but never block (ADR-0004)", () => {
	it("flags an inferred field low-confidence, emits a warning, and does not throw", async () => {
		const dir = await fixtureDir("p1-inferred");
		await writeFixture(dir, "profile.ts", PROFILE_SOURCE);

		// The whole point: inference uncertainty must NEVER hard-error.
		let result: ExtractorResult | undefined;
		expect(() => {
			result = extractManifests([dir]);
		}).not.toThrow();
		expect(result).toBeDefined();
		result = result as ExtractorResult;

		const profile = result.manifests.Profile;
		expect(profile).toBeDefined();

		// The declared field stays high-confidence; the inferred one is low.
		expect(fieldOf(profile, "name")).toEqual({
			name: "name",
			typeRef: "string",
			confidence: "high",
		});
		const balance = fieldOf(profile, "balance");
		expect(balance).toBeDefined();
		expect(balance?.typeRef).toBe("number");
		expect(balance?.confidence).toBe("low");
		expect(profile.confidence).toBe("low");

		// A non-blocking warning surfaces the uncertainty (ADR-0004).
		const warning = result.warnings.find(
			(w: ExtractorWarning) =>
				w.code === "LOW_CONFIDENCE_FIELD" &&
				w.component === "Profile" &&
				w.field === "balance",
		);
		expect(warning).toBeDefined();
		expect(warning?.detail.length).toBeGreaterThan(0);
	});
});

// ── Describe 5: mergeManifests merge semantics (build-spec §7) ────────────

const EXISTING_MAP: ManifestMap = {
	Covered: manifestEntry(
		"Covered",
		[{ name: "total", typeRef: "number", confidence: "high" }],
		"old-cover-hash",
	),
	Uncovered: manifestEntry(
		"Uncovered",
		[{ name: "legacy", typeRef: "string", confidence: "high" }],
		"uncovered-hash",
	),
};

const EXTRACTED_MAP: ManifestMap = {
	Covered: manifestEntry(
		"Covered",
		[
			{ name: "total", typeRef: "number", confidence: "high" },
			{ name: "items", typeRef: "list<OrderItem>", confidence: "high" },
		],
		"new-cover-hash",
	),
};

describe("mergeManifests — extract-manifests merge semantics (build-spec §7)", () => {
	it("updates covered entries and preserves uncovered entries when prune is false", () => {
		const merged = mergeManifests(EXISTING_MAP, EXTRACTED_MAP, {
			prune: false,
		});

		// Covered entry reflects the fresh extraction.
		expect(merged.Covered).toEqual(EXTRACTED_MAP.Covered);
		// Uncovered entry is preserved — removal is never implicit.
		expect(merged.Uncovered).toEqual(EXISTING_MAP.Uncovered);
		expect(Object.keys(merged).sort()).toEqual(["Covered", "Uncovered"]);
	});

	it("removes uncovered entries when prune is true", () => {
		const merged = mergeManifests(EXISTING_MAP, EXTRACTED_MAP, {
			prune: true,
		});

		expect(merged.Covered).toEqual(EXTRACTED_MAP.Covered);
		expect(merged.Uncovered).toBeUndefined();
		expect(Object.keys(merged)).toEqual(["Covered"]);
	});

	it("is pure: returns a new map and never mutates either input", () => {
		const existing = JSON.parse(JSON.stringify(EXISTING_MAP)) as ManifestMap;
		const extracted = JSON.parse(JSON.stringify(EXTRACTED_MAP)) as ManifestMap;
		const existingSnapshot = JSON.stringify(existing);
		const extractedSnapshot = JSON.stringify(extracted);
		// Deep-frozen inputs: any mutation attempt throws in strict mode.
		deepFreeze(existing);
		deepFreeze(extracted);

		let merged: ManifestMap | undefined;
		expect(() => {
			merged = mergeManifests(existing, extracted, { prune: true });
		}).not.toThrow();
		expect(merged).toBeDefined();
		merged = merged as ManifestMap;

		// A fresh object, not a reference to either input.
		expect(merged).not.toBe(existing);
		expect(merged).not.toBe(extracted);
		// Both inputs are byte-identical after the call.
		expect(JSON.stringify(existing)).toBe(existingSnapshot);
		expect(JSON.stringify(extracted)).toBe(extractedSnapshot);
	});
});

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
	}
	return value;
}

// ── Describe 6: sourceRoots boundary ──────────────────────────────────────

describe("extractManifests — sourceRoots boundary", () => {
	it("scans only files under the given roots (recursively), never outside them", async () => {
		const dir = await fixtureDir("b1-roots");
		// Deeply nested under the root: must be found (recursive scan).
		await writeFixture(dir, "src/models/account.ts", ACCOUNT_SOURCE);
		// Outside the root: must never be scanned.
		await writeFixture(dir, "outside/secret.ts", SECRET_SOURCE);

		const result = extractManifests([join(dir, "src")]);

		expect(result.manifests.Account).toBeDefined();
		expect(result.manifests.Secret).toBeUndefined();
	});
});

// ── Describe 7: determinism (ADR-0002) ────────────────────────────────────

describe("extractManifests — determinism (ADR-0002)", () => {
	it("returns identical manifests and warnings across two runs", async () => {
		const dir = await fixtureDir("d1-determinism");
		await writeFixture(dir, "account.ts", ACCOUNT_SOURCE);
		await writeFixture(dir, "customer.ts", CUSTOMER_SOURCE);
		await writeFixture(dir, "order.ts", ORDER_SOURCE);
		await writeFixture(dir, "profile.ts", PROFILE_SOURCE);

		const first = extractManifests([dir]);
		const second = extractManifests([dir]);

		expect(second.manifests).toEqual(first.manifests);
		expect(second.warnings).toEqual(first.warnings);
	});
});

/**
 * sourcePath persistence (VERSAILLES-21 F2, VERSAILLES-24,
 * manifest-extraction.contract.yaml): every covered manifest entry carries the
 * sourcePath of the file it was extracted from — never an empty string — so
 * the store write (src/cli/handlers/extract.ts) and the generate handler can
 * propagate real module import paths.
 *
 * VERSAILLES-24 pins the canonical semantic: sourcePath is PROJECT-root-
 * relative with POSIX separators. A component at <projectRoot>/src/order.ts
 * records "src/order.ts" — never "order.ts" (source-root-relative) and never
 * an absolute path — so deriveModulePaths' join(cwd, sourcePath) resolves to
 * the real file. The extractor receives the project root explicitly (the
 * CLI's cwd); today's sourcePathOf computes relative(root, file) against the
 * SOURCE root instead, which is the E2E-gate bug.
 */
describe("extractManifests — sourcePath per covered component (VERSAILLES-21 F2, VERSAILLES-24)", () => {
	it("records a non-empty PROJECT-ROOT-relative sourcePath for every covered component — never source-root-relative", async () => {
		const root = await fixtureDir("sp1-sourcepath");
		// Project root = root; source root = root/src — the directory the
		// config sourceRoots "src/**/*.ts" glob expands to. A file at
		// <root>/src/account.ts must record "src/account.ts" (project-root-
		// relative), NOT "account.ts" (source-root-relative): the old value
		// would make join(cwd, sourcePath) point at <root>/account.ts, which
		// does not exist.
		await writeFixture(root, "src/account.ts", ACCOUNT_SOURCE);
		await writeFixture(root, "src/models/customer.ts", CUSTOMER_SOURCE);

		const result = extractManifests([join(root, "src")], root);

		expect(result.manifests.Account.sourcePath).toBe("src/account.ts");
		expect(result.manifests.Customer.sourcePath).toBe("src/models/customer.ts");
		// Never an empty string for a covered component.
		for (const entry of Object.values(result.manifests)) {
			expect(entry.sourcePath.length).toBeGreaterThan(0);
		}
	});
});

/**
 * Method metadata recording (VERSAILLES-20 F1, manifest-extraction.contract.yaml
 * 2026-08-17, build-spec §7): every resolvable method is recorded with its
 * name, static/instance flag, ordered param names, and return type where
 * determinable — so the generator can render shape-aware calls (instance via
 * `new <Component>().<op>(...)`, static via `<Component>.<op>(...)`, positional
 * params, no return-value assertion on void). The manifest store shape
 * (workspace.ts ManifestsFile entry) already declares the optional `methods`
 * field; the extractor is the recording side of that contract.
 */

// Class with instance + static methods, void + primitive returns, and a
// transitive sibling (OrderItem) that declares NO methods.
const ORDER_METHODS_SOURCE = `
export class Order {
	id: number;
	items: OrderItem[];

	addItem(sku: string): void {
		this.items = [];
	}
	setSubtotal(amount: number): void {
		this.id = amount;
	}
	static staticOp(n: number): number {
		return n * 2;
	}
}

export class OrderItem {
	sku: string;
	qty: number;
}
`;

// Interface method signatures (always instance methods — no static in TS
// interfaces): the extractor must record them with static: false.
const SERVICE_METHODS_SOURCE = `
export interface OrderService {
	addItem(sku: string): void;
	applyDiscount(pct: number): number;
}
`;

describe("extractManifests — method metadata recording (VERSAILLES-20 F1, build-spec §7)", () => {
	it("records instance/static flags, ordered param names, and returnType for every class method", async () => {
		const dir = await fixtureDir("m1-class-methods");
		await writeFixture(dir, "order.ts", ORDER_METHODS_SOURCE);

		const result = extractManifests([dir]);

		const order = result.manifests.Order;
		expect(order).toBeDefined();
		expect(order.methods).toBeDefined();

		// Instance method with a single param and void return.
		expect(order.methods?.addItem).toEqual({
			static: false,
			params: ["sku"],
			returnType: "void",
		});
		// Instance method with a single param and void return.
		expect(order.methods?.setSubtotal).toEqual({
			static: false,
			params: ["amount"],
			returnType: "void",
		});
		// Static method with a primitive return.
		expect(order.methods?.staticOp).toEqual({
			static: true,
			params: ["n"],
			returnType: "number",
		});

		// A component with no methods records an empty methods map — the same
		// always-present shape as `fields`.
		expect(result.manifests.OrderItem.methods).toEqual({});
	});

	it("records interface method signatures as instance methods (static: false)", async () => {
		const dir = await fixtureDir("m2-interface-methods");
		await writeFixture(dir, "service.ts", SERVICE_METHODS_SOURCE);

		const result = extractManifests([dir]);

		const service = result.manifests.OrderService;
		expect(service).toBeDefined();
		expect(service.methods).toEqual({
			addItem: { static: false, params: ["sku"], returnType: "void" },
			applyDiscount: { static: false, params: ["pct"], returnType: "number" },
		});
	});
});

/**
 * sourceHash over method signatures (VERSAILLES-20 F1, build-spec §7, contract
 * operation compute_source_hash): the structural hash now covers the sorted
 * field name+type pairs PLUS the sorted method-signature records (method name,
 * static/instance, ordered params, return type where determinable) — method
 * BODIES are never included. A signature change (params, static flag, name,
 * return type) flips the hash so `versailles check` catches stale method
 * metadata; a body-only edit keeps the hash stable (no false staleness).
 */

// Identical fields; the ONLY difference is the method signature (params).
const CALC_SIG_ONE_PARAM = `
export class Calculator {
	value: number;

	addItem(sku: string): void {
		this.value = 1;
	}
}
`;

const CALC_SIG_TWO_PARAMS = `
export class Calculator {
	value: number;

	addItem(sku: string, qty: number): void {
		this.value = 1;
	}
}
`;

// Identical fields AND identical signature; only the method body differs.
const CALC_BODY_A = `
export class Calculator {
	value: number;

	addItem(sku: string): void {
		this.value = sku.length;
	}
}
`;

const CALC_BODY_B = `
export class Calculator {
	value: number;

	addItem(sku: string): void {
		this.value = 0;
	}
}
`;

// Same fields and params as CALC_SIG_ONE_PARAM but the method is static.
const CALC_SIG_STATIC = `
export class Calculator {
	value: number;

	static addItem(sku: string): void {
		this.value = 1;
	}
}
`;

describe("extractManifests — sourceHash covers method signatures, never bodies (VERSAILLES-20 F1)", () => {
	it("produces a different sourceHash when a method signature changes (param added)", async () => {
		const dirA = await fixtureDir("mh1-one-param");
		await writeFixture(dirA, "calculator.ts", CALC_SIG_ONE_PARAM);
		const dirB = await fixtureDir("mh1-two-params");
		await writeFixture(dirB, "calculator.ts", CALC_SIG_TWO_PARAMS);

		const resultA = extractManifests([dirA]);
		const resultB = extractManifests([dirB]);

		expect(resultA.manifests.Calculator).toBeDefined();
		expect(resultB.manifests.Calculator).toBeDefined();
		// Identical field sets — today (fields-only hash) these are equal; the
		// signature record must make them differ.
		expect(resultB.manifests.Calculator.sourceHash).not.toBe(
			resultA.manifests.Calculator.sourceHash,
		);
	});

	it("produces a different sourceHash when the static/instance flag changes", async () => {
		const dirInstance = await fixtureDir("mh2-instance");
		await writeFixture(dirInstance, "calculator.ts", CALC_SIG_ONE_PARAM);
		const dirStatic = await fixtureDir("mh2-static");
		await writeFixture(dirStatic, "calculator.ts", CALC_SIG_STATIC);

		const resultInstance = extractManifests([dirInstance]);
		const resultStatic = extractManifests([dirStatic]);

		expect(resultStatic.manifests.Calculator.sourceHash).not.toBe(
			resultInstance.manifests.Calculator.sourceHash,
		);
	});

	it("produces the same sourceHash when only a method body changes (bodies excluded)", async () => {
		const dirA = await fixtureDir("mh3-body-a");
		await writeFixture(dirA, "calculator.ts", CALC_BODY_A);
		const dirB = await fixtureDir("mh3-body-b");
		await writeFixture(dirB, "calculator.ts", CALC_BODY_B);

		const resultA = extractManifests([dirA]);
		const resultB = extractManifests([dirB]);

		// Same fields AND same method signature — a body edit must never flip
		// the structural hash (build-spec §7: no false staleness).
		expect(resultB.manifests.Calculator.sourceHash).toBe(
			resultA.manifests.Calculator.sourceHash,
		);
	});
});
