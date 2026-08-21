# Spec Registry

Behavioral specs, one per bounded context. A spec is written where the change touches money / permissions / public API / data / state — so a reviewer can approve or reject a PR without guessing.

| Context | Spec file | Lifecycle | Threshold |
|---|---|---|---|
| versailles (contract pipeline) | [versailles.md](versailles.md) | implemented | public-api, data |
| contract-language | [contract-language.md](contract-language.md) | implemented | public-api, data |
| manifest-extraction | [manifest-extraction.md](manifest-extraction.md) | implemented | data, public-api |
| workspace-context | [workspace-context.md](workspace-context.md) | implemented | data, public-api |
| deterministic-generation | [deterministic-generation.md](deterministic-generation.md) | implemented | data, public-api, state |
| review | [review.md](review.md) | implemented | data, state |
| predicate-registry | [predicate-registry.md](predicate-registry.md) | implemented | data, public-api |

See also: [Contracts](../contracts/index.md) · [Decisions](../decisions/index.md) · [Build spec](../build-spec.md)