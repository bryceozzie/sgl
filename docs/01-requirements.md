# SGL — Requirements

**Structured Graphing Language.** A text-first diagramming platform: JSON-esque source in,
SVG out, with layout engines and themes as first-class plugins.

Status: draft for review. Nothing here is locked.

---

## 1. Product goals

| # | Goal | Why it matters |
|---|---|---|
| G1 | Author graphs as plain text that reads like structured data | Diffable, reviewable, generatable by tooling and LLMs |
| G2 | Nesting is the primary structural primitive | Real systems are hierarchies; D2 proved containers are the killer feature |
| G3 | Layout is swappable, not baked in | The single biggest complaint about Mermaid is "I cannot control the layout" |
| G4 | Appearance is swappable, not baked in | House styles, dark mode, print, accessibility variants |
| G5 | Runs entirely in the browser, offline | No server dependency for the core loop; PWA-ready from day one |
| G6 | Deterministic, reproducible output | Same input + same engine + same theme + same version = byte-identical SVG |

### Non-goals (v1)

- Freeform drawing / direct manipulation as the source of truth (the Excalidraw model). SGL is text-first.
- A general graph *database* or query language.
- Real-time multiplayer in v1 (designed for, not built for).
- Non-graph diagram types (Gantt, pie, timelines). Deliberately out of scope; see the backlog.

---

## 2. Personas

| Persona | Needs |
|---|---|
| **Ash — platform engineer** | Architecture diagrams in-repo, rendered in CI, reviewed in PRs. Cares about diffs and determinism. |
| **Priya — tech writer** | Consistent house theme across hundreds of diagrams. Cares about themes, exports, print. |
| **Sam — tool builder** | Generates SGL from a service catalogue. Cares about the JSON form and a stable API. |
| **Jo — layout researcher** | Wants a bespoke engine (e.g. a domain-specific rack or floorplan layout). Cares about the plugin SDK. |
| **Lee — casual user** | Opens the web app, pastes something, wants a picture. Cares about it not being broken. |

---

## 3. Functional requirements

### 3.1 Language and parsing

| ID | Requirement | Priority |
|---|---|---|
| FR-L1 | Parse a JSON-superset surface syntax: unquoted keys, optional commas, trailing commas, `//` and `/* */` comments, multi-line strings | Must |
| FR-L2 | A key with an object value declares a **container**; entries inside it are either **child nodes** or **configuration** | Must |
| FR-L3 | Configuration keys are lexically distinguishable from child names (no reserved-word collisions) — see ADR-0001 | Must |
| FR-L4 | Edges declarable at any scope with infix operators (`->`, `<-`, `<->`, `--`), including chains | Must |
| FR-L5 | Endpoint references resolve by path: relative, `..` parent, `/` root-absolute | Must |
| FR-L6 | Canonical round-trippable JSON document model (`.sgl.json`) — strict JSON, machine-friendly | Must |
| FR-L7 | Reusable node classes/templates with inheritance | Must |
| FR-L8 | Variables and substitution | Should |
| FR-L9 | `@import` of other SGL files, with cycle detection | Should |
| FR-L10 | Glob/selector-based bulk styling (`*.@style.stroke`) | Could |
| FR-L11 | Every AST node carries a source span for diagnostics and bidirectional source mapping | Must |
| FR-L12 | Parser is error-tolerant: produces a partial document plus diagnostics rather than throwing | Must |
| FR-L13 | Formatter (`sgl fmt`) producing canonical, stable formatting | Should |
| FR-L14 | Linter with configurable rules (orphan nodes, unresolved refs, duplicate labels) | Could |
| FR-L15 | Wildcard edge endpoints: `lane1.* -> switch` fans out to every child, `lane1.**` to every descendant, `lane1.cam*` to children matching a one-star name glob. A `*` or glob may be any path segment (`store*.api* -> payments.api`, human decision 2026-09-24); `**` final position only; expands to ordinary edges at compile | Must |

### 3.2 Layout

