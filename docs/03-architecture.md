# SGL — System Architecture

---

## 1. The central idea

Three concerns, kept rigorously apart:

| Concern | Owns | Never knows about |
|---|---|---|
| **Semantic graph** | What exists and what connects to what | Pixels, colours |
| **Layout engine** | Where everything goes, including labels and arrow paths | Colours, fonts-as-appearance, SVG |
| **Theme + renderer** | What it looks like | Positions (it is handed them) |

Every plugin boundary in the system is a boundary between two of these. If a change to one requires a change to another, the separation has leaked.

---

## 2. Pipeline

```
  .sgl text ──┐
              ├─► [1] Lex ─► [2] Parse ─► AST (+ spans, + diagnostics)
  .sgl.json ──┘                              │
                                             ▼
                            [3] Resolve  (imports, vars, classes, defaults)
                                             │
                                             ▼
                                    Document Model (canonical)
                                             │
                                             ▼
                            [4] Compile ─► Semantic Graph (IR)
                                             │
                     ┌───────────────────────┴──────────────┐
                     ▼                                      ▼
        [5] Theme resolve (METRICS half)          (paint half deferred)
                     │                                      │
                     ▼                                      │
        [6] Measure  (labels, intrinsic sizes)              │
                     │                                      │
                     ▼                                      │
        [7] LAYOUT ENGINE  ── sandboxed, pluggable          │
                     │                                      │
                     ▼                                      ▼
                  Layout Result ───────► [8] Theme resolve (PAINT half)
                                             │
                                             ▼
                                     [9] SVG Renderer
                                             │
                          ┌──────────────────┼──────────────────┐
                          ▼                  ▼                  ▼
                     SVG string        Live DOM +          PNG / PDF
                    (export, CI)    interaction layer
```

### Why the theme split matters

Stage 5 resolves only what changes *geometry*. Stage 8 resolves everything else.

**The split is declared per property, not decided per theme author.** Every style property carries an
`affects` flag in the central property schema:

```ts
interface StyleProperty { name: string; affects: 'geometry' | 'paint'; }
```

The cascade resolver partitions each element's resolved properties on that flag and computes **two
hashes** — a geometry hash and a paint hash. Layout invalidates on a geometry-hash change; the
renderer alone re-runs on a paint-hash change.

This has to be mechanical rather than editorial, because several properties look like paint and are
not: `strokeWidth` changes outer bounds and therefore container packing; `radius` moves the edge
attachment point on a rounded shape; a `fontSize` override changes label size and therefore node
size; `padding` on a class changes a container's content frame. Leaving the classification to
judgement produces silently overlapping nodes, and a newly added property cannot land on the wrong
side if it is required to declare itself.

Consequence: **swapping a paint-compatible theme re-runs stage 8 and 9 only** — no re-measure, no re-layout. Dark mode toggles in one frame. This is the difference between a theme system that feels instant and one that reflows the whole diagram.

### Incremental re-render

**Not built in the MVP.** The MVP is debounce plus a full re-run; for a 50-node graph the whole
pipeline is well inside the 60 ms budget without caching (06 §4, pitfall 6). Because every stage is a
pure function of its input, memoisation can be added per stage later, locally, when a measured budget
is actually missed. When it is, each stage keys on a content hash of its input:

| Edit | Cheapest correct restart point |
|---|---|
| Change a fill colour | Stage 8 |
| Toggle light/dark (same typography) | Stage 8 |
| Change a label's text | Stage 6 (re-measure one label) then 7 |
| Change font family | Stage 5 |
| Add a node or edge | Stage 4 |
| Change layout option | Stage 7 |
| Any text edit | Stage 1, but stages 3–7 hit cache for untouched subtrees |

---

## 3. Package layout (pnpm monorepo)

