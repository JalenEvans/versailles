# Contract Summary: Manifest Extraction

**Machine contract:** [manifest-extraction.contract.yaml](manifest-extraction.contract.yaml)
**Spec:** [docs/specs/manifest-extraction.md](../specs/manifest-extraction.md)
**Status:** draft · **Validated:** pass

## What this context does

Manifest extraction builds the **grounding layer** of the pipeline — `manifests.json` — from
real source code. Every field type a contract can reference comes from here, so correctness is
paramount: nothing is invented. TypeScript is extracted first via the compiler API
(`ts.createProgram` + type checker); C# and Python extractors plug into the same seam later.

## What it guarantees (must)

- Field types resolve to the `typeRef` grammar: generics become `list<T>`, literal unions
  become `enum<...>`, and nested types are added transitively so `order.items[].sku` resolves.
- `sourceHash` is computed from **sorted field name+type pairs only** — editing a method body
  never changes it; adding/removing/retyping a field does.
- Low-confidence or inferred fields **warn but never block** (permissive typing policy).
- Entries for components not covered by a scan are preserved; removal happens only via the
  explicit `--prune` flag.
- Scanning stays within `config.sourceRoots`; all extraction is static analysis, with any
  externally-authored manifest content verified against real source before writing.

## What it forbids (must not)

- No hand-authored-source-of-truth treatment of manifests; no full-file hashing.
- No implicit pruning; no scanning outside source roots.
- No LLM invocation inside the tool — no client, prompting, or retry loop.
- No hard type errors caused purely by inference uncertainty; no language-specific code in
  the core (everything lives behind the extractor plugin seam).

## Grounding

[build-spec §3.3, §7](../build-spec.md) · ADR-0004 (permissive typing) · ADR-0005 (static
analysis first) · ADR-0008 (pluggable seams) · ADR-0009 (TS first) · ADR-0010 (no in-tool LLM)