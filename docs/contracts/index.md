# Contract Registry

Machine-checkable Design-by-Contract contracts (`contract_gate`). One contract per bounded context, authored by the contract authoring process. No implementation starts without a registered contract.

| Context | Contract file | Status | Validated |
|---|---|---|---|
| contract-language | [contract-language.contract.yaml](contract-language.contract.yaml) · [summary](contract-language.md) | draft | pending |
| manifest-extraction | [manifest-extraction.contract.yaml](manifest-extraction.contract.yaml) · [summary](manifest-extraction.md) | draft | pending |
| workspace-context | [workspace-context.contract.yaml](workspace-context.contract.yaml) · [summary](workspace-context.md) | draft | pending |
| deterministic-generation | [deterministic-generation.contract.yaml](deterministic-generation.contract.yaml) · [summary](deterministic-generation.md) | draft | pending |
| review | [review.contract.yaml](review.contract.yaml) · [summary](review.md) | draft | pending |

Each contract is validated by `scripts/validate-contracts.sh` (required keys present, `context` matches `docs/specs/<ctx>.md`). A row's `Validated` column flips to *pass* once the script reports it.

See also: [Specs](../specs/index.md) · [Decisions](../decisions/index.md) · [Build spec](../build-spec.md)