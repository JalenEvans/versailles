import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { computeSourceHash } from "../src/extractors/index.js";
import type { FieldEntry } from "../src/extractors/index.js";

/**
 * Extractor property tests — pin the structural-hash contract of
 * computeSourceHash (build-spec §7, contract operation compute_source_hash)
 * under generated inputs, complementing the fixed battery in
 * tests/extractor.test.ts.
 *
 * computeSourceHash is the pure heart of the extractor: a digest of the
 * SORTED (fieldName, typeRef) pairs only — never the full source file, never
 * per-field confidence. The deterministic battery pins hand-picked cases;
 * these properties extend the pin to generated families of field sets:
 *
 * 1. Never throws on arbitrary generated field sets — including the empty
 *    set and sets with duplicate names (both legal inputs; the empty set must
 *    still yield a defined hash so empty components are comparable).
 * 2. Deterministic across repeated calls (two calls on the same array also
 *    guard against input mutation).
 * 3. Independent of field order — the hash is over sorted pairs, so any
 *    permutation of the input array hashes identically.
 * 4. Independent of per-field confidence — confidence is metadata for the
 *    warning tier (ADR-0004), never part of the structural shape.
 * 5. Changes when a single field's typeRef changes — adding/removing/retyping
 *    is exactly the staleness signal the §8 check detects.
 *
 * Every property uses the standard fast-check-in-vitest pattern:
 * `fc.assert(fc.property(arb, fn), { numRuns })`. numRuns is set to 100
 * (generous for CI, still fast — the whole file runs in well under 5s).
 */

const typeRefArb = fc.constantFrom(
	"string",
	"number",
	"boolean",
	"list<string>",
	"list<OrderItem>",
	"optional<number>",
	"enum<ACTIVE,FROZEN>",
	"OrderItem",
);

const fieldArb: fc.Arbitrary<FieldEntry> = fc.record({
	name: fc.constantFrom(
		"balance",
		"owner",
		"tags",
		"id",
		"status",
		"sku",
		"qty",
		"nickname",
		"total",
		"entries",
	),
	typeRef: typeRefArb,
	confidence: fc.constantFrom("high", "low"),
});

// minLength 0 by default: the empty field set is a first-class input.
const fieldSetArb: fc.Arbitrary<FieldEntry[]> = fc.array(fieldArb, {
	maxLength: 50,
});

const nonEmptyFieldSetArb: fc.Arbitrary<FieldEntry[]> = fc.array(fieldArb, {
	minLength: 1,
	maxLength: 50,
});

describe("computeSourceHash — never throws on arbitrary generated field sets (ADR-0010)", () => {
	it("returns a string for any generated field set, including empty and duplicate names", () => {
		fc.assert(
			fc.property(fieldSetArb, (fields) => {
				let hash: string | undefined;
				expect(() => {
					hash = computeSourceHash(fields);
				}).not.toThrow();
				expect(hash).toBeDefined();
				expect(typeof hash).toBe("string");
				// Even the empty set gets a defined, non-empty hash.
				expect((hash as string).length).toBeGreaterThan(0);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("computeSourceHash — determinism", () => {
	it("is deterministic across repeated calls on the same field set", () => {
		fc.assert(
			fc.property(fieldSetArb, (fields) => {
				// Two calls on the same array: a mutating hash would flip the
				// second result, so equality also guards input purity.
				expect(computeSourceHash(fields)).toBe(computeSourceHash(fields));
			}),
			{ numRuns: 100 },
		);
	});
});

describe("computeSourceHash — independent of field order (sorted pairs)", () => {
	it("hashes any permutation of a field set identically", () => {
		fc.assert(
			fc.property(fieldSetArb, (fields) => {
				const reversed = [...fields].reverse();

				expect(computeSourceHash(fields)).toBe(computeSourceHash(reversed));
			}),
			{ numRuns: 100 },
		);
	});
});

describe("computeSourceHash — independent of per-field confidence", () => {
	it("hashes high- and low-confidence labels of the same pairs identically", () => {
		fc.assert(
			fc.property(fieldSetArb, (fields) => {
				const relabeled = fields.map((field) => ({
					...field,
					confidence: "low" as const,
				}));

				expect(computeSourceHash(fields)).toBe(computeSourceHash(relabeled));
			}),
			{ numRuns: 100 },
		);
	});
});

describe("computeSourceHash — changes when a field's typeRef changes", () => {
	it("retypes a single generated field and expects a different hash", () => {
		// Pick a random field (index bounded by the array length) so the
		// property exercises the change across positions, not just one slot.
		const indexedFields = nonEmptyFieldSetArb.chain((fields) =>
			fc.nat({ max: fields.length - 1 }).map((index) => ({ fields, index })),
		);

		fc.assert(
			fc.property(indexedFields, ({ fields, index }) => {
				const changed = fields.map((field, i) =>
					i === index
						? { ...field, typeRef: `${field.typeRef}-changed` }
						: field,
				);

				expect(computeSourceHash(fields)).not.toBe(computeSourceHash(changed));
			}),
			{ numRuns: 100 },
		);
	});
});