| ID | Requirement | Priority |
|---|---|---|
| FR-Y1 | Layout engines are plugins conforming to a published, versioned interface | Must |
| FR-Y2 | An engine controls node positions, node sizes, container bounds, edge routes, arrowhead orientation, **and label/title placement** | Must |
| FR-Y3 | Engines receive a read-only semantic graph plus a measurement service, and return pure geometry | Must |
| FR-Y4 | Engines run sandboxed (no DOM, no network) with a hard timeout and cancellation | Must |
| FR-Y5 | An engine may delegate a subtree to another engine (mixed layouts) | Should |
| FR-Y6 | Engines declare an options schema that drives both validation and the settings UI | Should |
| FR-Y7 | Engines are deterministic: any randomness comes from an injected seeded PRNG | Must |
| FR-Y8 | Ship built-ins: `layered`, `grid`, `tree`, `radial`, `force`, `fixed` | Must |
| FR-Y9 | Per-container engine selection (`@layout.engine` at any depth) | Should |
| FR-Y10 | Manual pinning of individual nodes that auto-layout must respect | Should |
| FR-Y11 | Third-party engines loadable from a URL, local file, or registry | Could |

### 3.3 Themes

| ID | Requirement | Priority |
|---|---|---|
| FR-T1 | Themes are declarative documents (JSON), not code | Must |
| FR-T2 | Token-based: primitives to semantic tokens to role styles | Must |
| FR-T3 | Themes split **metrics** (affect layout) from **paint** (do not), so paint-only changes skip re-layout | Must |
| FR-T4 | Theme inheritance (`extends`) and light/dark modes | Must |
| FR-T5 | Documented cascade: theme, then shape/type, then classes, then inline `@style` | Must |
| FR-T6 | Ship built-in themes (neutral light/dark, high-contrast, print/mono, sketch) | Must |
| FR-T7 | Themes may define custom shapes declaratively (parameterised path templates) — no code execution | Should |
| FR-T8 | Font declarations with an embedding strategy for self-contained export | Should |
| FR-T9 | Theme editor UI in the app | Could |

### 3.4 Rendering and export

| ID | Requirement | Priority |
|---|---|---|
| FR-R1 | Render to SVG in-browser | Must |
| FR-R2 | Exported SVG is self-contained (no external refs) and opens correctly in Figma, Inkscape, and browsers | Must |
| FR-R3 | Stable, content-derived element IDs so exports diff meaningfully | Must |
| FR-R4 | Accessible output: `role`, `<title>`, `<desc>`, logical DOM order, per-node `aria-label` | Must |
| FR-R5 | Interaction chrome (hover, selection, pan/zoom) lives outside the exportable tree | Must |
| FR-R6 | Export PNG (client-side rasterisation) at selectable scale | Should |
| FR-R7 | Export PDF | Could |
| FR-R8 | Copy to clipboard as SVG and as PNG | Should |
| FR-R9 | Labels are plain text plus a small inline markup subset by default; no raw HTML | Must |

### 3.5 Files and interchange

| ID | Requirement | Priority |
|---|---|---|
| FR-F1 | Open and save `.sgl` (surface syntax) and `.sgl.json` (canonical) | Must |
| FR-F2 | Open and save plain `.txt` containing SGL source | Must |
| FR-F3 | Drag-and-drop import; File System Access API for true save-in-place where supported | Should |
| FR-F4 | Export/import a **bundle** (`.sglpack`) containing source, theme, engine pin, and assets | Should |
| FR-F5 | Share via URL fragment with compressed source — no server required | Should |
| FR-F6 | Import from Mermaid, DOT, or D2 (best-effort, lossy, flagged as such) | Could |

### 3.6 Editor and app

| ID | Requirement | Priority |
|---|---|---|
| FR-E1 | Split editor/preview with live re-render | Must |
| FR-E2 | Syntax highlighting, folding, bracket matching | Must |
| FR-E3 | Inline diagnostics with squiggles at exact source spans | Must |
| FR-E4 | **Errors never blank the canvas** — keep the last good render, overlay the problem | Must |
| FR-E5 | Autocomplete: node paths, config keys, theme tokens, shape names, engine options | Should |
| FR-E6 | Bidirectional source mapping: click a shape to jump to source; cursor position highlights the shape | Should |
| FR-E7 | Pan, zoom, fit-to-view, minimap for large graphs | Should |
| FR-E8 | Local-first persistence of open documents (IndexedDB/OPFS) with recovery after a crash | Must |
| FR-E9 | Engine and theme pickers with live preview | Must |
| FR-E10 | Keyboard-first navigation of the diagram for screen-reader users | Could |

### 3.7 Platform and hosting