```
packages/
  core/          @sgl/core          lexer, parser, AST, resolver, IR, diagnostics
                                    ZERO dependencies. Zero DOM. The contract everything else obeys.
  layout-api/    @sgl/layout-api    engine interface, registry, worker host, conformance suite
  layout-elk/    @sgl/layout-elk    DEFAULT engine: elkjs adapter (ADR-0005). Lazy-loaded chunk;
                                    excluded from the core bundle budget.
  layout-std/    @sgl/layout-std    grid (MVP), then fixed, tree, radial, force. In-house
                                    `layered` is roadmap, not v1.
  theme/         @sgl/theme         token model, cascade, built-in themes, theme validation
  measure/       @sgl/measure       Measurer interface + font-metrics / canvas / offscreen impls
  text/          @sgl/text          inline text layout: styled runs, line breaking, compartments
                                    -> positioned tspans. No foreignObject, so this is ours to own.
  render-svg/    @sgl/render-svg    LayoutResult + ResolvedTheme -> SVG
  plugin-sdk/    @sgl/plugin-sdk    types + test harness + scaffolder for third parties
  cli/           @sgl/cli           render, fmt, lint, watch
  lsp/           @sgl/lsp           language server (editor integrations)
apps/
  web/                              the SPA (Preact + signals, CodeMirror 6, Vite) — see 06 §5
  worker/                           Cloudflare Worker: render API, share links, OG images
  docs/                             docs site with live playground
```

Dependency direction is strictly downward: `core` knows nothing about layout; `layout-*` knows nothing about rendering; `render-svg` knows nothing about the app.

---

## 4. Layout engine plugin API

### 4.1 What an engine is

```ts
export interface LayoutEngine {
  readonly id: string;              // 'org.example.rack-layout'
  readonly name: string;
  readonly version: string;         // semver
  readonly apiVersion: 1;           // the LayoutEngine contract version

  readonly capabilities: {
    containers: boolean;            // can lay out nested compound graphs
    edgeRouting: 'straight' | 'orthogonal' | 'spline' | 'custom';
    ports: boolean;
    labelPlacement: boolean;        // false => host applies default label placement
    incremental: boolean;           // can accept a previous result as a hint

    /** Reproducibility class — see ADR-0004. Keys the render cache, selects which
     *  engines join the cross-environment golden test, and is surfaced in the picker. */
    determinism: 'bitwise' | 'quantized' | 'best-effort';
  };

  readonly optionsSchema?: JSONSchema7;   // drives validation AND the settings UI
  /** Engine-specific `@layout.*` hint keys. Declared so hints get validation,
   *  autocomplete and generated docs instead of being undocumented magic strings. */
  readonly hintsSchema?: JSONSchema7;
  readonly defaults?: Record<string, unknown>;

  layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult>;
}
```

`capabilities` lets the host fill gaps rather than reject an engine. An engine that only places nodes (`labelPlacement: false`, `edgeRouting: 'straight'`) is perfectly valid — the host runs default label placement and straight-line routing over its output. **This is the main thing that makes writing an engine approachable.**

### 4.2 What it receives

