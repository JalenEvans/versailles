# Versailles — Build Specification

Deterministic test generation from Design-by-Contract specifications, with a machine-readable
CLI surface. Contracts are authored directly into `contracts.json`; `validate` / `check` gate
correctness; the git commit is the approval (ADR-0003, ADR-0012). The CLI never invokes an LLM
(ADR-0010).

**Naming:** package name `versailles-dbc` (or scoped `@<org>/versailles`) on npm — the bare
name `versailles` is already registered (unmaintained placeholder). CLI command name is
`versailles`, decoupled from the package name via the `bin` field in `package.json`:

```json
{
  "name": "versailles-dbc",
  "bin": { "versailles": "./bin/versailles" },
  "scripts": {
    "prepare": "tsc -p tsconfig.json",
    "prepublishOnly": "bun run build && bun run smoke"
  }
}
```

`bin/versailles` is a thin shim importing the built `dist/cli/index.js`, and `dist/` is
gitignored — never committed. To keep install self-sufficient (VERSAILLES-16), the package
ships two lifecycle hooks: `prepare` runs the same `tsc` build as `bun run build`, so
git/root installs and the published tarball materialize `dist/` automatically — a fresh
clone plus install yields a working CLI with no manual build (bun skips `prepare` for
`file:` dependencies, so `bun add file:../versailles` needs a manual build) — and
`prepublishOnly` runs the build + smoke suite as a publish guard, so a package whose CLI
is broken never ships.

---

## 1. Goals and non-goals

**Goals**
- Contracts (invariants, preconditions, postconditions) are the single source of truth for
  test generation.
- Test *generation* from a validated contract is 100% deterministic — same contract in,
  same test suite out; no LLM is invoked anywhere in the tool (ADR-0010).
- Contracts are auditable: every contract clause traces back to a specific source hash,
  every generated test traces back to a specific contract clause, and the git commit is
  the approval (ADR-0003, ADR-0012).
- Predicates are declared inline in `contracts.json` (top-level `predicates` map);
  `validate` mechanically verifies each declaration (ADR-0013).

**Non-goals (v1)**
- No support for arbitrary executable code inside contract expressions (no function calls
  beyond registered named predicates, no loops, no side effects).
- No SMT-based precise input synthesis in v1 (design for it, defer implementation).
- No multi-language grammar variants — the contract expression grammar is language-agnostic;
  only the manifest extractor is per-language.

---

## 2. Directory layout

```
.versailles/
├── config.json          # tool config: $schema pointer, source globs, generator target
├── contracts.json        # component contracts (invariants + operations) plus a top-level
│                         # `predicates` map (declarative predicate registry, ADR-0013)
├── manifests.json        # field manifests per component/type, derived from source
└── generated/             # deterministic generator output (test files)
    └── <component>/<operation>.test.<ext>
```

All three top-level data files are loaded as a single unit — no
file is valid to interpret in isolation because contracts reference manifests and
predicates by name.

A committed reference implementation of this layout lives at `examples/order-service/`:
a real TypeScript service with a `.versailles/` workspace and a generated vitest
suite. `bun run example:generate` re-extracts and regenerates it, failing if the output
drifts from what is committed.

---

## 3. File schemas

### 3.1 `config.json`

```json
{
  "$schema": "../../config.schema.json",
  "sourceRoots": ["src/**/*.ts"],
  "language": "typescript",
  "testFramework": "vitest",
  "generatedDir": ".versailles/generated",
  "staleness": {
    "blockOnStale": true
  },
  "rejection": {
    "idiom": "throws"
  },
  "propertyBased": {
    "enabled": false,
    "numRuns": 100
  }
}
```

- `$schema`: pointer to `config.schema.json`, the machine-checkable schema for the config
  shape (ADR-0018).
- **Version gates removed (ADR-0018):** there are no `grammarVersion` / `schemaVersion`
  config fields and no file-level `version` fields. The tool version lives in the binary
  (`versailles -v` / `--version`). Format evolution is additive-only, with a
  deprecate-don't-remove policy and a tool-driven `migrate` policy.
- `sourceRoots`: glob patterns the manifest extractor scans.
- `language`: selects the manifest extractor plugin (see §7).
- `testFramework`: selects the generator's output emitter (see §9).
- `staleness.blockOnStale`: whether CI fails on detected drift (see §8) or only warns.
- `rejection.idiom`: how the generator's precondition-violation emitter asserts rejection —
  `throws` expects the operation to throw (`toThrow`-style assertion), `returns` expects an
  error return value; default `throws` (ADR-0007).
- `propertyBased.enabled`: opt-in seeded PBT emission (ADR-0017) — `false` (default) keeps
  the v1 concrete-case output byte-identical (no property blocks, no new imports); `true`
  additionally emits seed-pinned property blocks alongside the concrete cases.
- `propertyBased.numRuns`: property runs per emitted block (default 100).
- `propertyBased.seed`: optional explicit seed override; when absent, each block's seed is
  derived as a 32-bit int from a stable hash of the context (the block's clause IDs +
  grammar version).

### 3.2 `contracts.json`

```json
{
  "contracts": {
    "<ComponentName>": {
      "invariants": [
        { "id": "<ComponentName>.inv<N>", "expr": "<expression string>" }
      ],
      "operations": {
        "<operationName>": {
          "id": "<ComponentName>.<operationName>",
          "params": [
            { "name": "<paramName>", "type": "<typeRef>" }
          ],
          "preconditions": [
            { "id": "<ComponentName>.<operationName>.pre<N>", "expr": "<expression string>" }
          ],
          "postconditions": [
            { "id": "<ComponentName>.<operationName>.post<N>", "expr": "<expression string>" }
          ],
          "effects": [
            { "field": "<fieldRef>", "kind": "mutate|create|delete" }
          ],
          "sourceHash": "<hash of function signature + docstring at generation time>"
        }
      }
    }
  }
}
```

Rules:
- One `invariants` list per component (Meyer/DbC scoping: invariant is per-component, not
  per-operation).
