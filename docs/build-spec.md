# Versailles — Build Specification

Deterministic test generation from Design-by-Contract specifications, with a machine-readable
CLI surface an external LLM/agent can drive for contract authoring, and human-in-the-loop approval.

**Naming:** package name `versailles-dbc` (or scoped `@<org>/versailles`) on npm — the bare
name `versailles` is already registered (unmaintained placeholder). CLI command name is
`versailles`, decoupled from the package name via the `bin` field in `package.json`:

```json
{
  "name": "versailles-dbc",
  "bin": { "versailles": "./dist/cli.js" }
}
```

---

## 1. Goals and non-goals

**Goals**
- Contracts (invariants, preconditions, postconditions) are the single source of truth for
  test generation.
- Test *generation* from an approved contract is 100% deterministic — same contract in,
  same test suite out, no LLM involved at generation time; no LLM is invoked anywhere in
  the tool.
- LLM-assisted *authoring* is external-agent driven: an LLM/agent calls the CLI
  (`validate`, `check`, …), reads structured errors, fixes, and re-runs — the CLI never
  prompts, calls, or retries an LLM itself.
- Contracts are auditable: every contract clause traces back to a specific source hash,
  and every generated test traces back to a specific contract clause.

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
├── config.json          # tool config: grammar version, source globs, generator target
├── contracts.json        # component contracts (invariants + operations), keyed by component name
├── manifests.json        # field manifests per component/type, derived from source
├── predicates.json       # named predicate registry
└── generated/             # deterministic generator output (test files)
    └── <component>/<operation>.test.<ext>