```ts
export interface LayoutInput {
  readonly graph: SemanticGraph;   // frozen; the subtree this engine owns
  readonly scope: NodeId | null;   // null = whole document
}

export interface SemanticGraph {
  readonly root: NodeId | null;
  readonly nodes: ReadonlyMap<NodeId, GraphNode>;
  readonly edges: readonly GraphEdge[];
  readonly order: readonly NodeId[];   // deterministic traversal order
}

export interface GraphNode {
  readonly id: NodeId;              // 'payments.api'
  readonly parent: NodeId | null;
  readonly children: readonly NodeId[];
  readonly shape: ShapeId;
  readonly labels: readonly LabelSpec[];   // node title, sub-label, badges
  readonly ports: readonly PortSpec[];
  readonly sizing: {
    readonly intrinsic: Size;       // measured content size, already computed
    readonly padding: Insets;       // from theme; container content inset
    readonly min?: Partial<Size>;
    readonly max?: Partial<Size>;
    readonly fixed?: Partial<Size>; // author set @size.width/height
    readonly aspectRatio?: number;
  };
  readonly pin?: Point;             // author-pinned; engines MUST honour
  readonly hints: Readonly<Record<string, unknown>>;  // @layout.* bag
  readonly classes: readonly string[];
}

export interface GraphEdge {
  readonly id: EdgeId;
  readonly from: Endpoint;          // { node, port?, side? }
  readonly to: Endpoint;
  readonly directed: 'forward' | 'backward' | 'both' | 'none';
  readonly labels: readonly LabelSpec[];  // main, head, tail
  readonly hints: Readonly<Record<string, unknown>>;
}

export interface LayoutContext {
  readonly options: Readonly<Record<string, unknown>>;  // schema-validated
  readonly metrics: ResolvedThemeMetrics;  // spacing scale, stroke widths, font metrics
  readonly measure: Measurer;              // for labels created during layout
  readonly random: () => number;           // SEEDED. Math.random is banned.
  readonly signal: AbortSignal;
  readonly previous?: LayoutResult;        // for incremental engines
  log(level: 'info' | 'warn' | 'error', message: string, nodeId?: NodeId): void;

  /** RESERVED in apiVersion 1. Delegates a subtree to another engine (per-container layouts).
   *  Published in v1 and implemented later: adding an optional context method is not a breaking
   *  change for engines, but declaring it now means engines written against apiVersion 1 stay
   *  valid when it lands, with no version bump. */
  sublayout(engineId: string, scope: NodeId, options?: object): Promise<LayoutResult>;
}
```

### 4.3 What it returns

```ts
export interface LayoutResult {
  readonly bounds: Rect;                       // diagram-space extents
  readonly nodes: Readonly<Record<NodeId, NodeLayout>>;
  readonly edges: Readonly<Record<EdgeId, EdgeLayout>>;
  readonly labels: readonly LabelPlacement[];
  readonly layers?: readonly LayerSpec[];      // explicit z-order groups
  readonly diagnostics?: readonly Diagnostic[];
}

export interface NodeLayout {
  readonly frame: Rect;              // absolute, diagram space
  readonly contentFrame?: Rect;      // container interior for children
  readonly ports?: Readonly<Record<PortId, { point: Point; normal: Vec2 }>>;
  readonly z?: number;
}

export interface EdgeLayout {
  readonly start: Point;
  readonly end: Point;
  readonly route: readonly PathSeg[];   // {t:'L'|'Q'|'C'|'A', ...} from `start`
  readonly startNormal?: Vec2;          // arrowhead orientation at the tail
  readonly endNormal?: Vec2;            // ...and the head
  readonly clip?: 'none' | 'shape';     // trim the route at node boundaries
  readonly z?: number;
}

export interface LabelPlacement {
  readonly labelId: LabelId;         // references a LabelSpec on a node or edge
  readonly frame: Rect;
  readonly align: 'start' | 'middle' | 'end';
  readonly baseline: 'top' | 'middle' | 'bottom';
  readonly rotation?: number;        // degrees; for along-edge labels
  readonly occlusion?: 'plate' | 'none';  // draw a background plate (edge labels)
  readonly priority?: number;        // higher survives collision culling
}
```

`LabelPlacement` is where "where titles are placed" lives, as required by FR-Y2. Container titles, node titles, edge labels, and port labels all flow through the same structure, so an engine can put a container title in the top-left, centred above, rotated down the left edge — whatever its design calls for.

### 4.4 Execution model

```
main thread                          sandbox
───────────                          ───────
build SemanticGraph
pre-measure every label
  │
  ├── structuredClone ─────────────► engine.layout(input, ctx)
  │                                       │
  │   ◄── RPC: measure(text, style) ──────┤  (cache miss only)
  │   ─── result ─────────────────────────►
  │                                       │
  │   ◄── RPC: sublayout(engine, scope) ──┤
  │   ─── LayoutResult ───────────────────►
  │                                       │
  ◄─── LayoutResult ──────────────────────┘
```

