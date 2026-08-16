/**
 * Predicate registry module — public surface (build-spec §3.4, §13 milestone
 * 8, docs/contracts/predicate-registry.contract.yaml). Registry data logic
 * (name validation, purity reminder) plus source resolution and the
 * implementation hash for registration. No LLM anywhere (ADR-0010).
 */
export {
	isValidPredicateName,
	listUnverified,
	type PredicateEntry,
} from "./registry.js";
export {
	computePredicateSourceHash,
	parseSourceRef,
	resolvePredicateSource,
} from "./source.js";