```

All four top-level files are versioned together and must be loaded as a single unit — no
file is valid to interpret in isolation because contracts reference manifests and
predicates by name.

---

## 3. File schemas

### 3.1 `config.json`

```json
{
  "grammarVersion": "1.0",
  "schemaVersion": "1.0",
  "sourceRoots": ["src/**/*.ts"],
  "language": "typescript",
  "testFramework": "vitest",
  "generatedDir": ".versailles/generated",
  "staleness": {
    "blockOnStale": true
  }
}
```

- `grammarVersion` / `schemaVersion`: checked by every tool (parser, validator, generator)
  before processing; mismatch is a hard error with an upgrade-path message, not a silent
  best-effort parse.
- `sourceRoots`: glob patterns the manifest extractor scans.
- `language`: selects the manifest extractor plugin (see §7).
- `testFramework`: selects the generator's output emitter (see §9).
- `staleness.blockOnStale`: whether CI fails on detected drift (see §8) or only warns.

### 3.2 `contracts.json`

```json
{
  "version": "1.0",
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
  "version": "1.0",
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
- Generated by static analysis (§7); an external agent may update manifests via the CLI,
  but the tool never invokes an LLM — anything written here must be verified against
  actual source.

### 3.4 `predicates.json`

```json
{
  "version": "1.0",
  "predicates": {
    "<predicateName>": {
      "params": ["<paramName>"],
      "paramTypes": ["<typeRef>"],
      "returnType": "boolean",
      "sourceRef": "<Module.functionName>",
      "sourceHash": "<hash of function implementation>",
      "verifiedPure": true
    }
  }
}
```

- `verifiedPure` is a manually-set flag (checked once at registration via lint/manual
  review) asserting the referenced function has no side effects and always terminates.
  The validator treats `verifiedPure: false` or missing as a hard error — unverified
  predicates cannot be referenced in contracts.

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

- Errors are structured objects, not strings, so downstream consumers (external agents,
  review UI, CI) can render or re-inject them programmatically.
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
| Predicate exists | Called name exists in `predicates.json` | Hard |
| Predicate arity | Number of args matches `predicates.json[name].params.length` | Hard |
| Predicate arg types | Each arg's resolved type matches `predicates.json[name].paramTypes[i]` | Hard |
| Predicate verified pure | `predicates.json[name].verifiedPure === true` | Hard |
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

- Hard errors block the contract from entering `contracts.json` — surfaced to the
  authoring agent as structured output — or block CI (in the lint flow).
- Warnings are surfaced but non-blocking.

---

## 6. `.versailles/` loader / context object

A single shared module used by every other component (agent-facing CLI commands, review UI,
CI lint, generator) — no component re-implements loading or cross-referencing independently.

**Responsibilities:**
1. Read and JSON-parse all four files.
2. Check `config.grammarVersion` / `schemaVersion` against the tool's supported versions;
   hard-fail with an explicit upgrade message on mismatch.
3. Parse every `expr` string in `contracts.json` into an AST, collecting structured parse
   errors.
4. Run the semantic validator against the full context, collecting structured semantic
   errors/warnings.
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
6. Expose a scoped-extraction helper: given a component/operation name, return just that
   sub-object plus its errors — used by the human review UI so reviewers see a scoped diff,
   not the whole file.

The loader never throws on malformed input — missing files, invalid JSON, valid-JSON/wrong-shape
files, and malformed expressions all produce structured errors (`LoaderError` codes
`VERSION_MISMATCH` | `MISSING_FILE` | `INVALID_JSON` | `CONFIG_INVALID` | `INVALID_SHAPE`, with
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
3. Recompute `sourceHash` for every manifest entry, predicate, and contract operation from
   current source; compare against stored hash.
4. On mismatch:
   - If `config.staleness.blockOnStale === true`: hard fail with a list of stale IDs.
   - Else: emit a warning report (e.g. as a CI annotation) but exit 0.
5. Exit codes: `0` clean, `1` parse/validation error, `2` staleness violation (when
   blocking) — distinct codes so CI pipelines can branch behavior if desired.

---

## 9. Deterministic test generator

CLI subcommand: `versailles generate` — only runs against a context where `isValid: true`.

### 9.1 Per-operation test cases (from preconditions/postconditions)

For each operation:
- **Boundary values**: for every numeric comparison in preconditions (`x >= 0`, `x < 100`),
  generate cases at the boundary, boundary−1, boundary+1.
- **Equivalence partitions**: for every `in` clause or enum-typed field, generate one case
  per partition member plus one case outside the set.
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
  generate a case and assert every postcondition clause holds on the result, resolving
  `old(field)` against captured pre-call state.

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
  = new <Component>(); instance.<op>(...); expect(instance.<field>)...` — so assertions
  target instance state, never the void return value (VERSAILLES-26). For a **static**
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

### 9.5 v2 stretch: SMT-backed generation

- Translate the AST (§4.3) to SMT-LIB, use Z3 to synthesize precise satisfying/violating
  witnesses instead of heuristic boundary values, particularly valuable for compound
  boolean preconditions where heuristic partition generation misses interaction cases.
- Design the AST and grammar now to keep this translation mechanical later (already true
  given the grammar's restricted, side-effect-free shape).

---

## 10. Machine-readable CLI surface for agent control

The CLI is a tool an external LLM/agent can *control* — the tool itself never drives an LLM.

1. An external LLM/agent authors contract objects (one component or one operation, not a
   full file rewrite) conforming to the `contracts.json` schema, using only fields/predicates
   present in the provided context.
2. The agent runs `versailles validate` / `versailles check` against its output.
3. The CLI responds deterministically with structured errors (stable JSON output, exit codes
   `0`/`1`/`2`) — no prompting, no retry loop, no LLM invocation anywhere in the tool.
4. The agent reads the structured errors, fixes the contract objects, and re-runs; the
   iteration contract is between the agent and the CLI's machine-readable output, not a
   loop inside the tool.
5. On success, the validated object proceeds to human review (§11), where approval merges
   the single object into `contracts.json` — never a full-file rewrite.

---

## 11. Human review

- Review UI (could be a CLI diff view or a simple web UI) shows:
  - The scoped sub-object (component or operation) via the §6 loader's extraction helper —
    never the whole file.
  - Raw `expr` strings alongside their parsed/normalized AST (pretty-printed) as a
    parser-sanity check.
  - Any validator warnings (non-blocking) for reviewer awareness.
- On approval: merge the single contract object into `contracts.json` programmatically
  (read-modify-write of just that key), never a full-file LLM rewrite.
- No `approvedBy`/`approvedAt` fields in the schema — git blame/commit history is the audit
  trail (per earlier decision).

---

## 12. CLI command surface (summary)

| Command | Purpose |
|---|---|
| `versailles init` | Scaffold `.versailles/` with empty/default files |
| `versailles extract-manifests` | Run manifest extractor, update `manifests.json` |
| `versailles validate` | Run parser + semantic validator across all of `contracts.json`, print structured report |
| `versailles check` | CI-mode: validate + staleness check, proper exit codes |
| `versailles generate` | Run deterministic test generator, write to `generated/` |
| `versailles review <component> [operation]` | Launch scoped review flow for a staged/pending contract (`--approve` merges the single object; `--reject` writes nothing) |
| `versailles register-predicate <name> --source <Module.functionName>` | Register/update one predicate entry with mechanically verified `sourceRef`/`sourceHash`; `--verifiedPure` is the human registration gate |
| `versailles verify-purity <name>` | Flip `verifiedPure` true for a registered predicate after manual lint (never recomputes `sourceRef`/`sourceHash`) |
| `versailles remind-unverified` | Report predicates with `verifiedPure` missing/false; never writes |

---

## 13. Build milestones (implementation order; 1–8 shipped, 9 is v2 stretch)

1. **Grammar + parser** — standalone, unit-testable against hand-written `contracts.json`
   fixtures. No dependency on anything else.
2. **Loader/context object + semantic validator** — still against hand-written fixtures for
   `manifests.json`/`predicates.json`. Proves the cross-referencing logic.
3. **Deterministic generator (§9.1–9.2)** against hand-authored contracts, targeting one
   test framework. This is the core value proposition — prove it before adding LLM
   complexity.
4. **Manifest extractor** for one language — replaces hand-written `manifests.json`.
5. **CI staleness check (`versailles check`)** — cheap to add once hashing is in place.
6. **Machine-readable CLI surface for agent control** — structured errors, stable JSON
   output, agent-iteration contract (agent writes contract objects, calls validate/check,
   reads structured errors, fixes, re-runs), grounded on real manifests/predicates.
7. **Human review flow** (scoped diff view, merge-on-approve) — shipped.
8. **Predicate registry tooling** — registration CLI, purity-check reminder workflow — shipped.
9. **SMT-backed generation (v2 stretch)** — only after v1 pipeline is proven end-to-end.

---

## 14. Open decisions to pin down during implementation

| Decision | Recommended default |
|---|---|
| Type strictness in manifests for dynamically-typed languages | Permissive; low-confidence fields warn, don't block |
| Manifest extraction method | Static analysis only; an external agent may author manifests via the CLI — the tool never invokes an LLM |
| Predicate purity enforcement | Manual lint/review at registration time only |
| Test framework target for v1 | Single framework, config-driven, chosen up front |
| Rejection idiom for precondition-violation tests | Configurable in `config.json`, default "throws" |
| Multi-language support | Manifest extractor pluggable per-language; grammar/validator/generator stay language-agnostic |
| Package/CLI naming | Package `versailles-dbc` (or scoped), CLI binary `versailles` via `bin` field |