**Sandbox = a `sandbox="allow-scripts"` iframe with a null origin, hosting a Web Worker.** The iframe gives a fresh origin with no access to app storage or cookies; the worker gives no DOM and a killable thread; a restrictive CSP (`connect-src 'none'`) removes network access. Built-in, trusted engines skip the iframe and run in a plain Worker for lower overhead.

Enforcement:
- Hard timeout (default 10 s) — terminate the worker, surface `SGL4001`, keep the previous layout.
- `AbortSignal` fires on user edit so a superseded layout stops immediately.
- Result is validated against the schema before it is trusted: NaN/Infinity coordinates, unknown node IDs, and missing entries are rejected with a precise diagnostic. A buggy third-party engine must never be able to corrupt the renderer.

### 4.5 Built-in engines

| Engine | Algorithm | Good for |
|---|---|---|
| `elk` | elkjs adapter — ELK layered: compound, ports, orthogonal routing, label placement. [ADR-0005](adr/0005-default-engine-elkjs.md) | **Default.** Flows, architecture, dependencies |
| `layered` | In-house Sugiyama — **roadmap, not v1**. Future replacement for `elk` if a smaller bundle or tighter control is needed | — |
| `tree` | Reingold–Tilford (tidy trees), with compound support | Hierarchies, org charts, decision trees |
| `grid` | Deterministic row/column packing with spans | Dashboards, matrices, "just line them up" |
| `radial` | Concentric rings by depth | Ego networks, hub-and-spoke |
| `force` | Seeded Barnes–Hut n-body, then snap-to-grid for determinism | Undirected networks |
| `fixed` | Honours `@pin` and `@size` exactly; errors on unpinned nodes | Hand-placed diagrams, generated coordinates |

`layered` is also the reference implementation for third parties: it exercises every part of the API (containers, ports, label placement, orthogonal routing, sublayout delegation).

### 4.6 Conformance suite

`@sgl/plugin-sdk` ships a golden-file test harness: ~40 graphs (empty, single node, deep nesting, self-loops, multi-edges, disconnected components, 1 000 nodes, pathological aspect ratios). An engine passes if it returns geometry that is schema-valid, non-overlapping where it claims to be, deterministic across two runs, and finishes inside budget. Determinism is checked by running twice and diffing.

---

## 5. Theme system

> **Superseded in detail by [DD-04](detailed-design/04-theme.md).** The `metrics` / `paint` sections in the sketch below are replaced by a flat theme document plus a style-property registry that carries the `affects: geometry | paint` classification. The ideas here stand; the document shape does not.

### 5.1 Structure

```jsonc
{
  "id": "acme-dark",
  "name": "Acme Dark",
  "extends": "neutral-dark",
  "schemaVersion": 1,

  // ---- METRICS: changing these invalidates layout -------------------
  "metrics": {
    "typography": {
      "family": "Inter, system-ui, sans-serif",
      "fallbackMetrics": "inter-v13",      // see ADR-0003
      "scale":  { "title": 15, "body": 13, "edge": 11 },
      "weight": { "title": 600, "body": 400 },
      "lineHeight": 1.35,
      "letterSpacing": 0
    },
    "spacing":  { "nodePadding": [8, 12], "containerPadding": [28, 16, 16, 16] },
    "stroke":   { "node": 1.5, "edge": 1.5, "container": 1 },
    "minSize":  { "node": [72, 36] },
    "shapes":   { "hexagon": { "contentInset": ["0", "0.22w", "0", "0.22w"] } }
  },

  // ---- PAINT: changing these is a repaint only ----------------------
  "paint": {
    "tokens": {
      "bg":              "#0B0F19",
      "surface.base":    "#151B2B",
      "surface.raised":  "#1E2740",
      "surface.sunken":  "#0E1421",
      "ink.primary":     "#E6EAF2",
      "ink.muted":       "#9AA4BC",
      "line":            "#39445F",
      "accent":          "#7C8CFF",
      "danger":          "#FF6B6B"
    },
    "roles": {
      "container": { "fill": "@surface.sunken", "stroke": "@line", "radius": 10,
                     "title": { "fill": "@ink.muted" } },
      "node":      { "fill": "@surface.raised", "stroke": "@line",
                     "radius": 6, "label": { "fill": "@ink.primary" } },
      "edge":      { "stroke": "@line", "arrow": "triangle",
                     "label": { "fill": "@ink.muted", "plate": "@bg" } }
    },
    "byShape":   { "cylinder": { "fill": "@surface.base" } },
    "byClass":   { "Critical": { "stroke": "@danger", "strokeWidth": 2.5 } },
    "effects":   { "sketch": false, "shadow": "none" }
  },

  "shapes": {
    "hexagon": {
      "path": "M {0.22w} 0 L {w-0.22w} 0 L {w} {0.5h} L {w-0.22w} {h} L {0.22w} {h} L 0 {0.5h} Z",
      "anchor": "polygon"
    }
  },

  "fonts": [
    { "family": "Inter", "weight": 400, "src": "inter-400.woff2", "embed": "subset" }
  ]
}
```

