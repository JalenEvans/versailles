/**
 * Seeded property-based test emission — per-clause PBT strategy selector
 * (ADR-0017 Phase 3, build-spec §9.6 + deterministic-generation.contract.yaml
 * `plan_property_blocks`).
 *
 * selectStrategy answers ONE question per clause: does PBT add value over the
 * existing concrete (example-based) case for THIS clause shape, or is the
 * example strictly better? The deterministic generator always plans the
 * concrete cases (§9.1–§9.2); the selector only decides whether an ADDITIVE
 * property block is planned for the clause.
 *
 * It is a pure function of the normalized clause shape + the
 * config.propertyBased.enabled flag: no randomness, no runtime execution, no
 * LLM (ADR-0002, re-scoped to generation-time by ADR-0017). Same shape →
 * same strategy, always. It is total over the ClauseShape union — a valid
 * shape always maps to a defined strategy, never undefined, never throws.
 *
 * The mapping (build-spec §9.6 strategy table):
 *
 * | Shape (surface + kind)                  | Strategy                |
 * |-----------------------------------------|-------------------------|
 * | precondition  numeric-bound             | example                 |
 * | precondition  in                        | example                 |
 * | precondition  predicateCall             | property-with-falsifier |
 * | precondition  compound (and/or)         | property                |
 * | precondition  bothSideFieldRef          | property                |
 * | precondition  other / uncomputable      | property                |
 * | postcondition literal (computable)      | property (pbtEnabled) / example (disabled) |
 * | postcondition uncomputable              | property                |
 * | invariant     effects-overlap           | property                |
 * | invariant     plain (no effect overlap) | example                 |
 * | expected-rejection  (pbtEnabled: true)  | property                |
 * | expected-rejection  (pbtEnabled: false) | example (sweep fallback)|
 *
 * The planner feeds the RESOLVED classification: a top-level compound wins
 * over any numeric-bound sub-expression (a clause that is BOTH numeric-
 * bounded AND compound → property — compound precedence). The selector never
 * re-derives the classification from the raw Node. expected-rejection and
 * postcondition-literal are the ONLY shapes whose strategy depends on
 * pbtEnabled; every other shape ignores the flag. VERSAILLES-191: a
 * literal-computable postcondition (`field op expr` — e.g. `balance ==
 * old(balance) + price`) is a REGION property — the concrete satisfaction
 * case pins one deterministic point, the property block checks the relation
 * across the valid region — so it plans a property block when PBT is enabled
 * and only falls back to example when PBT is off (the v1 output).
 */

export type PbtStrategy = "example" | "property" | "property-with-falsifier";

export type ClauseSurface =
	| "precondition"
	| "postcondition"
	| "invariant"
	| "expected-rejection";

/**
 * Normalized clause shape — the selector input. The planner builds this from
 * classifyClause + planning metadata (surface, computability, effect overlap,
 * top-level compound resolution).
 */
export type ClauseShape =
	| {
			surface: "precondition";
			kind:
				| "numeric-bound"
				| "in"
				| "predicateCall"
				| "compound"
				| "bothSideFieldRef"
				| "other";
			// Compound variant only — a compound that CONTAINS a numeric bound
			// (the boundary-ambiguity fixture). The compound still wins.
			hasNumericBound?: boolean;
	  }
	| { surface: "postcondition"; kind: "literal" | "uncomputable" }
	| { surface: "invariant"; kind: "effects-overlap" | "plain" }
	| { surface: "expected-rejection" };

export type StrategyOptions = { pbtEnabled: boolean };

/**
 * Selects the PBT strategy for a single clause. Pure table lookup over
 * (surface, kind), total over the ClauseShape union; deterministic and free
 * of any global/config state — pbtEnabled is an explicit input parameter.
 */
export function selectStrategy(
	shape: ClauseShape,
	options: StrategyOptions,
): PbtStrategy {
	switch (shape.surface) {
		case "precondition":
			switch (shape.kind) {
				case "numeric-bound":
				case "in":
					return "example";
				case "predicateCall":
					return "property-with-falsifier";
				case "compound":
				case "bothSideFieldRef":
				case "other":
					return "property";
			}
			return "property";
		case "postcondition":
			switch (shape.kind) {
				// VERSAILLES-191: a literal-computable postcondition is a
				// `field op expr` REGION PROPERTY — the concrete satisfaction
				// case pins one point; the property block checks the relation
				// across the valid region. property when PBT is enabled,
				// example only on the disabled/absent v1 path.
				case "literal":
					return options.pbtEnabled ? "property" : "example";
				case "uncomputable":
					return "property";
			}
			return "property";
		case "invariant":
			switch (shape.kind) {
				case "effects-overlap":
					return "property";
				case "plain":
					return "example";
			}
			return "example";
		case "expected-rejection":
			return options.pbtEnabled ? "property" : "example";
	}
}

/** The per-clause decision record — the output shape the planner attaches to
 * the planning output (clause → strategy). */
export type StrategyRecord = {
	clauseId: string;
	strategy: PbtStrategy;
	shape: ClauseShape;
};

/** The clause → strategy map recorded on the planning output. */
export type StrategyMap = Record<string, PbtStrategy>;
