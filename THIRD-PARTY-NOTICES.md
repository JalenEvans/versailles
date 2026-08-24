# Third-Party Notices

Versailles (`versailles-dbc`) includes or depends on the following third-party software. Each entry lists the license under which the software is used. Full license texts are not reproduced here; see the linked project or SPDX identifier for the complete terms.

## Current runtime dependencies

These packages are installed as part of the standard build and test workflow. Versions reflect those declared in `package.json` devDependencies at the time of this notice.

| Package | Version | License | Notes |
|---------|---------|---------|-------|
| [ajv](https://github.com/ajv-validator/ajv) | ^8.17.0 | MIT | JSON schema validator; used at runtime by the workspace loader (`packages/core/src/loader/workspace.ts`) |
| [typescript](https://github.com/microsoft/TypeScript) | ^5.8.0 | Apache-2.0 | TypeScript compiler; used at runtime by the TypeScript manifest extractor (`packages/frontend-ts/src/extractors/typescript.ts`) |
| [fast-check](https://github.com/dubzzz/fast-check) | ^4.9.0 | MIT | Property-based testing framework |
| [vitest](https://github.com/vitest-dev/vitest) | ^3.0.0 | MIT | Test runner |
| [@biomejs/biome](https://github.com/biomejs/biome) | ^1.9.4 | MIT | Linting and formatting |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | ^26.2.0 | MIT | Type definitions for Node.js |

## Planned bundled artifacts

The following artifacts are not yet shipped but are planned for future releases (build-spec §15.7). Their license notices must travel with any bundled artifact when shipped.

| Artifact | License | Notes |
|----------|---------|-------|
| [Z3](https://github.com/Z3Prover/z3) (via z3-solver) | MIT | SMT solver; will ship as a WASM artifact in-package for the L3/L4 engine |
| [Roslyn](https://github.com/dotnet/roslyn) | MIT | .NET Compiler Platform; planned C# front-end for manifest extraction |

---

For questions about licensing, see [ADR-0015](docs/decisions/0015-licensing-and-contribution-model.md).