### 5.2 Custom shapes without code

Shapes are **parameterised path templates**, not functions. `{w}`, `{h}`, and simple arithmetic on them are the only vocabulary. This buys a lot:

- A theme is pure data — safe to import from anywhere, no sandbox needed
- Shapes work identically in browser, Worker, and CLI
- `anchor` (`box` | `ellipse` | `polygon` | `path`) tells the router how to find the boundary intersection for edge attachment

Code-backed shape renderers are deliberately deferred; they would drag the sandbox problem into the theme layer.

### 5.3 Token references and cascade

`"@accent"` resolves against `paint.tokens`. Cycles and unknown tokens are `SGL5xxx` diagnostics. The full cascade is in the language spec §6; the renderer applies it once, producing a flat `ComputedStyle` per element.

In the SVG output, identical styles share one generated class, so the exported file is small (no repeated per-element paint attributes). Generated rules carry **literal** resolved values, not `var()`, so the file renders the same in tools that ignore custom properties; the theme tokens are also emitted as custom properties, in a **separate** trailing `<style>` element, because some tools (Inkscape 1.2) discard a whole style element they cannot parse rather than one rule (F17). A paint-only theme change is a full re-render, not a CSS rewrite (F7). Detail: DD-07 §6.

---

## 6. Measurement

The most under-appreciated correctness problem in this system. Layout depends on text size; text size depends on font rasterisation; rasterisation differs between browsers and does not exist at all in a Cloudflare Worker.

Because markdown labels (A18) are Must and `<foreignObject>` is banned (D9), a label is not a
string — it is a sequence of **styled runs** that must be broken into lines and positioned by us.
The measurement interface is therefore run-based, not string-based:

```ts
export interface TextRun {
  text: string;
  style: TextStyle;            // family, size, weight, italic, letterSpacing
  kind?: 'text' | 'code' | 'link';
}

export interface Measurer {
  /** Lay out runs inside a width constraint. Sync; served from the pre-measured table. */
  layoutRuns(runs: readonly TextRun[], box: BoxConstraints): TextLayout;
  layoutRunsAsync(runs: readonly TextRun[], box: BoxConstraints): Promise<TextLayout>;
  has(runs: readonly TextRun[], box: BoxConstraints): boolean;
}

/** Line boxes, baselines, and per-run x-offsets — enough for the renderer to emit tspans
 *  and for the layout engine to know the label's intrinsic size. */
export interface TextLayout {
  size: Size;
  lines: readonly { baseline: number; runs: readonly PositionedRun[] }[];
}
```

A plain single-style label is the degenerate case of one run, so nothing is made harder for the
common path. This shape must be settled **before the layout engine contract is frozen**, because
node intrinsic sizes come out of it.

Implementations:

| Impl | Where | Notes |
|---|---|---|
| `FontMetricsMeasurer` | everywhere | **Default from phase 3** (with the Worker render API). Precomputed per-font glyph advance tables + kerning pairs, shipped as compact binary. Identical everywhere. |
| `CanvasMeasurer` | browser main thread | **MVP default.** `ctx.measureText`, pre-measured into a table and shipped to the layout worker. Platform-dependent — acceptable while there is no server render to disagree with. See [06 §4 pitfall 2](06-feasibility-and-mvp.md). |
| `OffscreenMeasurer` | Web Worker | `OffscreenCanvas`. Same caveat. |

Default is the pure-JS one precisely because NFR-1 (determinism) and NFR-3 (browser/server agreement) are worth more than sub-pixel fidelity. See [ADR-0003](adr/0003-deterministic-text-measurement.md).

Labels are pre-measured in bulk on the main thread before layout starts, and the resulting table is shipped into the sandbox — so the common path needs no RPC at all.

---

## 7. SVG renderer

### Output structure

```svg
<svg viewBox="0 0 840 520" role="img" aria-labelledby="t d"
     xmlns="http://www.w3.org/2000/svg">
  <title id="t">Checkout Flow</title>
  <desc id="d">12 nodes, 14 connections, 3 groups</desc>
  <style>:root{--accent:#7C8CFF;...} .n{...} .e{...}</style>
  <defs><marker id="a-tri">...</marker></defs>

  <g class="layer-containers"> ... </g>
  <g class="layer-edges">      ... </g>
  <g class="layer-nodes">
    <g id="n-payments.api" class="n n--Service" role="group" aria-label="API">
      <path class="n__shape" d="..."/>
      <text class="n__label" x="..." y="...">API</text>
    </g>
  </g>
  <g class="layer-labels">     ... </g>
</svg>
```

Guarantees:

- **Stable IDs.** `n-<path>` / `e-<hash-of-endpoints-and-index>`. Reordering the source does not churn IDs, so exported SVGs diff cleanly in git.
- **Layer order is explicit**, not accidental. Containers behind, edges next, nodes, then labels on top.
- **Self-contained.** Fonts embedded as subsetted base64 WOFF2 (or a declared fallback stack if the user opts out for size). No external URLs.
- **Escaped.** All text goes through XML escaping; `@link` values are scheme-allowlisted; IDs are sanitised.
- **No `<foreignObject>`** on the default path — it breaks Inkscape, breaks CLI rasterisers, and reintroduces measurement nondeterminism.

### Interaction layer

The live view wraps the export tree in a host `<svg>` that adds a pan/zoom transform group and an overlay `<g>` for selection outlines, hover highlights, and drag handles. **Export serialises only the inner tree**, so what you get in a file is exactly the diagram, with no editor artefacts.

### Rasterisation

PNG in-browser: serialise SVG to a blob URL, draw into a canvas at the requested scale, `toBlob`. Fonts must be embedded first or glyphs fall back. PDF is deferred (see backlog) — `svg2pdf.js` is the likely route.

---

## 8. Web application

```
┌──────────────────────────────────────────────────────────────┐
│ toolbar: file · engine ▾ · theme ▾ · export ▾ · share        │
├────────────────────────┬─────────────────────────────────────┤
│ CodeMirror 6           │  canvas (pan/zoom/minimap)          │
│  · SGL grammar (Lezer) │                                     │
│  · diagnostics         │  [ last good render stays visible   │
│  · path autocomplete   │    while the source is broken ]     │
│  · fold, bracket match │                                     │
│                        │                                     │
├────────────────────────┴─────────────────────────────────────┤
│ diagnostics panel · engine options (from optionsSchema)      │
└──────────────────────────────────────────────────────────────┘
```

State: a small store holding `{ source, documentModel, semanticGraph, layoutResult, theme, engineId, options, diagnostics, lastGoodRender }`. Pipeline stages are memoised; `lastGoodRender` is what guarantees FR-E4.

