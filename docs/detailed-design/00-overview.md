# DD-00 — Detailed Design: Overview

**Scope:** the MVP as cut in [06 — Feasibility and MVP §3](../06-feasibility-and-mvp.md), designed to component level. Every place an MVP component has to leave room for a v1.0 feature is marked **⟶ v1.0** with the feature ID.

**Status:** design for build. Type signatures in these documents are normative — code implements them as written, and a deliberate deviation updates the document in the same change.

---

## 1. Document set

| Doc | Component | Package |
|---|---|---|
| [DD-01](01-grammar-and-parser.md) | Lezer grammar, CST → AST, syntax diagnostics | `@sgl/core` |
| [DD-02](02-resolver-and-document-model.md) | Resolver, canonical document model, `.sgl.json` | `@sgl/core` |
| [DD-03](03-semantic-graph.md) | Compile to IR: nodes, edges, labels, IDs | `@sgl/core` |
| [DD-04](04-theme.md) | Style-property registry, theme schema, cascade, geometry/paint hashes, built-in themes | `@sgl/theme` |
| [DD-05](05-measurement.md) | `Measurer`, canvas implementation, pre-measure table, plain-text layout | `@sgl/measure` |
| [DD-06](06-layout-host-and-engines.md) | Worker protocol, host fallbacks, result validation, quantization, `elk` adapter, `grid` | `@sgl/layout-api`, `@sgl/layout-elk`, `@sgl/layout-std` |
| [DD-07](07-renderer.md) | SVG structure, shapes, arrowheads, text, IDs, escaping, accessibility, export | `@sgl/render-svg` |
| [DD-08](08-application.md) | State, pipeline orchestration, editor, canvas, persistence, files, share, PWA | `apps/web` |
| [DD-09](09-security-performance-testing.md) | Threat model, budgets and where they are spent, test matrix, corpus | cross-cutting |
| [DD-10](10-build-and-deploy.md) | Monorepo, package builds, Lezer generation, Cloudflare deploy, CI | cross-cutting |
| [DD-11](11-text.md) | **⟶ v1.0 (A18)** markdown in labels: the inline subset, `"""` strings, styled runs, run faces, line breaking at `maxWidth`, nested `<tspan>`s. Phase 2: branches 1 (grammar) and 2 (text model) implemented, 3 (render) to come | `@sgl/text` (new), `@sgl/core`, `@sgl/measure`, `@sgl/render-svg`, `apps/web` |

---

## 2. Module map and dependency direction

```
                       apps/web          Preact + signals · CodeMirror 6 · Vite
        ┌──────────┬──────┴────┬──────────────────────┐
        ▼          ▼           ▼                      ▼
   render-svg   measure    layout-api  ◄───  layout-elk, layout-std
        │          │           │                (engines implement the api)
        └────┬─────┘           │
             ▼                 │
           text                │      runs, faces, the table key, line models (A18, DD-11)
             │                 │
             ▼                 │
           theme               │
             │                 │
             └────────┬────────┘
                      ▼
                    core                Lezer parser · resolver · IR · diagnostics;
                                        no runtime dependencies but @lezer/common and the generated parser
```

The edges, as `eslint.config.js` enforces them (`A ← B`: B may import A):

```
core  ←  theme, layout-api
core, theme  ←  text
core, theme, text  ←  measure, render-svg
core, layout-api  ←  layout-elk, layout-std
everything  ←  apps/web
```

Rules, enforced by `eslint-plugin-import` boundaries in CI:

1. `core` imports nothing from the workspace.
2. `theme` and `layout-api` import only `core`. `text` imports `core` and `theme` (its `labelRuns`
   reads a `StyledGraph`). `measure` and `render-svg` import `core`, `theme` and `text`: DD-05 takes a
   `StyledGraph`, DD-07 a `StyledGraph` and a `ResolvedTheme`, and both key the measure table with
   `text`'s one key function (DD-11 T2). *(Corrected by A18, DD-11 §19 item 1: this rule said the
   four packages "import only core", which `measure` and `render-svg` importing `theme` had not
   matched since the MVP.)*
3. Engines import only `layout-api` and `core`.
4. `apps/web` is the only package that touches the DOM, except `measure`'s canvas implementation, which is isolated behind an interface.
5. No package other than `apps/web` may import `preact`.

---

## 3. Conventions

### Types

- All cross-package data is **plain JSON-compatible objects** — no classes, no `Map` in public types (internally fine). This is what lets everything cross the worker boundary by `structuredClone` and land in `.sgl.json` unchanged.
- Public types are `readonly`. Producers build with mutable locals and return frozen (`Object.freeze` in dev builds; a no-op in prod for speed).
- IDs are branded strings: `type NodeId = string & { __brand: 'NodeId' }`. Same for `EdgeId`, `LabelId`, `PortId`.

### Spans

```ts
interface SourceSpan { from: number; to: number; }   // UTF-16 offsets into the source string
```

Every AST node, every document-model entry, every IR node and edge, and every diagnostic carries one. Line/column are derived on demand by the editor from the offset; they are never stored.

### Diagnostics

```ts
interface Diagnostic {
  code: DiagnosticCode;          // 'SGL1001' — see the catalogue in each DD
  severity: 'error' | 'warning' | 'info';
  message: string;               // complete sentence, names the thing, says what to do
  span: SourceSpan;
  related?: readonly { span: SourceSpan; message: string }[];
}
```

Codes are allocated per stage: `1xxx` syntax · `2xxx` resolution · `3xxx` semantic · `4xxx` layout · `5xxx` theme · `6xxx` platform. Every code in these documents is listed once, with its message template, in the stage that emits it. Codes are never reused.

