# SGL — Feasibility, MVP and Technology

**Date:** 2026-09-14 · Follows [05 — Design review](05-design-review.md).

Four questions: Is it buildable? What is the *actual* MVP? Where are the traps? What do we build it with?

---

## 1. Check against the original brief

The brief had eight requirements. Everything else in these documents is derived.

| # | Original requirement | Covered by | MVP? | Notes |
|---|---|---|---|---|
| 1 | Programmatic graphing web app in the vein of D2 / Mermaid | whole design | ✔ | |
| 2 | JSON-esque scripting; keys are containers; contents are children or config | Language spec §1–4, ADR-0001 | ✔ | Every key is a node; a node with children is a container. Leaves are containers with no children — one concept, not two |
| 3 | Custom layout engines: placement, arrows, titles | Architecture §4, ADR-0002 | ✔ | Two engines behind one interface in MVP (elkjs, grid) proves pluggability; label/title placement is in `LayoutResult` |
| 4 | Themes: custom and pre-provided | Architecture §5 | ✔ | Two built-ins in MVP (light, dark); four by v1.0 |
| 5 | Import/export SGL files and text files | FR-F1, F2 | ✔ | `.sgl`, `.sgl.json`, `.txt` via file input and download. Save-in-place is a later enhancement |
| 6 | Render as SVG, in-browser | Architecture §7 | ✔ | |
| 7 | Future: PWA, offline | FR-P2, P3 | ✔ | Falls out of client-side-first; the install shell is a plugin config |
| 8 | Cloud hosted, preferably Cloudflare | Architecture §9 | ✔ | MVP is static assets only, ~$0/month. Every server-side feature is Should |

**Every original requirement is covered and every one is in the MVP.** The concern is not gaps — it is that the design has grown things the brief never asked for.

### The requirement I added, and what it cost

Goal **G6 — determinism** is not in the brief. I introduced it because it enables git-diffable SVGs, a sound render cache, and server/client parity. It is a good property. It is also responsible for a disproportionate share of the design's complexity: ADR-0003's precomputed font metrics and their build pipeline, ADR-0004's quantization and per-engine classes, the cross-environment golden test, and the weak custom-font story (Finding 6).

**Correction:** keep determinism as a v1.0 goal, but **take it off the MVP critical path**. Concretely, the MVP measures text with canvas `measureText` and does not render server-side, so cross-environment parity is moot until the Worker render API ships in phase 3. The `Measurer` interface stays exactly as designed; only the default implementation changes for MVP. Detail in §4, pitfall 2.

---

## 2. Feasibility

**Buildable: yes.** Every component has a known implementation path, and nothing requires research. The two places where feasibility was genuinely in question have been resolved:

| Question | Resolution |
|---|---|
| Can a compound hierarchical layout be delivered in v1? | Not in-house. **elkjs is the MVP default engine** — [ADR-0005](adr/0005-default-engine-elkjs.md). It supports compound graphs, ports, orthogonal routing, and node/edge label placement, and it runs in a Web Worker. |
| Can "engines control label and title placement" hold when the engine is third-party? | Yes. ELK returns positions for node labels, compound-node titles (`nodeLabels.placement`) and edge labels; the adapter maps them into `LabelPlacement[]`. The interface was designed around this and ELK fits it without contortion — which is itself the validation Finding 1 asked for. |

### Honest effort estimate

One experienced TypeScript developer, full-time:

| Milestone | Scope | Estimate |
|---|---|---|
| **MVP** | §3 below | **6–8 weeks** |
| **v1.0** | all 51 Must | +4–5 months |
| **v1.x** | the 38 Should | +6–9 months |

The MVP estimate is credible *because* elkjs removes the long pole and rich text is deferred. Without those two changes it is 5–6 months.

---

## 3. The MVP, corrected

The triage produced 51 Musts. That is a **v1.0**, not an MVP. An MVP exists to prove the three bets the concept rests on — the language, pluggable layout, pluggable themes — with the smallest thing that a real person would use. Everything below is Must; the point is *ordering*.

### In the MVP

| Area | Included | Proves |
|---|---|---|
| **Language** | A1–A7, A10, A21 — syntax, containers, edges, paths, `.sgl.json` round-trip, classes, error-tolerant parser, shorthands, wildcard endpoints | Bet 1 |
| **Layout** | B1, B10, B12, B19 via two engines: **elkjs adapter** (compound, ports, orthogonal, labels) and **`grid`** (host fallbacks for routing and labels). Worker execution with timeout and abort | Bet 2 — two engines, one interface |
| **Themes** | C1–C4, C6, C12 with **two** themes (light, dark), the `affects` partition, two-hash invalidation | Bet 3 |
| **Render** | D1–D5, D9. Fonts referenced by stack, not embedded | Core req. 6 |
| **Editor** | E1–E5, E8, E9 — CodeMirror, diagnostics, last-good-render, pan/zoom, autosave, pickers | Core req. 1 |
| **Files** | F1 open/save; **F4 URL-fragment share** (about 30 lines with `CompressionStream`, and the only share mechanism that needs no backend) | Core req. 5 |
| **Platform** | G1, G2, G3 — static deploy, works offline, installable. H1 anonymous | Core req. 7, 8 |