Persistence: OPFS for document bodies, IndexedDB for the index and per-document settings. Autosave on idle; crash recovery on load.

Workers: one long-lived pipeline worker runs stages 3–7 off the main thread; the sandbox worker runs the engine. The main thread only ever does editing, measurement, and DOM.

---

## 9. Cloudflare deployment

```
                     ┌───────────────────────────────┐
  browser ──────────►│ Cloudflare Pages / Workers    │  SPA + service worker
                     │ static assets                 │
                     └───────────────────────────────┘
                                   │
                     ┌─────────────▼─────────────────┐
                     │ Worker: api.sgl.dev           │
                     │  POST /v1/render              │──► KV  (render cache, by content hash)
                     │  POST /v1/share               │──► R2  (sources, bundles, assets)
                     │  GET  /v1/d/:id               │──► D1  (metadata, plugin registry)
                     │  GET  /v1/og/:id.png          │
                     │  GET  /v1/registry/*          │
                     └─────────────┬─────────────────┘
                                   │
                     ┌─────────────▼─────────────────┐
                     │ Durable Object: Room (later)  │  collab CRDT sync
                     └───────────────────────────────┘
```

| Cloudflare service | Used for | Notes |
|---|---|---|
| **Pages / Workers static assets** | SPA, service worker, engine & theme bundles | Immutable, content-hashed filenames |
| **Workers** | render API, share, OG images, registry | Same `@sgl/core` as the browser — one codebase |
| **KV** | render cache keyed by `hash(source+engine+theme+version)` | Renders are pure functions; cache hit rate should be very high |
| **R2** | diagram sources, `.sglpack` bundles, published themes/engines | Cheap, no egress fee |
| **D1** | share metadata, users, plugin registry index | Small relational surface only |
| **Durable Objects** | one per collaboration room; Yjs/Loro over WebSocket | Deferred; the architecture leaves room |
| **Turnstile + Rate Limiting** | protect public `/v1/render` | Render is CPU-bound and therefore abusable |
| **Cache API** | edge cache for `/v1/d/:id` and OG images | |

### Rendering server-side

The Worker runs the identical pipeline because `@sgl/core`, `@sgl/layout-std`, and `@sgl/render-svg` have no DOM dependency and measurement is pure JS. That is the payoff of NFR-2 and NFR-3 — CI, OG images, and embeds all reuse the browser code path, and their output matches byte for byte.

PNG server-side is the awkward one. Two options:
1. **`resvg-wasm`** in the Worker — fast, but fonts must be bundled as assets and WASM eats into the bundle limit.
2. **Cloudflare Browser Rendering** — accurate, slower, costs more.

Recommendation: `resvg-wasm` with a fixed set of bundled fonts for OG images; offer full-fidelity PNG client-side only.

### Constraints to design around

- Worker CPU time is bounded. Cap server-side render at ~1 500 nodes and return `413` with a clear message pointing at client-side render. The client is the primary path; the server is a convenience.
- WASM + JS bundle size limits mean `layout-elk` and heavyweight engines are **client-only**.

### Zero-backend sharing

`https://sgl.dev/#s=<deflate-raw + base64url of the source>` needs no Worker, no D1, no account, and works offline-to-offline. It should be the default share action, with "create short link" as the opt-in that actually stores data. Good for privacy (NFR-8) and good for cost.

### PWA

Service worker precaches the app shell, built-in themes, and the default engines; optional engines cache on first use. Because the whole pipeline is client-side, the offline experience is the *full* experience, not a degraded one. File handlers registered for `.sgl` / `.sgl.json` so the installed app can be the OS default for them.

---

## 10. Extension distribution

Engines and themes are npm-installable *and* loadable at runtime from a URL.

```
sgl-plugin.json
{
  "kind": "layout" | "theme",
  "id": "org.example.rack",
  "version": "1.2.0",
  "apiVersion": 1,
  "entry": "index.js",           // ESM, no bare imports
  "integrity": "sha384-...",
  "permissions": []              // must be empty in v1
}
```