### Errors vs diagnostics

A stage **never throws** on bad input. It returns `{ value, diagnostics }` where `value` is the best partial result. A stage throws only on a programming error (violated invariant), and the application treats that as a crash to report, not a document problem.

### Hashing

`fnv1a64` over a canonical string. Used for edge IDs, geometry/paint hashes, cache keys, and generated class names. One implementation in `core/hash.ts`; the algorithm is part of the compatibility surface because edge IDs appear in exported SVG.

### Determinism rule

No `Math.random`, no `Date.now`, no iteration over object keys without sorting, no `Map` iteration order dependence in any package below `apps/web`. Lint rule `sgl/no-nondeterminism` bans the first two; the rest is code review plus the double-run test in DD-09.

---

## 4. Pipeline, as implemented

The nine conceptual stages of [Architecture §2](../03-architecture.md) collapse into six functions with one async boundary:

```ts
// @sgl/core — synchronous, pure
parse(source: string): ParseResult                          // DD-01
resolve(ast: Document): ResolveResult                       // DD-02
compile(model: DocumentModel): CompileResult                // DD-03

// @sgl/theme — synchronous, pure
resolveTheme(theme: ThemeDoc, registry): ResolvedTheme      // DD-04
styleGraph(graph, theme): StyledGraph                       // DD-04 — geometry + paint hashes per element

// @sgl/measure — main thread, sync after fonts are ready
premeasure(styled: StyledGraph, measurer): MeasureTable     // DD-05

// @sgl/layout-api — ASYNC, crosses into the worker
layout(host, engineId, styled, table, options, signal): Promise<LayoutResult>   // DD-06

// @sgl/render-svg — synchronous, pure
render(styled: StyledGraph, layout: LayoutResult, theme: ResolvedTheme): RenderResult   // DD-07
```

The application (DD-08) wires these as derived signals. Everything before `layout` runs synchronously on the main thread on every keystroke — the budget says it must complete inside ~15 ms for 500 nodes, which the pure-function design and no-DOM constraint make realistic. `layout` is debounced and abortable.

---

## 5. Requirement traceability (MVP)

| Requirement | Designed in | Verified by (DD-09) |
|---|---|---|
| FR-L1 JSON-superset syntax | DD-01 §2 | grammar corpus, JSON-document test |
| FR-L2, L3 containers / `@` config | DD-01 §2, DD-02 §3 | resolver goldens |
| FR-L4 infix edges, chains | DD-01 §2, DD-02 §5 | resolver goldens |
| FR-L5 path resolution | DD-03 §3 | compile goldens, unresolved-ref corpus |
| FR-L6 canonical `.sgl.json` | DD-02 §6 | round-trip property test |
| FR-L7 classes | DD-02 §4, DD-04 §4 | cascade goldens |
| FR-L11 spans everywhere | DD-00 §3, all | span-coverage assertion |
| FR-L12 error-tolerant parse | DD-01 §4 | malformed-input corpus |
| FR-Y1, Y3 engine interface, pure geometry | DD-06 §2 | conformance suite |
| FR-Y2 engines place labels/titles | DD-06 §2, §6 | elk adapter goldens |
| FR-Y4 worker, timeout, abort | DD-06 §3 | host tests |
| FR-Y7 determinism | DD-00 §3, DD-06 §5 | double-run test |
| FR-Y8 (subset) `elk`, `grid` | DD-06 §6, §7 | goldens |
| FR-T1–T5 themes, cascade, split | DD-04 | cascade goldens, hash tests |
| FR-T6 (subset) two themes | DD-04 §7 | gallery snapshot |
| FR-R1–R5, R9 SVG, export, IDs, a11y | DD-07 | SVG goldens, Inkscape/Figma manual check |
| FR-F1 open/save | DD-08 §7 | Playwright |
| FR-F5 URL share | DD-08 §8 | Playwright, size-cap unit test |
| FR-E1–E5, E8, E9 editor loop | DD-08 §3–§6 | Playwright |
| FR-P1–P3 static, offline, PWA | DD-08 §9, DD-10 | offline Playwright run |
| NFR-2 isomorphic core | DD-00 §2 rules | Node test run of core/theme/render |
| NFR-4 sandboxing (Worker level) | DD-06 §3 | host tests |
| NFR-5 no XSS | DD-07 §8, DD-09 §1 | injection corpus |

---

## 6. Outcomes

The MVP is done when the six acceptance criteria in [06 §3](../06-feasibility-and-mvp.md#mvp-acceptance) pass in CI and by hand, and when every component below reports its own exit criterion met:

| Component | Exit criterion |
|---|---|
| Parser | Every document in the corpus parses; every malformed document yields a partial tree and at least one `SGL1xxx` diagnostic with a correct span; the JSON subset corpus parses unchanged |
| Resolver | Canonical goldens match; `fromJson(toJson(x)) ≡ x` for the corpus |
| Compiler | Goldens match; every unresolved reference is a diagnostic and the remaining graph is intact |
| Theme | Both themes resolve with zero diagnostics; every property in the registry has an `affects`; hash tests pass |
| Measurement | Pre-measure covers 100% of labels in the corpus (zero worker RPC misses on the corpus) |
| Layout host | Timeout terminates and respawns; abort cancels in-flight; malformed engine output is rejected with `SGL4002` and the previous layout survives |
| `elk` adapter | Corpus lays out; labels and container titles come back from ELK, not the fallback |
| `grid` | Bitwise identical across two runs and across Chrome/Firefox |
| Renderer | Byte-identical goldens; a11y tree present; injection corpus produces no executable content |
| App | Six MVP acceptance criteria |