### Deferred from Must to v1.0

With the reason each one can wait:

| Item | Why it waits |
|---|---|
| **A18 markdown labels** and `@sgl/text` | The single largest non-engine subsystem. MVP labels are plain text with `\n`. The `Measurer` interface is run-based from day one, so this is an addition, not a rewrite |
| A8 variables, A9 imports | Pure resolver features; add after the resolver is stable |
| B5 `tree`, `radial`, `fixed` | `fixed` should be the first addition: 2–3 days once `@pin` validation, engine warnings and its options form are counted (DD-12 §17 item 1; ~1 day was the first estimate). `force` was cut from v1.0 on 2026-09-27 (backlog B22, Could) |
| **B6 iframe sandbox** | Isolation matters only when third-party code loads (B17, Could). MVP runs trusted engines in a Worker with timeout and abort, which is the part that protects the *user*. See pitfall 5 |
| C5 four themes | Two proves the system; two more is content |
| D6/D7 PNG, clipboard | Each under a day once export exists |
| E17 multiple documents | Storage is a list from day one; the tab UI comes after |
| F2 drag-and-drop, F5 `.sglpack` | Conveniences on top of F1 |

### MVP acceptance

1. A 40-node, three-level document renders under both engines and switching between them changes only geometry.
2. Switching light↔dark re-renders with no re-layout (paint hash changes, geometry hash does not).
3. Breaking the syntax mid-edit shows a squiggle at the right span and keeps the last diagram on screen.
4. Open a `.sgl`, edit, save; reopen the download; identical. Same via `.sgl.json`.
5. Reload with the network disabled; the app and both engines work.
6. Paste a share URL into a fresh browser; the diagram appears.

---

## 4. Pitfalls found and resolved

These are defects in the design as written. Each has been fixed in the relevant document.

### 1. Port syntax was ambiguous — `router:out -> server` parses as `router: (out -> server)`

The spec used Graphviz's `node:port`. At statement start, `router:out` is indistinguishable from the key `router` with value `out` without whitespace sensitivity or multi-token lookahead — both poison error recovery, which is a Must (A7).

**Fix:** port references use a bracket suffix, `router[out] -> server`, and are valid *only* in edge endpoints. Unambiguous with one token of lookahead; no collision with arrays because `[` never follows an identifier anywhere else. Language spec §3 updated.

### 2. ADR-0003 put a font-metrics build pipeline on the MVP path

Precomputed metrics require parsing font files at build time, a binary table format, kerning, and a line-breaker — for a property (cross-environment parity) the MVP cannot exercise because it has no server render.

**Fix:** MVP default is `CanvasMeasurer`, pre-measuring on the main thread and shipping the table into the layout worker exactly as designed. `FontMetricsMeasurer` becomes the default when the Worker render API ships. Decision unchanged, sequencing corrected; amendment recorded in ADR-0003.

### 3. Canonical JSON could not tell a label from a class

In `.sgl`, `web: "Web App"` (quoted → label) and `cache: Redis` (bareword → class) are distinct. JSON has no barewords, so `"cache": "Redis"` in a hand-written `.sgl.json` was ambiguous.

**Fix:** in JSON, a string value under a non-`@` key is **always a label**; classes must be `@type`. Canonicalisation always expands the bareword shorthand, so a generated file never hits the case. Also specified: a non-`@` key with a number, boolean, null or array value is an error (`SGL2xxx`), not a silent label. Spec §2 updated.

### 4. "JSON superset" was not quite true

The root of an `.sgl` document had implicit braces, so `{ "a": {} }` — a valid JSON document — was a parse error.

**Fix:** root braces are optional. Any JSON object is now a valid SGL document. Spec §1 updated.

### 5. The sandbox was designed for a threat the MVP does not have

A null-origin iframe hosting a Worker, with engine code fetched as text and re-blobbed because a null origin cannot load scripts by URL, is the right isolation for *untrusted* engines. MVP engines are bundled and trusted. The cost was real complexity in the most fragile part of the runtime for zero MVP benefit.

**Fix:** separate two concerns that B6 had merged. **Worker + timeout + abort** — protects the user from a hung layout — is MVP. **Cross-origin iframe isolation** — protects the user from malicious code — ships with B17. The `LayoutHost` interface is the same either way; the iframe is an implementation of it.

### 6. Incremental memoisation was planned before any budget was missed

Architecture §2 designed per-stage caching on content hashes. For a 50-node graph the full pipeline is well under the 60 ms budget without it.

**Fix:** MVP is debounce plus full re-run. Memoise a stage only when a measured budget is missed. The stages are still pure functions, so adding memoisation later is local.

### 7. elkjs's own worker would have nested inside ours

elkjs ships a worker build that spawns its own thread. Inside our layout worker that means a worker inside a worker, with two serialisation hops.

**Fix:** use `elk.bundled.js` — the synchronous, single-thread build — inside our layout worker. One thread, one hop. Set `org.eclipse.elk.randomSeed: 1` explicitly so the layered algorithm is deterministic (it is by default, but pin it).

