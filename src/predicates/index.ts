/**
 * Predicate registry module — public surface (build-spec §3.4, §13 milestone
 * 8, docs/contracts/predicate-registry.contract.yaml).
 *
 * ADR-0013 (Phase 3): the CLI trio (register-predicate, verify-purity,
 * remind-unverified) is removed. Predicates are now declarative in
 * contracts.json. The module retains name validation and source resolution
 * for the loader's resolve-or-warn pass.
 */
export { isValidPredicateName, type PredicateEntry } from "./registry.js";
export { resolvePredicateSource } from "./source.js";