- One `preconditions`/`postconditions` pair per operation.
- `operations.params` is required and used by the validator to resolve unqualified
  identifiers scoped to that operation (in addition to component fields from the manifest).
- `effects` is used by the generator to know which fields a postcondition-satisfaction test
  should assert against, and to scope invariant-preservation checks.
- Every operation contract carries its own `sourceHash`; the component's invariant block
  carries an implicit hash via the component's entry in `manifests.json` (see §3.3).

### 3.3 `manifests.json`

```json
{
  "manifests": {
    "<ComponentName>": {
      "sourceHash": "<hash of structural shape: sorted field pairs + sorted method-signature records>",
      "sourcePath": "<source file path the component was extracted from>",
      "fields": {
        "<fieldName>": "<typeRef>"
      },
      "methods": {
        "<methodName>": {
          "static": false,
          "params": ["<paramName>", ...],
          "returnType": "<typeRef>"
        }
      }
    }
  }
}
```

- Flat map, including value/nested types referenced by other components (so
  `order.items[].sku` resolves by looking up `OrderItem` in the same map).
- `<typeRef>` grammar: `string | number | boolean | <ComponentName> | list<typeRef> |
  optional<typeRef> | enum<v1,v2,...>`.
- `sourcePath` is the **project-root-relative** path of the file the component was extracted
  from, with POSIX separators — e.g. `src/order.ts` for a file at `<root>/src/order.ts`.
  It is never source-root-relative (`order.ts`) and never absolute, so the generator's
  `join(cwd, sourcePath)` derives a module path that resolves to the real file
  (VERSAILLES-24). Covered entries always carry it; legacy entries may lack it and are
  preserved as-is. When no project root is derivable (projectRoot omitted and the source
  roots share no common prefix), the fallback is the file relative to `sourceRoots[0]`
  when that yields a relative path — or the field is omitted — never the absolute file
  path (VERSAILLES-24 follow-up).
- `methods` records per-component method metadata — method name, static/instance,
  ordered param names, return type where determinable — so the generator can render
  shape-aware calls. Method bodies never enter the manifest. Every entry **refreshed by an
  extract run always carries the `methods` key** — possibly `{}`, the first-class
  "we know this component has zero methods" signal that distinguishes a freshly-extracted
  entry from a preserved legacy one; only preserved legacy entries the extractor never
  touched may lack the key (VERSAILLES-25 follow-up).
- `sourceHash` covers the structural shape: sorted field name+type pairs plus sorted
  method-signature records. Method bodies are excluded, so body-only edits don't trigger
  false staleness.
- Generated by static analysis (§7); the tool never invokes an LLM — anything written
  here must be verified against actual source (ADR-0010).

### 3.4 Predicates (top-level `predicates` map in `contracts.json`)

Predicates are declared inline in `contracts.json` as a top-level `predicates` map
(ADR-0013). Each entry declares the predicate's source reference and parameter shape:

```json
{
  "predicates": {
    "<predicateName>": {
      "source": "<Module.functionName>",
      "params": ["<paramName>"],
      "paramTypes": ["<typeRef>"],
      "returnType": "boolean"
    }
  },
  "contracts": { ... }
}
```