### 8. Known ELK rough edge: orthogonal routing across hierarchy boundaries

`edgeRouting: ORTHOGONAL` with `hierarchyHandling: INCLUDE_CHILDREN` is the combination most likely to produce routing artefacts on edges that cross container boundaries. This is where ELK's own bug tracker is busiest.

**Mitigation:** the adapter exposes `edgeRouting` as an engine option defaulting to `ORTHOGONAL`; the conformance corpus includes boundary-crossing edges from day one so regressions are caught; and `POLYLINE` is one option away when an artefact appears.

---

## 5. Technology

Chosen against three constraints: the isomorphic core (NFR-2), the 180 kB core budget (NFR 4.1), and a small team that cannot carry two implementations of anything.

| Concern | Choice | Why this and not the obvious alternative |
|---|---|---|
| **Language** | TypeScript, `strict`, ESM only | — |
| **Monorepo** | pnpm workspaces; `tsdown` per package; Vite for the app | Turborepo/Nx add ceremony a 12-package repo does not need yet |
| **Parser** | **Lezer** grammar as the *single* parser, with a thin typed AST builder over its CST | The grammar must exist anyway for CodeMirror (E2, E3). Lezer is error-tolerant and incremental by design — exactly A7 and the keystroke budget — and it runs in Node and Workers. Two parsers (hand-written runtime + Lezer for highlighting) is the classic way a language project drifts. *Risk:* Lezer's recovery is heuristic; if partial models come out too poor, fall back to a hand-written parser and keep Lezer for highlighting only. Decide by week 3 |
| **Editor** | CodeMirror 6 | Monaco is several MB, hostile to bundling, weak on mobile |
| **UI** | **Preact** + `@preact/signals` | React-compatible API, ~4 kB, and signals map cleanly onto a pipeline of derived state. The app is an editor and a canvas — not UI-heavy. Swapping to React is aliasing, not a rewrite |
| **Default engine** | **elkjs** (`elk.bundled.js`) | [ADR-0005](adr/0005-default-engine-elkjs.md). Lazy-loaded; not counted against the core budget |
| **Second engine** | `grid`, in-house | Trivial, proves two engines behind one interface, is the phase-0 spike engine |
| **Layout host** | Web Worker + `AbortController` + timeout | Iframe isolation deferred to B17 |
| **Measurement** | `CanvasMeasurer` (MVP) → `FontMetricsMeasurer` (with server render) | Pitfall 2 |
| **Renderer** | String templating → SVG text; live view via `innerHTML` on a container; interaction overlay is a sibling `<g>` | A virtual DOM buys nothing for a document that is regenerated whole. If flicker appears, `morphdom` the inner tree |
| **Rasterisation** | Canvas `drawImage` of the SVG blob → `toBlob` | Standard; needs fonts by reference until C8 |
| **Persistence** | IndexedDB via `idb` | OPFS is overkill for small text documents. Storage is a keyed list from day one so E17 is UI only |
| **Schemas** | Zod internally; JSON Schema emitted for plugin option UIs at phase 3 | `ajv` is large; `@cfworker/json-schema` if a Worker ever needs runtime validation |
| **PWA** | `vite-plugin-pwa` (Workbox) | Precache app shell + both engines + both themes; `file_handlers` for `.sgl` |
| **Hosting** | **Cloudflare Workers with static assets**, deployed by `wrangler` | Cloudflare is steering new work here rather than Pages; one deployment unit that later grows API routes without a migration. Pages remains fine if preferred |
| **Share** | `CompressionStream('deflate-raw')` + base64url in the URL fragment | No backend, offline-to-offline, and the fragment never reaches a server |
| **Fonts** | One bundled OFL face (Inter) by reference | Embedding is C8 |
| **Testing** | Vitest; golden SVG snapshots; Playwright for the editor loop | The cross-environment corpus arrives with server render, comparing quantized output per ADR-0004 |
| **Default font measurement in Worker** | main-thread pre-measure table, `OffscreenCanvas` for misses | Both `CanvasMeasurer` paths already in the design |

### What was considered and rejected

- **dagre** as the default engine — small and deterministic, but no real compound support, no ports, no orthogonal routing. It is why Mermaid layouts look the way they do.
- **Monaco** — see above.
- **React** proper — fine, but it is a third of the core budget on its own.
- **Hand-written recursive-descent parser** as the runtime parser — most controllable, but means two grammars. Kept as the fallback.
- **OPFS** — right for large binary documents, wrong for kilobytes of text.

---

## 6. Does the system still make sense?

Yes, and more clearly than before. Stripped to what the MVP builds, the system is:

> A Lezer-parsed JSON superset compiles to a semantic graph. Two engines behind one interface turn it into geometry in a Worker. A theme resolved into a geometry hash and a paint hash styles it. A string renderer emits accessible SVG. All of it is client-side, so offline and Cloudflare static hosting are free.

Each sentence maps to one of the original requirements, and the one requirement I added (determinism) is now a v1.0 goal with the interface in place rather than an MVP cost.