| ID | Requirement | Priority |
|---|---|---|
| FR-P1 | Static SPA deployable to Cloudflare Pages / Workers static assets | Must |
| FR-P2 | Fully functional with zero network connectivity | Must |
| FR-P3 | Installable PWA with offline cache of app, themes, and engines | Should |
| FR-P4 | Optional server-side render endpoint for embeds, OG images, and CI | Should |
| FR-P5 | Optional persisted share links (short URL) | Should |
| FR-P6 | CLI for CI and local rendering, sharing the exact same core | Should |
| FR-P7 | Embeddable web component `<sgl-diagram>` | Could |

---

## 4. Non-functional requirements

### 4.1 Performance budgets

Measured on a mid-range laptop (roughly a 2020 i5 or an M1), cold cache excluded.

| Metric | Target | Hard ceiling |
|---|---|---|
| App first contentful paint | < 1.0 s | 2.5 s |
| Core bundle (parser + IR + SVG renderer + default engine), gzipped | < 180 kB | 300 kB |
| Keystroke to updated SVG, 50-node graph | < 60 ms | 120 ms |
| Full pipeline, 500-node graph | < 400 ms | 1.5 s |
| Full pipeline, 2 000-node graph | < 3 s | 10 s (with progress and cancel) |
| Paint-only theme switch (no re-layout), up to 500 nodes | < 16 ms | 50 ms |
| Paint-only theme switch (no re-layout), 2 000-node graph | < 50 ms | 100 ms |
| Layout engine timeout | — | 10 s, cancellable |

Above 2 000 nodes the app degrades gracefully: warn, suggest the `grid`/`fixed` engines, disable live re-render.

### 4.2 Other NFRs

| ID | Requirement |
|---|---|
| NFR-1 | **Determinism.** Identical input, engine, theme and version produce byte-identical SVG on any platform, **for engines declaring a `bitwise` or `quantized` determinism class**. Geometry is quantized to 1/64 px before serialization. Engines declaring `best-effort` (e.g. `force`) are exempt and marked as such in the UI. See [ADR-0004](adr/0004-scope-of-determinism.md). |
| NFR-2 | **Isomorphic core.** Zero DOM dependencies; runs in browser, Web Worker, Cloudflare Worker, and Node. |
| NFR-3 | **Text metrics identical across environments** — otherwise server and client renders disagree. See ADR-0003. |
| NFR-4 | **Sandboxing.** Third-party engines cannot touch the DOM, network, or storage. |
| NFR-5 | **No XSS via document content.** Labels, URLs, and IDs are escaped and validated on the way into SVG. |
| NFR-6 | **Backwards compatibility.** A `.sgl` file valid at 1.0 renders at 1.x. Breaking changes require a major bump and an automated migration. |
| NFR-7 | **Accessibility.** App UI meets WCAG 2.1 AA; rendered output carries a meaningful accessibility tree. |
| NFR-8 | **Privacy.** No document content leaves the device unless the user explicitly shares or renders server-side. |
| NFR-9 | **Browser support.** Last two versions of Chrome, Edge, Firefox, Safari. |
| NFR-10 | **Licensing.** Core library permissive (Apache-2.0 or MIT) to encourage third-party engines. |

---

## 5. Key constraints and risks

| Risk | Impact | Mitigation |
|---|---|---|
| Text measurement differs browser vs server | Server renders drift from client | Pure-JS metrics engine used by default everywhere (ADR-0003) |
| Layout of large graphs blocks the UI | App feels frozen | Engines run in a Worker with cancellation; debounce plus incremental re-layout |
| Cloudflare Worker CPU limits on server render | Big graphs fail server-side | Size cap, aggressive caching, and client render as the primary path |
| Plugin API churn breaks third-party engines | Ecosystem stalls | Versioned, narrow interface; capability flags; conformance test suite |
| Config-vs-child ambiguity in the language | Confusing errors, poor DX | Sigil-prefixed config keys (ADR-0001) |
| Scope creep into "another Mermaid" | Never ships | Graph diagrams only in v1; other types explicitly deferred |

---

## 6. Acceptance criteria for v1

1. A 60-line SGL document with three levels of nesting renders correctly under all six built-in engines.
2. Switching theme without changing typography re-renders with no re-layout and no visible reflow.
3. A third-party engine, written only against the published SDK and docs, loads and lays out correctly.
4. Exported SVG opens in Figma, Inkscape, and Safari with identical geometry.
5. The app loads, opens a local file, renders, and exports with the network disabled.
6. The same document rendered by CLI and by browser produces byte-identical SVG.
7. Deleting a closing brace mid-edit shows a squiggle and keeps the previous diagram on screen.