Runtime loading requires: HTTPS, an integrity hash, explicit user confirmation on first load, and the sandbox from §4.4. The registry (D1 + R2) is just an index over these manifests — no proprietary format, and self-hosting a plugin is a first-class path.

---

## 11. Testing strategy

| Layer | Approach |
|---|---|
| Lexer/parser | Property-based round-trip: `parse(fmt(parse(x))) == parse(x)`; a corpus of malformed inputs that must produce diagnostics, never throw |
| Resolver | Golden canonical-JSON snapshots |
| Layout | Conformance suite (§4.6) + determinism double-run + overlap assertions |
| Theme | Every built-in theme renders the full shape/role gallery; contrast ratios asserted at WCAG AA |
| Renderer | Golden SVG snapshots, byte-exact; separate visual-regression via rasterised diff |
| Cross-env | **Same corpus rendered by browser, Node CLI, and Worker must be byte-identical.** This is the test that keeps NFR-1 honest. |
| App | Playwright: edit, break the syntax, confirm last-good-render persists, export, reopen |
| Perf | Benchmarks at 50/500/2 000 nodes gating CI against §4.1 budgets |

---

## 12. Delivery phases

> Component-level design for the MVP phase is in [`detailed-design/`](detailed-design/00-overview.md).

Set by the completed triage in [`04-feature-backlog.md`](04-feature-backlog.md), which is the
authority on scope. Must came out at 51 of 136 features, so Must spans two phases.

| Phase | Contents | Exit criterion |
|---|---|---|
| **0 — Spike** | Lexer, parser, IR, `grid` engine, minimal SVG out | The pipeline shape is right |
| **1 — MVP** | **elkjs** + `grid` behind one interface in a Worker, theme system with the `affects` partition and two themes, classes, direction, plain-text labels, accessible SVG with stable IDs, editor with live preview and last-good-render, autosave, URL-fragment share, installable and offline. Cut detailed in [06](06-feasibility-and-mvp.md) | Someone can write a real architecture diagram and share it |
| **1b — v1.0** (rest of phase-1 Must) | `@sgl/text` rich labels, variables, imports, two more themes, `fixed` engine | Someone can write a real architecture diagram and export it |
| **2 — Rest of Must** | `tree`/`radial`/`force`/`fixed` engines, capability negotiation, engine sandbox, `.sgl.json` round-trip, PNG and clipboard export, drag-and-drop, URL-fragment share, `.sglpack` bundles, multiple documents, PWA | It fits a real workflow, offline |
| **3 — Plugin surface** (Should) | Options UI, conformance suite, plugin SDK, ports, pinning, incremental layout, orthogonal routing, elkjs adapter, formatter, icon packs, custom shapes, font embedding, WCAG validation, CLI, Worker render API with KV cache and Turnstile, short links, GitHub Action, VS Code preview | Third parties can extend it |
| **4 — Model and UX** (Should) | One model many views, sequence diagrams, UML/ER shapes, legends, search and filter, keyboard navigation, visual diff, version history, presentation mode, example gallery, autocomplete, source mapping, Mermaid import, relative positioning, edge bundling | It has range |
| **5 — Could** | Pulled in as demand appears | — |

### Phase-1 design obligations for later features

Cheap to design in now, expensive to retrofit — so these constrain phase 1 even though they build later:

- **Stage 4 (IR compile) takes a view selector**, rather than assuming one graph per document — this is what makes "one model, many views" (I1) possible later.
- **`@order` applies to edges**, not just nodes — sequence diagrams (I3) need message ordering.
- **Labels are structured**, never a bare string — UML/ER compartments (I4) fall out of `@sgl/text`.
- **`ctx.sublayout()` is published in apiVersion 1**, implemented later (B8/B9).
- **Theme tokens carry semantic role information**, so contrast validation (C15) can know what is drawn on what.