- `source` is the **sourceRef** — the qualified name of the real function the predicate
  refers to. `validate` resolves it under `config.sourceRoots`; an unresolvable `source`
  produces a non-blocking `PREDICATE_SOURCE_UNRESOLVED` warning (ADR-0005 "nothing
  invented" is served by resolve-or-warn, not by a stored hash).
- **No purity gate** (ADR-0019): the declaration itself is the attestation — a predicate
  cannot be referenced without being deliberately declared with a resolvable `sourceRef`.
  Purity is neither asserted nor analyzed; an impure or non-terminating predicate surfaces
  as a failing or hanging generated test on the first suite run.
- `sourceHash` is **dropped** (ADR-0013): no stored hash is maintained, and no command
  drift-checks predicate hashes. The declaration sits alongside the contract, and the git
  commit is the approval.
- The registration CLI (`register-predicate` / `verify-purity` / `remind-unverified`) is
  removed (ADR-0013). Predicate registration is part of authoring — the declaration sits
  in `contracts.json` next to the contracts that use it, and `validate` is the single
  gate that catches missing and unresolvable declarations at once.

---

## 4. Contract expression grammar

### 4.1 Grammar (EBNF)

```
expr        := or_expr
or_expr     := and_expr ( "or" and_expr )*
and_expr    := not_expr ( "and" not_expr )*
not_expr    := "not"? comparison
comparison  := term ( comp_op term )?
comp_op     := "==" | "!=" | ">" | ">=" | "<" | "<=" | "in"
term        := literal | old_ref | predicate_call | field_ref | arithmetic
arithmetic  := term ( ("+" | "-" | "*" | "/") term )?
old_ref     := "old(" field_ref ")"
predicate_call := IDENT "(" ( term ( "," term )* )? ")"
field_ref   := IDENT ( "." IDENT | "[" NUMBER "]" | "[]" )*
literal     := NUMBER | STRING | "true" | "false" | "null" | list_literal
list_literal:= "[" ( list_element ( "," list_element )* )? "]"
list_element:= NUMBER | STRING | "true" | "false" | "null"
```

### 4.2 Structural (grammar-level) constraints, enforced by the parser itself, not the
    semantic validator

- `old_ref` is syntactically valid **only** when parsing a `postconditions[]` entry.
  Encountering `old(...)` while parsing `preconditions[]` or `invariants[]` is a parse
  error, not a semantic one — reject before semantic validation runs.
- `predicate_call` identifiers are not resolved at parse time (that's semantic validation);
  the parser only checks the call-shape is well-formed (balanced parens, valid arg
  expressions).
- No assignment, no loops, no statements — the grammar only produces boolean-valued
  expression trees. Anything outside this grammar is a parse error.

### 4.3 AST node types (parser output contract)

```
Node =
  | { type: "or", left: Node, right: Node }
  | { type: "and", left: Node, right: Node }
  | { type: "not", operand: Node }
  | { type: "compare", op: CompOp, left: Node, right: Node }
  | { type: "arithmetic", op: ArithOp, left: Node, right: Node }
  | { type: "old", ref: FieldRefNode }
  | { type: "predicateCall", name: string, args: Node[] }
  | { type: "fieldRef", path: (string | number | "[]")[] }
  | { type: "literal", value: string | number | boolean | null | LiteralList }
```

### 4.4 Parser error contract

Every parse error must include:

```json
{
  "contractId": "OrderService.placeOrder.post0",
  "field": "postconditions[0]",
  "position": 20,
  "found": "=",
  "expected": ["=="],
  "message": "Unexpected token '=' at position 20 — did you mean '=='?"
}
```

- Errors are structured objects, not strings, so downstream consumers (CI, external tooling)
  can render or re-inject them programmatically.
- Parser must never throw an unstructured exception on malformed input — always return a
  structured error result.

---

## 5. Semantic validator

Runs after successful parse. Requires the full `.versailles/` context (contracts +
manifests + predicates) loaded together.

### 5.1 Checks performed

| Check | Rule | Severity |
|---|---|---|
| Field ref resolves | Root identifier of a `field_ref` must exist in the component's manifest fields, or in the current operation's `params` (for pre/postconditions) | Hard |
| Nested field ref resolves | Each `.` segment must resolve through the referenced type's manifest entry, transitively | Hard |
| Type compatibility | Both sides of a `comparison` must have compatible declared types (per manifest/param types) | Hard |
| `in` operand shape | Right-hand side of `in` must be a `list_literal` or a field of `list<T>`/`enum<...>` type matching left-hand type `T` | Hard |
| `old()` scope | Already enforced at parse time; validator re-asserts as defense-in-depth | Hard |
| Predicate exists | Called name exists in the top-level `predicates` map of `contracts.json` | Hard |
| Predicate arity | Number of args matches `predicates[name].params.length` | Hard |
| Predicate arg types | Each arg's resolved type matches `predicates[name].paramTypes[i]` | Hard |
| Predicate sourceRef resolves | `predicates[name].source` resolves to a real function under `config.sourceRoots` | Warning (`PREDICATE_SOURCE_UNRESOLVED`) |
| Predicate name is a valid IDENT | Predicate declaration key matches the `predicate_call` IDENT grammar | Hard (`INVALID_PREDICATE_NAME`) |
| Field exists but manifest confidence low | Field resolves but manifest entry is flagged as inferred/low-confidence (extension point, not required in v1) | Warning |

### 5.2 Validator output contract

```json
{
  "valid": false,
  "errors": [
    { "contractId": "...", "code": "UNKNOWN_FIELD", "field": "postconditions[0]", "detail": "..." }
  ],
  "warnings": [ ... ]
}
```

- Hard errors block the contract from passing validation — surfaced as structured output —
  or block CI (in the lint flow).
- Warnings are surfaced but non-blocking.
- `validate --verbose` additionally emits raw `expr` strings alongside their parsed AST
  per clause as a parser-sanity check.

---

## 6. `.versailles/` loader / context object

A single shared module used by every other component (CLI commands, CI lint, generator) —
no component re-implements loading or cross-referencing independently.

**Responsibilities:**
1. Read and JSON-parse all three data files (`config.json`, `contracts.json`,
   `manifests.json`).
2. Apply no version gates (ADR-0018): `grammarVersion` / `schemaVersion` and the per-file
   `version` fields are removed — a version-less config is the valid default; deprecated
   fields still load permissively (deprecate-don't-remove) until `migrate` rewrites them.
3. Parse every `expr` string in `contracts.json` into an AST, collecting structured parse
   errors.
4. Run the semantic validator against the full context, collecting structured semantic
   errors/warnings (including declarative-predicate verification per §3.4).
5. Return a single `VersaillesContext` object:
   ```
   {
     config, contracts, manifests, predicates,
     parsedContracts: { [contractId]: AST },
     parseErrors: [...],
     validationErrors: [...],
     validationWarnings: [...],
     isValid: boolean
   }
   ```
   where `predicates` is the top-level `predicates` map from `contracts.json`.
6. Expose a scoped-extraction helper: given a component/operation name, return just that
   sub-object plus its errors — used by `validate --verbose` to show a scoped parser-sanity
   view (raw `expr` + parsed AST per clause).

The loader never throws on malformed input — missing files, invalid JSON, valid-JSON/wrong-shape
files, and malformed expressions all produce structured errors (`LoaderError` codes
`MISSING_FILE` | `INVALID_JSON` | `CONFIG_INVALID` | `INVALID_SHAPE`, with
scoped extraction reporting unknown targets as `NOT_FOUND`) rather than unstructured exceptions.
A runtime shape-guard pass catches wrong-shape files before any consumer touches them, and the
semantic validator returns structured results — never a raw throw — on arbitrary ASTs/contexts,
with its errors/warnings flowing into `validationErrors`/`validationWarnings` and `isValid`
aggregating parse + loader + semantic errors (ADR-0010).

---

## 7. Manifest extractor (source → `manifests.json`)

- Pluggable per `config.language`. v1 target: one language (pick based on your primary
  repo — TypeScript or Python).
- **TypeScript approach:** use the TypeScript compiler API (`ts.createProgram`, type
  checker) to walk class/interface declarations, resolve field types to the `typeRef`
  grammar in §3.3, including generics (`list<T>`), unions mapped to `enum<...>` where all
  members are literal types, and nested/related types added to the flat manifest map
  transitively.
- **Python approach:** use `ast` module + type hints (`typing` module introspection) or a
  static type-checker's internal representation (e.g. mypy's AST) for accuracy; dynamic
  typing means some fields may only be inferable, not declared — those should be marked
  low-confidence per §5.1's warning tier rather than silently trusted.
- Per-component **method metadata**: every resolvable method is recorded with its name,
  static/instance flag, ordered param names, and return type where determinable — so the
  generator can render shape-aware calls (instance vs static vs void). Method bodies are
  never recorded. Every entry **refreshed by an extract run persists the `methods` key
  even when the component has zero methods** — an empty map `{}` is the first-class
  "we know this component has zero methods" signal that keeps the planner's
  `UNPLANNABLE_OPERATION` guard firing for any planned op; only preserved legacy entries
  the extractor never touched may lack the key (VERSAILLES-25 follow-up).
- `sourcePath` recording: every covered component entry carries the source file path it
  was extracted from, expressed **project-root-relative with POSIX separators**
  (`src/order.ts`, never `order.ts` and never absolute), persisted through
  `manifests.json` (§3.3) so the loader and generator can derive real module import paths
  that resolve against the workspace root (VERSAILLES-24). When projectRoot is omitted
  and the source roots share no common prefix (disjoint roots), the fallback is the file
  relative to `sourceRoots[0]` when that yields a relative path — or the field is omitted
  — never the absolute file path (VERSAILLES-24 follow-up).
- `sourceHash` computation: hash of the **structural shape only** (sorted field
  name+type pairs plus sorted method-signature records), not the full source file and
  never method bodies — so unrelated changes to method bodies don't trigger false
  staleness.
- Extractor is a CLI subcommand: `versailles extract-manifests` — reads `config.sourceRoots`,
  writes/updates `manifests.json`, preserving entries for components not covered by the
  current scan (with a `--prune` flag to remove stale entries explicitly, never implicitly).
---

## 8. Staleness / CI lint

CLI subcommand: `versailles check` — intended for CI.

1. Load context via §6 loader.
2. Fail if `parseErrors` or `validationErrors` non-empty.
3. Recompute `sourceHash` for every manifest entry and contract operation from
   current source; compare against stored hash. (Predicate `sourceHash` is dropped per
   ADR-0013; predicate drift is not staleness-checked.)
4. On mismatch:
   - If `config.staleness.blockOnStale === true`: hard fail with a list of stale IDs.
   - Else: emit a warning report (e.g. as a CI annotation) but exit 0.
5. Exit codes: `0` clean, `1` parse/validation error, `2` staleness violation (when
   blocking) — distinct codes so CI pipelines can branch behavior if desired.

---

## 9. Deterministic test generator

CLI subcommand: `versailles generate` — only runs against a context where `isValid: true`.

Two entry points, distinguished by manifest presence (ADR-0011): **contract-first** (greenfield) — when no `manifests.json` exists, `generate` works from `contracts.json` alone (including its top-level `predicates` map); the module surface (import paths, method metadata) is derived from the contract, and generated tests fail at import until the module exists, a legitimate TDD Red. **extract-first** (brownfield) — `manifests.json` is required; full semantic validation, `sourceHash` staleness checks, and V-25 method-map gating apply. Manifests remain authoritative whenever present.

### 9.1 Per-operation test cases (from preconditions/postconditions)

For each operation:
- **Boundary values**: for every numeric comparison in preconditions (`x >= 0`, `x < 100`),
  generate cases at the boundary, boundary−1, boundary+1 — each case's input satisfies every
  *other* param while this one probes the boundary.
- **Equivalence partitions**: for every `in` clause or enum-typed field, generate one case
  per partition member plus one case outside the set — each case's input satisfies every
  *other* param while this one probes the partition.
- **Precondition-violation cases**: for each precondition clause individually, generate an
  input that satisfies all *other* clauses but falsifies this one; assert the operation
  rejects (throws / returns error / whatever the language's rejection idiom is — configurable
  in `config.json`, defaulting to "throws").
- **Predicate-call preconditions**: for each `predicate_call` precondition (e.g.
  `isPositive(amount)`), synthesize at least one violation case deterministically from the
  registered predicate's `paramTypes` and any registry example hints; when no violation
  input is derivable, surface an explicit non-silent warning — never silently emit zero
  cases.
- **Predicate-aware valid inputs**: valid-input synthesis must satisfy registered
  predicates — a predicate-guarded param receives a value the predicate accepts
  (deterministic, registry-hint-derived), never a value the operation would reject
  (e.g. `0` for `isPositive`).
- **Unrenderable operations**: a planned operation with no matching method in the source
  manifest (no method metadata and no resolvable source method) surfaces a **non-silent
  non-blocking warning** — `UNPLANNABLE_OPERATION`, same tier as the predicate-call
  `PREDICATE_UNPLANNABLE` warning: exit 0, warning in `CliResult.warnings` — and the
  generator never emits the legacy static options-object call for it (VERSAILLES-25).
  The guard fires whenever the component's entry carries a `methods` key — empty or not —
  missing the planned op: an empty map `{}` on a refreshed entry still warns for every
  planned op, because it is the first-class "we know this component has zero methods"
  signal. Only an entry lacking the `methods` key entirely (a preserved legacy entry the
  extractor never touched) keeps the legacy default (VERSAILLES-25 follow-up).
- **Postcondition-satisfaction cases**: for valid inputs (satisfying all preconditions),
  generate a case asserting the simple field-compare postconditions (`field op expr`) —
  on the result, or on the bound instance state for a void-returning instance operation —
  resolving `old(field)` against captured pre-call state. Clauses that cannot yield a
  computable literal (predicate calls, both-side field refs, uncomputable expressions)
  contribute no assertion — a conservative skip; the case is still emitted and its clause
  IDs stay traced in `coverage.json`.

### 9.2 Per-component invariant tests

- For each operation on a component with invariants:
  - Construct a pre-state satisfying all component invariants (using a component-level
    valid-state builder derived from the manifest + invariant clauses).
  - Call the operation with valid inputs.
  - Assert every invariant clause still holds post-call.
- **Postcondition/invariant interaction cases**: generate cases where inputs satisfy the
  operation's postcondition but the resulting state would violate a component invariant —
  flag these as expected-rejection cases (the operation should refuse to complete) since
  this is the specific bug class DbC is designed to catch.

### 9.3 Traceability

- Every generated test includes a comment/annotation with the source contract ID(s) it
  covers, e.g. `// versailles: OrderService.placeOrder.pre0 (violation case)`.
- Generator maintains a coverage manifest (`generated/coverage.json`) mapping contract
  clause IDs → generated test IDs, so gaps (a clause with zero generated tests — shouldn't
  happen, but worth asserting) are detectable.

### 9.4 Output emitters

- Pluggable per `config.testFramework` — the v1 matrix (ADR-0009) is three shipped emitters behind the same seam: vitest (`*.test.ts`), xUnit (`*.Tests.cs`), pytest (`test_*.py`).
- Emitter responsibility: take the generator's framework-agnostic test-case IR (input
  values, expected outcome, assertion list, traceability comment) and render it to actual
  test-file syntax.
- **Shape-aware calls**: emitters render calls from manifest method metadata (§3.3) —
  instance methods via `new <Component>().<operation>(...)`, static methods via
  `<Component>.<operation>(...)`, params passed positionally in declared order, and no
  return-value assertion for void-returning operations. Accept/invariant cases on
  **instance** void-returning operations bind the component **instance** — `const instance
  = new <Component>(); instance.<field> = <captured>; instance.<op>(...);
  expect(instance.<field>)...` — so assertions target instance state, never the void
  return value (VERSAILLES-26); the captured non-param inputs are seeded onto the bound
  instance before the call because assertion literals derive from the planner's captured
  pre-call state, which a fresh instance does not carry. For a **static**
  void operation with assertions, the case renders the bare call without any
  `instance.<field>` assertion — the static call never touches a constructed instance, so
  asserting on one would be misleading (VERSAILLES-26 follow-up).
- **Module paths**: emitters derive component import paths from the manifest `sourcePath`
  entry when present — a project-root-relative path (`src/order.ts`) joined against the
  workspace root and computed relative to the generated file's directory, so the emitted
  specifier **resolves to the real source file** from the generated file's directory
  (resolvability, not just a matching extension or suffix). A deterministic default
  fallback applies when `sourcePath` is absent — never an empty-string import
  (VERSAILLES-24).
- Regeneration is idempotent and full-file (the `generated/` directory is fully
  tool-owned — never hand-edited, always regenerated from `contracts.json`).

### 9.5 SMT-backed generation (soundness requirement, roadmap §16)

SMT-backed witness synthesis is a **soundness requirement** for the L3/L4 code-path
analysis engine (ADR-0014), not a v1 stretch goal. V1 does not ship SMT-based synthesis —
that sequencing is unchanged — but the framing shifts from "stretch" to "soundness
requirement, sequenced after v1" per the roadmap phase sequence (ADR-0014 / roadmap §16).

- Translate the AST (§4.3) to SMT-LIB, use Z3 to synthesize precise satisfying/violating
  witnesses instead of heuristic boundary values, particularly valuable for compound
  boolean preconditions where heuristic partition generation misses interaction cases.
  This capability is required for the L3/L4 engine's soundness guarantees (roadmap §4).
- Design the AST and grammar now to keep this translation mechanical later (already true
  given the grammar's restricted, side-effect-free shape). The grammar's side-effect-free
  shape is a deliberate design-for-it decision that keeps the SMT-LIB translation
  mechanical when the L3/L4 engine phases begin.

### 9.6 Seeded PBT emission (opt-in, ADR-0017)

Seeded property-based test (PBT) emission is an opt-in, additive generator capability
(ADR-0017) that mitigates the v1 "vacuous interaction case" defect for compound boolean
preconditions until SMT-sound synthesis ships (§9.5). Behavioral intent lives in
[SPEC-dg](specs/deterministic-generation.md); this subsection is the implementation
reference.

- **Opt-in config** — `config.propertyBased.enabled` (default `false`). When `false` or
  absent, the emitted suite is byte-identical to the v1 concrete-case output: no property
  blocks, no new imports (backward-compat pin). When `true`, property blocks are emitted
  **additively** alongside the concrete cases — the concrete cases remain the audit spine
  for `coverage.json` traceability.
- **Seed derivation** — every property block's run is pinned via
  `fc.assert(prop, { seed, numRuns })`. The seed is a 32-bit int derived from a stable hash
  of the context — the block's clause IDs + grammar version — unless
  `config.propertyBased.seed` overrides it explicitly. Because the seed is a literal derived
  at generation time, `versailles generate` twice on the same context still produces
  byte-identical files (ADR-0002, re-scoped to generation-time by ADR-0017), while the
  emitted test itself is reproducible run-to-run. `numRuns` defaults to 100.
- **Per-param arbitraries** — derive from manifest/param typeRefs and the planner's numeric
  constraint bounds: numeric params → bounded integer/float ranges from the constraints
  (`fc.integer({ min, max })`-style), `in`/enum params → member constants, strings →
  bounded strings. A clause whose valid region is unrepresentable from bounds/typeRefs is
  unplannable (see warnings below).
- **Clause-codegen'd oracles** — the contract clauses are codegen'd into the generated test
  as inline predicate functions (pure by grammar); predicate calls resolve to the real
  registered predicate functions. The property asserts the clause holds (postcondition-
  satisfaction, invariant-preservation) or rejects via the configured idiom
  (precondition-violation, expected-rejection, ADR-0007).
- **Strategy selection summary** — property blocks are planned per case kind:

  | Case kind | Arbitrary strategy | Oracle |
  |---|---|---|
  | Postcondition-satisfaction | valid pre-state + per-param arbitraries | postcondition clauses |
  | Invariant-preservation | valid pre-state + per-param arbitraries | invariant clauses |
  | Precondition-violation | arbitrary per param falsifying one clause, satisfying the others | configured rejection idiom |
  | Expected-rejection | inputs satisfying postconditions but violating an invariant | configured rejection idiom |

- **Expected-rejection sweep replacement** — when `propertyBased.enabled` is true, the §9.2
  expected-rejection bounded sweep (`EXPECTED_REJECTION_SWEEP_MAX`) is **replaced** by the
  expected-rejection property; the sweep remains the non-PBT fallback when disabled.
- **Plannability gate** — a property-strategy clause (the strategy table above) is planned
  only when all gates pass:
  - *Param representability* — every operation param maps to an ArbitrarySpec kind (number
    bounds from the constraints, string, boolean, enum members, list/optional inner kind). A
    param with no kind — e.g. a component-typed param, for which no ArbitrarySpec exists —
    means the clause cannot be represented as arbitraries at all.
  - *Oracle renderability* — the clause must codegen to an inline predicate
    (`renderClausePredicate`): unregistered predicate names, unsafe identifiers, the `[]`
    wildcard path segment, `in` with a non-literal right operand, unsupported literal types,
    and preState-name collisions are all unrenderable.
  - *Sampling strategy* (supersedes the B1 oracle-arity gate) — every guard oracle must
    route to a runnable sampling strategy. Single-param oracles keep the per-param
    arbitrary + `.filter` shape. Multi-param oracles — more than one callback parameter —
    route to one of **three joint-sampling strategies** (VERSAILLES-165, Center B1):
    - **Equality-mirror** — a guard oracle of the form `p1 == p2` / `p1 === p2`
      (bothSideFieldRef) with BOTH operands operation params: the planner generates `p1`
      from its arbitrary and mirrors the value to `p2` — the emitted callback contains
      `const p2 = p1;`. No filter is needed (the mirror guarantees the oracle), so filter
      sparsity is zero. `!=`/`!==` and equality-of-sums (`a + b == C`) are NOT mirror-able
      and stay unplannable.
    - **FIELD-BOUND** (Center B1) — a bothSideFieldRef equality `f == p` with at least one
      manifest-FIELD operand (e.g. `status == newStatus` where `status` is instance state,
      `newStatus` the op param): the field is instance state, never a sampled arbitrary,
      so the block samples ONLY the op-param arbitraries, binds the component instance
      (`const instance = new <Component>();`), calls with the sampled params (positional,
      matching the concrete-case call shape), and asserts the oracle with the field mapped
      to `instance.<field>`. No mirror const, no record, no filter. A field-referencing
      multi-param guard in the operation's guard set makes every OTHER
      satisfies/invariant-preserving descriptor of the operation unplannable (the
      mirror/record layouts cannot reference manifest fields in their filters); only
      descriptors whose OWN clause is such a field-bound equality render the FIELD-BOUND
      layout.
    - **Record + bounded filter** — coupled numeric compounds over multiple params (e.g.
      `a >= 0 and b >= 0 and a + b <= 100`): the planner derives per-param bounds
      including **cross-param propagation** from sum/difference leaves (`p1 + p2 <= C`
      with lower bounds L1, L2 → `p1 <= C − L2`, `p2 <= C − L1`; mirrored for `>=`/`>`
      with upper bounds), then the emitter samples a joint region via
      `fc.record({ a: ..., b: ... }).filter(({ a, b }) => <oracle>(a, b))` — bounded
      space first so the valid region is healthy (~≥50%), never filter-sparse, never a
      hang. If bounds cannot be derived (the space is unbounded) the clause stays
      unplannable.
  When a gate fails or the shape is unsupported — unrenderable oracles, component-typed
  params, non-mirrorable equality (`!=`/`!==`), equality-of-sums (`a + b == C`), a
  coupling that references a manifest-field operand (Center B2), an unboundable coupling
  (cross-param propagation needs bounds on both operands), a coupling whose propagation
  yields inverted bounds (unsatisfiable valid region), or a zero-param field-field
  equality (`f1 == f2`, both operands manifest fields — the FIELD-BOUND layout has no
  arbitrary to sample) — the clause surfaces **`PROPERTY_UNPLANNABLE`** — a non-silent, non-blocking
  warning (same tier as `PREDICATE_UNPLANNABLE`: exit 0, warning in `CliResult.warnings`) —
  never a silent zero. The descriptor is skipped, the clause id stays in the suite's clause
  stream so `coverage.json` maps it to a visible zero-coverage gap (§9.3), and the strategy
  record still reports the selector's choice (`property`) — the warning sits on top of a
  recorded strategy, never a hidden gap. Multi-param oracles are never emitted as a
  per-param `.filter` (fast-check's `.filter()` over independently sampled per-param
  arbitraries receives `undefined` for the 2nd+ params, filters every candidate, and the
  property hangs) — they get a joint-sampling strategy or an honest warning. This is the
  plan's filter-sparsity mitigation: bounded-space-first joint sampling with honest
  signaling over broken/hanging properties.
- **Emitter rollout** — behind the ADR-0009 seam: vitest + fast-check first; pytest +
  hypothesis and xUnit + FsCheck follow. The consuming project adds the PBT library as a
  dev dependency — the tool ships the codegen, not the library.
- **Traceability** — property blocks carry traceability comments (§9.3) and are mapped as a
  unit in `coverage.json`.

---

## 10. Machine-readable CLI surface

The CLI is a deterministic, offline tool — it never invokes an LLM (ADR-0010). Every
command responds with structured errors (stable JSON output, exit codes `0`/`1`/`2`) so
CI pipelines and external tooling can consume and branch on the result programmatically.

1. A user (developer, CI pipeline, or external tool) authors contract objects directly in
   `contracts.json`, with predicates declared inline in the top-level `predicates` map.
2. They run `versailles validate` / `versailles check` against the workspace.
3. The CLI responds deterministically with structured errors (stable JSON output, exit
   codes `0`/`1`/`2`) — no prompting, no retry loop, no LLM invocation anywhere in the
   tool.
4. The user reads the structured errors, fixes the contract objects, and re-runs; the
   TDD loop is author → validate → generate → commit.
5. On success, the validated workspace proceeds to generation; the git commit is the
   approval (ADR-0003, ADR-0012). No in-tool approval ceremony exists.

---

## 11. Human review (retired)

**Retired by ADR-0012.** The in-tool review gate (`versailles review`, `.versailles/staged/`,
single-object merge ceremony) is removed. The authored file is the artifact; `validate` /
`check` + CI gate correctness; the git commit is the approval (ADR-0003). Human review
happens in the git layer (PR/diff), where the repo's own pipeline already gates. The
parser-sanity view (raw `expr` + parsed AST) is folded into `validate --verbose`.

---

## 12. CLI command surface (summary)

| Command | Purpose |
|---|---|
| `versailles init` | Scaffold `.versailles/` with empty/default files |
| `versailles extract-manifests` | Run manifest extractor, update `manifests.json` |
| `versailles validate` | Run parser + semantic validator across all of `contracts.json` (including declarative predicate verification per §3.4), print structured report; `--verbose` additionally shows raw `expr` + parsed AST per clause |
| `versailles check` | CI-mode: validate + staleness check, proper exit codes |
| `versailles generate` | Run deterministic test generator — contract-first from `contracts.json` alone (greenfield) or extract-first against `manifests.json` (brownfield); write to `generated/` |

## 12.2 Monorepo layout (bun workspaces)

The repo is a bun workspaces monorepo (`"workspaces": ["packages/*"]`); packages are
`@versailles/*`. Per ADR-0014 D3, the restructure to this layout landed in Phase 0:

```
versailles
├── packages/core/         ← grammar parser + validator (core/), joint loader (loader/), predicates (predicates/)
├── packages/engine/       ← deterministic generator + vitest/xUnit/pytest emitters (generator/)
├── packages/cli/          ← five-command machine-readable CLI (cli/)
├── packages/frontend-ts/  ← TypeScript manifest extractor (extractors/)
└── packages/ir/           ← VIR schema placeholder (Apache-2.0, scaffold-only; full schema deferred to D1 phase)
```

Root `src/index.ts` is the public package entry (`packageName` const). Per-package
licensing (core/engine/cli/frontend-ts MIT, `packages/ir` Apache-2.0) is recorded in
ADR-0015 (§15).

---

## 13. Build milestones (implementation order; roadmap phase sequence per ADR-0014)

1. **Grammar + parser** — standalone, unit-testable against hand-written `contracts.json`
   fixtures. No dependency on anything else.
2. **Loader/context object + semantic validator** — still against hand-written fixtures for
   `manifests.json` and the predicate map. Proves the cross-referencing logic.
3. **Deterministic generator (§9.1–9.2)** against hand-authored contracts, targeting one
   test framework. This is the core value proposition — prove it before adding complexity.
4. **Manifest extractor** for one language — replaces hand-written `manifests.json`.
5. **CI staleness check (`versailles check`)** — cheap to add once hashing is in place.
6. **Machine-readable CLI surface** — structured errors, stable JSON output, deterministic
   behavior CI and external tooling can consume, grounded on real manifests/predicates.
7. **Human review flow** — **retired by ADR-0012.** The in-tool review gate is removed;
   the git commit is the approval. Parser-sanity view folded into `validate --verbose`.
8. **Predicate registry tooling** — **superseded by ADR-0013.** The registration CLI
   (`register-predicate` / `verify-purity` / `remind-unverified`) is removed; predicates
   are declared inline in `contracts.json` and verified by `validate`.
9. **Roadmap phase sequence (per ADR-0014 / roadmap §16)** — after v1 (milestones 1–8) is
   proven end-to-end, the L3/L4 analysis engine proceeds through the roadmap phase
   sequence: **Phase 0** foundation (licensing/phase-0 sprint, current), then L3/L4 engine
   phases **1** Roslyn CFG viability spike, **2** D1 decision + VIR design, **3** CFG
   front-end (first VIR front-end), **4** branch coverage with contract oracle (L3),
   **5** spec-vs-code divergence report, **6** bounded path enumeration + incremental
   pruning (L4), **7** compositional summaries + memory model, **8** paid packaging +
   evidence layer. SMT-backed generation (§9.5) is a soundness requirement for this engine,
   not a stretch goal. The roadmap (external Llama plans / Obsidian) is the authoritative
   source for phase details.

---

## 14. Open decisions to pin down during implementation

| Decision | Recommended default |
|---|---|
| Type strictness in manifests for dynamically-typed languages | Permissive; low-confidence fields warn, don't block |
| Manifest extraction method | Static analysis only; the tool never invokes an LLM (ADR-0010) |
| Predicate purity enforcement | No gate — the predicate declaration (resolvable `sourceRef`) is the attestation; impurity surfaces as failing/hanging generated tests at runtime (ADR-0019) |
| Test framework target for v1 | Single framework, config-driven, chosen up front |
| Rejection idiom for precondition-violation tests | Configurable in `config.json`, default "throws" |
| Multi-language support | Manifest extractor pluggable per-language; grammar/validator/generator stay language-agnostic |
| Package/CLI naming | Package `versailles-dbc` (or scoped), CLI binary `versailles` via `bin` field |

---

## 15. Licensing

The licensing model is recorded in detail in
[ADR-0015](decisions/0015-licensing-and-contribution-model.md); this section is the
build-spec summary.

### 15.3 Per-package licensing layout

- `packages/core`, `packages/engine`, `packages/cli`, `packages/frontend-ts`: **MIT** —
  free tier (L0–L2), permanent.
- `packages/ir` (VIR schema): **Apache-2.0**.
- `versailles-pro` (L3/L4 advanced code-analysis + evidence layer): separate private
  repo — the commercial tier, not a relicensing of the core.

### 15.7 Planned bundled artifacts

Third-party artifacts planned to ship inside bundled packages are tracked in
`THIRD-PARTY-NOTICES.md` (root); their license notices must travel with any bundled
artifact when shipped.

Contributions require a CLA via **CLA Assistant** (cla-assistant.io) with templates
derived from the Apache ICLA v2.2 and Corporate CLA, adapted for Versailles per the
ASF's reuse permission (ADR-0016). The core-license commitment — the free tier stays
MIT permanently — is
published in [CONTRIBUTING.md](../CONTRIBUTING.md) and enforced by the per-package
layout above.

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-30 | general-manager | §3.1 version-gate text reconciled with ADR-0018 (Policy Foundation, VERSAILLES-168/169): removed `grammarVersion` / `schemaVersion` from the config example (replaced with a `$schema` pointer to `config.schema.json`) and rewrote the gate bullet to state the gates are removed — no version config fields, no file-level version fields, tool version in the binary (`versailles -v` / `--version`), additive-only format evolution, deprecate-don't-remove, tool-driven `migrate` policy; §3.2–3.4 `version` fields and seed-literal grammar-version references intentionally left for Phase 2 |
| 2026-08-30 | general-manager | Phase 2 sweep follow-through (VERSAILLES-168): dropped the legacy `"version": "1.0"` envelope from the §3.2/§3.3/§3.4 example snippets, reconciled the §2 layout comment and §6 loader responsibility #2 with ADR-0018 (no version gate; the loader no longer checks versions), and removed `VERSION_MISMATCH` from the §6 LoaderError code set; seed-literal grammar-version references (§3.1 `propertyBased.seed`, §9.6) remain deferred |
| 2026-08-29 | general-manager | §9.6 FIELD-BOUND layout (VERSAILLES-165 final rounds, Center B1/B2 + W1 + Fix-1/Fix-2): the sampling strategy becomes THREE joint-sampling strategies — the equality-mirror, the record + bounded filter, and the NEW FIELD-BOUND layout for a bothSideFieldRef equality with a manifest-FIELD operand (`f == p`, e.g. `status == newStatus`): op-params only, component instance bound, the field mapped to `instance.<field>` in the assertion, no mirror/record/filter; a field-referencing multi-param guard in the guard set makes only the descriptor whose OWN clause is the field-bound equality plannable (siblings are PROPERTY_UNPLANNABLE); `PROPERTY_UNPLANNABLE` now also covers a coupling referencing a manifest-field operand (Center B2), a coupling whose propagation yields inverted bounds (unsatisfiable region), and a zero-param field-field equality (`f1 == f2`) — the FIELD-BOUND layout has no arbitrary to sample — alongside the existing non-mirrorable equality, equality-of-sums, unboundable couplings, unrenderable oracles, and component-typed params |
| 2026-08-29 | general-manager | §9.6 joint sampling (VERSAILLES-165): the oracle-arity gate becomes a sampling-strategy routing — multi-param guard oracles are no longer blanket-unplannable; equality oracles (`p1 == p2` / `p1 === p2`, bothSideFieldRef) route to the equality-mirror strategy (emitted callback contains `const p2 = p1;` — no filter, zero filter sparsity) and coupled numeric compounds route to record + bounded filter (`fc.record({ a: ..., b: ... }).filter(({ a, b }) => <oracle>(a, b))`) with cross-param bounds derived from sum/difference leaves BEFORE any filter (`p1 + p2 <= C` with lower bounds L1, L2 → `p1 <= C − L2`, `p2 <= C − L1`; mirrored for `>=`/`>` with upper bounds) so the valid region stays healthy (~≥50%), never filter-sparse, never a hang; `PROPERTY_UNPLANNABLE` is retained only for genuinely unrepresentable shapes — unrenderable oracles, component-typed params, non-mirrorable equality (`!=`/`!==`, equality-of-sums `a + b == C`), unboundable couplings — and multi-param oracles are never emitted as a per-param `.filter` |
| 2026-08-29 | general-manager | §9.6 plannability gate corrected (B1 fix, feat/seeded-pbt-emission): the gate is now three checks — param representability (every operation param maps to an ArbitrarySpec kind), oracle renderability (the clause codegens to an inline predicate), and the NEW oracle arity gate (a guard oracle used to filter a satisfies/invariant-preserving block must be single-param); multi-param oracles (bothSideFieldRef postconditions like `status == newStatus`, coupled compound preconditions like `a >= 0 and b >= 0 and a + b <= 100`) are **unplannable** — fast-check's `.filter()` receives `undefined` for the 2nd+ params, all candidates are filtered, and the property hangs — so the clause surfaces `PROPERTY_UNPLANNABLE` (non-silent, exit 0, `CliResult.warnings`), the descriptor is skipped, the clause id stays a visible zero-coverage gap in `coverage.json`, and the strategy record still reports the selector's `property` choice; single-param compounds (e.g. `amount >= 10 and amount <= 100`) remain planned, runnable properties — the plan's filter-sparsity mitigation, honest signaling over broken/hanging properties |
| 2026-08-28 | general-manager | §3.1 config example gained the `propertyBased { enabled, numRuns, seed? }` block; new §9.6 Seeded PBT emission (ADR-0017): opt-in config, seed derivation (32-bit stable hash of block clause IDs + grammar version, explicit override), per-param arbitraries, clause-codegen'd oracles, strategy selection table, expected-rejection sweep replacement, unplannable warnings, emitter rollout (vitest/fast-check first) |
| 2026-08-21 | general-manager | §9/§12 now describe both `generate` entry points — contract-first (greenfield, contracts-only) and extract-first (brownfield, manifests required) — per ADR-0011 Neutral consequence |
| 2026-08-20 | general-manager | Corrected the overstated postcondition-satisfaction guarantee in §9.1 (Center review, PR fix/generator-postcondition-violation): satisfaction cases assert only the simple field-compare postconditions (`field op expr`) — predicate-call, both-side-fieldRef, and uncomputable clauses contribute no assertion (conservative skip; the case is still emitted and traced) — and void-returning instance operations assert instance state, not "the result"; the §9.4 canonical instance snippet now includes the captured pre-state seed line (`instance.<field> = <captured>;`) the emitter writes before the call |