# SGL — Feature Backlog for MoSCoW Triage

Every row is a feature that exists in a comparable tool and could exist here.
**"Rec"** is my recommendation. **"Call"** is the decision taken on review.
Where they differ, the call is shown in **bold**.

- **M — Must:** v1 does not ship without it.
- **S — Should:** important, but v1 can ship without it.
- **C — Could:** valuable if it is cheap or someone wants it badly.
- **N — Not necessary:** consciously declined.

Prior art referenced: **Mm**=Mermaid · **D2**=D2 · **GV**=Graphviz · **PU**=PlantUML · **Ex**=Excalidraw · **St**=Structurizr · **Kr**=Kroki · **tl**=tldraw · **Vg**=Vega

---

## A. Language and authoring

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| A1 | JSON-superset syntax (unquoted keys, optional commas, comments) | D2, HJSON | The premise of the project | **M** | M |
| A2 | Nested containers as the core primitive | D2, GV clusters | The premise of the project | **M** | M |
| A3 | Infix edge operators `-> <- <-> --` with chaining | Mm, D2, GV | Nobody wants to write edges as arrays by hand | **M** | M |
| A4 | Path references with `..` and root-absolute `/` | D2 | Required once containers exist | **M** | M |
| A5 | Canonical `.sgl.json` round-trip | Vg | Makes SGL a tooling target, not just a human format | **M** | M |
| A6 | Node classes / templates with inheritance | D2 `classes`, PU | Biggest single lever on document size | **M** | M |
| A7 | Error-tolerant parser producing partial models | (LSP norm) | Underpins "errors never blank the canvas" | **M** | M |
| A8 | Variables and string interpolation | D2 `vars` | Cheap; big payoff for generated docs | **S** | **M** |
| A9 | `@import` of other SGL files | D2, PU `!include`, St | Essential for shared house classes and icon sets | **S** | **M** |
| A10 | Shorthands (`a: "Label"`, `a: ClassName`) | D2 | Keeps the `@` sigil from feeling heavy | **M** | M |
| A11 | Implicit node creation from edge references | Mm, D2 | Fast to write, but typos silently become nodes. Suggest opt-in via `@strict: false` | **C** | C |
| A12 | Ports / named anchors on nodes | GV record ports | Needed for precise routing and rack/board diagrams | **S** | S |
| A13 | Glob/selector bulk styling (`**.@type(Store)`) | D2 globs | Powerful, and a debugging hazard. Distinct from A21 — see language spec §7 | **C** | C |
| A14 | `sgl fmt` canonical formatter | gofmt, prettier | Kills all formatting debate; cheap to build | **S** | S |
| A15 | Linter with configurable rules | ESLint | Orphan nodes, unresolved refs, duplicate labels | **C** | C |
| A16 | Preprocessor with loops/conditionals | PU | Turns a data language into a bad programming language | **N** | N |
| A17 | Comments preserved through canonical round-trip | — | Nice, but meaningfully complicates the AST | **C** | C |
| A18 | Multi-line / markdown text blocks in labels | D2, Mm | Bold, italic, code, line breaks. Keep the subset small | **S** | **M** |
| A19 | LaTeX / maths in labels | D2 | Needs KaTeX, big bundle, narrow audience | **N** | N |
| A20 | Inline code blocks with syntax highlighting in nodes | D2 | Lovely demo, rarely used in anger | **C** | **S** |
| A21 | Wildcard edge endpoints (`lane1.* -> switch`, `lane1.cam* -> switch`, `store*.api* -> payments.api`) | D2 globs | The common case A13 was being asked to cover, without A13's cost: bounded, local, one star per segment, direct children per segment, `**` final only (parent-segment globs: human decision 2026-09-24), expands to ordinary edges | **M** | **M** |

## B. Layout

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| B1 | Pluggable layout engine interface | D2 (dagre/ELK/TALA) | The premise of the project | **M** | M |
| B2 | Engines control label and title placement | (rare — differentiator) | You asked for it and almost nobody does it | **M** | M |
| B3 | Built-in `layered` (Sugiyama) engine | Mm, D2, GV dot | The default anyone expects | **M** | M |
| B4 | Built-in `grid` engine | D2 grid | Deterministic and fast; great fallback for huge graphs | **M** | M |
| B5 | Built-in `tree`, `radial`, `fixed` engines | GV twopi/circo/neato | Rounds out the set; `fixed` is the escape hatch. `force` was part of this row until 2026-09-27 and is now B22 (DD-12) | **M** | M |
| B6 | Sandboxed execution (iframe + Worker, timeout, abort) | — | Non-negotiable once third-party code loads | **M** | M |
| B7 | Engine options schema driving a generated settings UI | — | Makes engines self-documenting | **S** | S |
| B8 | Per-container engine selection | — | Mixed layouts; big differentiator | **S** | **C** |
| B9 | Sublayout delegation between engines | — | The mechanism B8 needs | **S** | **C** |
| B10 | Capability negotiation with host-supplied fallbacks | — | Makes a 60-line engine viable. Key to adoption | **M** | M |
| B11 | Manual pinning that auto-layout respects | tl, Ex | The most-requested escape hatch in every tool | **S** | S |
| B12 | `@direction` (down/up/left/right) | Mm, D2, GV rankdir | Universally expected | **M** | M |
| B13 | Rank constraints (`rank: same`) | GV | Power users will ask immediately | **C** | C |
| B14 | `near` / relative positioning ("legend near bottom-left") | D2 | Genuinely useful for legends and annotations | **C** | **S** |
| B15 | elkjs adapter engine | Mm, D2 | Heavy; ship as an optional lazy-loaded package | **C** | **S** |
| B16 | Incremental / stable layout across edits | tl | Stops the diagram jumping on every keystroke. Underrated | **S** | S |
| B17 | Third-party engines loadable from URL | — | The point of a plugin system, but needs B6 first | **C** | C |
| B18 | Engine conformance test suite in the SDK | — | Without it, third-party engines will be broken | **S** | S |
| B19 | Self-loops and parallel edges routed sensibly | GV | Looks broken when missing; easy to forget | **M** | M |
| B20 | Orthogonal edge routing with obstacle avoidance | D2, GV | Expensive to do well; `layered` should ship it | **S** | S |
| B21 | Edge bundling for dense graphs | GV | Narrow use case | **N** | **S** |
| B22 | Built-in `force` engine (seeded n-body) | GV neato/fdp | Split out of B5 and cut from v1.0 by human decision, 2026-09-27 (DD-12 N49, H3): the only `best-effort` engine (ADR-0004), it needs a per-document seed (F10) and a snapshot to `@pin` to be useful, and `radial` covers hub-and-spoke. B21 is scoped to live inside it | **M** | **C** |

## C. Themes and styling

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| C1 | Declarative JSON themes (no code) | Mm themeVariables | Safe to share; works in Worker and CLI | **M** | M |
| C2 | Token system: primitives → semantic → roles | Design systems | Makes custom themes tractable | **M** | M |
| C3 | Metrics/paint split (paint change skips re-layout) | (rare — differentiator) | Instant dark-mode toggle | **M** | M |
| C4 | Theme inheritance (`extends`) + light/dark modes | Mm, D2 | Expected | **M** | M |
| C5 | Built-in theme set (light, dark, high-contrast, print/mono) | Mm, D2 | Ship at least four | **M** | M |
| C6 | Documented cascade (theme → shape → class → inline) | CSS | Must be specified or styling becomes guesswork | **M** | M |
| C7 | Declarative custom shapes (parameterised path templates) | — | Custom shapes without a code sandbox | **S** | S |
| C8 | Font declaration + subsetted embedding for export | D2 | Exports look wrong without it | **S** | S |
| C9 | Sketch / hand-drawn rendering mode | D2 sketch, Ex | Disproportionately loved. Cheap via a roughness filter | **S** | **C** |
| C10 | Icon packs (AWS/Azure/GCP/simple-icons) | D2, Mm, PU | Huge for architecture diagrams. Ship as importable packs | **S** | S |
| C11 | In-app visual theme editor | — | Lovely, not load-bearing | **C** | C |
| C12 | Per-element inline `@style` overrides | Mm, D2 | Escape hatch people always need | **M** | M |
| C13 | Gradients, shadows, glow effects | D2 | Easy once tokens exist | **C** | C |
| C14 | Code-backed custom shape renderers | — | Drags the sandbox problem into themes | **N** | N |
| C15 | Automatic WCAG contrast validation of themes | — | Cheap check; good differentiator for regulated users | **C** | **S** |
| C16 | Theme applies to the app chrome too, not just the canvas | — | Polish | **C** | C |

## D. Rendering and export

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| D1 | SVG render in-browser | all | The premise | **M** | M |
| D2 | Self-contained SVG export (fonts embedded, no external refs) | D2 | Opens correctly in Figma and Inkscape | **M** | M |
| D3 | Stable content-derived element IDs | — | Makes committed SVGs diff cleanly | **M** | M |
| D4 | Accessible output (`role`, `<title>`, `<desc>`, `aria-label`) | Mm accTitle | Often bolted on late and done badly. Do it in the renderer | **M** | M |
| D5 | Interaction chrome excluded from export | — | Exports must not contain editor artefacts | **M** | M |
| D6 | PNG export at selectable scale | Mm, D2 | Most-used export in practice | **S** | **M** |
| D7 | Copy to clipboard (SVG and PNG) | Ex | Two lines of code, used constantly | **S** | **M** |
| D8 | PDF export | D2 | Needs svg2pdf; real work | **C** | C |
| D9 | No `<foreignObject>` / no raw HTML in labels | — | XSS, portability, and determinism all at once | **M** | M |
| D10 | Transparent-background export option | Ex | Trivial, frequently wanted | **S** | S |
| D11 | Print stylesheet / fit-to-page / multi-page tiling | — | Matters for the tech-writer persona | **C** | C |
| D12 | Animated SVG (staged reveal) | D2 animated | Great for presentations; substantial work | **C** | **N** |
| D13 | Clickable links and tooltips in output | Mm click, D2 | Makes exported SVG interactive in a browser | **S** | S |
| D14 | Canvas/WebGL renderer for very large graphs | tl | Only if you commit to >5 000 node graphs | **N** | N |

## E. Editor and app UX

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| E1 | Split code/preview with live re-render | Mm live editor, D2 playground | The core loop | **M** | M |
| E2 | Syntax highlighting, folding, bracket matching | all | Table stakes | **M** | M |
| E3 | Inline diagnostics at exact source spans | — | Requires spans everywhere in the AST from day one | **M** | M |
| E4 | **Errors never blank the canvas** | (Mermaid does this badly) | Single biggest UX win available | **M** | M |
| E5 | Pan, zoom, fit-to-view | Mm, D2 | Table stakes | **M** | M |
| E6 | Autocomplete for paths, `@` keys, tokens, shapes | — | Where the `@` sigil pays for itself | **S** | S |
| E7 | Bidirectional source mapping (click shape ↔ source) | — | Feels magic; needs spans threaded through the IR | **S** | S |
| E8 | Local-first autosave and crash recovery | Ex | Losing work once loses the user | **M** | M |
| E9 | Engine and theme pickers with live preview | D2 | How people discover the plugin system | **M** | M |
| E10 | Minimap for large graphs | tl | Only earns its place above ~200 nodes | **C** | C |
| E11 | Search / filter / highlight within the diagram | — | Very useful at scale; rare in competitors | **C** | **S** |
| E12 | Undo/redo beyond the text editor's own | Ex | Editor undo is probably enough | **C** | C |
| E13 | Example gallery / templates on first load | Mm, D2 | Biggest lever on first-run activation | **S** | S |
| E14 | Keyboard-navigable diagram for screen readers | — | Genuinely rare; strong accessibility story | **C** | **S** |
| E15 | Drag a node on canvas to write a `@pin` back into source | tl, Ex | Text↔canvas round-trip. Delightful, and fiddly | **C** | C |
| E16 | Side-by-side visual diff of two document versions | — | Compelling for the PR-review workflow | **C** | **S** |
| E17 | Multiple documents / tabs in one session | — | Expected once people have more than one diagram | **S** | **M** |
| E18 | Presentation mode (fullscreen, step through layers) | D2 | Nice-to-have | **C** | **S** |
| E19 | In-app help and reference: a Help drawer for quick lookup and a help page for detail | Mm and D2 docs sites | Look up `@` keys, style properties, shapes, engines and their options, tokens and diagnostics; basic topics; examples with rendered previews and "Open as new document"; offline. Facts generated from the registries so they cannot drift; prose and examples hand-written, every example tested. Shares its generated data with E6. Added after triage; [DD-13](detailed-design/13-help.md) | — | **M** (Must, human decision 2026-09-27) |

## F. Files, sharing and interop

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| F1 | Open/save `.sgl`, `.sgl.json`, `.txt` | — | Explicitly requested | **M** | M |
| F2 | Drag-and-drop import | Ex | Expected | **S** | **M** |
| F3 | File System Access API save-in-place | Ex | Real "edit a repo file" workflow where supported | **S** | S |
| F4 | Share via URL fragment (compressed, no server) | Mm live editor, Kr | Zero cost, works offline, privacy-preserving. Excellent value | **S** | **M** |
| F5 | `.sglpack` bundle (source + theme + engine pin + assets) | — | Reproducibility; solves "it looks different on your machine" | **S** | **M** |
| F6 | Short share links backed by R2/D1 | Mm, D2 playground | Needs a backend and abuse protection | **S** | S |
| F7 | Import from Mermaid | Kr | Best migration lever you have. Lossy but valuable | **C** | **S** |
| F8 | Import from Graphviz DOT | Kr | Well-specified; easiest importer to write | **C** | C |
| F9 | Import from D2 | — | Closest semantic match; hardest moving target | **C** | C |
| F10 | Export to Mermaid / DOT | — | Reduces lock-in fear. Very lossy | **C** | C |
| F11 | Export to Figma-friendly SVG (grouped, named layers) | — | Designers will notice. Mostly free if D2/D3 are done | **C** | C |
| F12 | Version history of a document (local) | Ex | Cheap with OPFS snapshots | **C** | **S** |

## G. Platform, hosting and integrations

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| G1 | Static SPA on Cloudflare Pages/Workers assets | — | The deployment target | **M** | M |
| G2 | Fully functional offline, no network required | Ex | Drives the whole architecture. Decide this early | **M** | M |
| G3 | Installable PWA with offline asset cache | Ex | Explicitly in your future scope | **S** | **M** |
| G4 | OS file-type association for `.sgl` (PWA file handlers) | — | Cheap once G3 exists; feels like a real app | **C** | C |
| G5 | Worker render API (`POST /v1/render`) | Kr | Unlocks CI, embeds, and OG images | **S** | S |
| G6 | KV render cache keyed by content hash | — | Renders are pure functions; near-free scaling | **S** | S |
| G7 | OG image generation for share links | — | Shared links look right in Slack/Notion | **C** | C |
| G8 | CLI (`sgl render/fmt/lint/watch`) | Mm mmdc, D2 | The in-repo workflow that wins over engineers | **S** | S |
| G9 | GitHub Action to render diagrams in CI | Mm | Natural pairing with G8 | **C** | **S** |
| G10 | Embeddable web component `<sgl-diagram>` | Mm `<pre class=mermaid>` | How it spreads into other people's docs sites | **C** | C |
| G11 | VS Code extension, **preview only** | Mm, D2 | Scoped by decision: a webview rendering SVG via `@sgl/core`. No language features, so no LSP dependency | **C** | **S** |
| G12 | Language Server (LSP) powering all editors | — | The upgrade path for G11 once preview-only is not enough | **C** | C |
| G13 | Markdown code-fence integration (```sgl) | Mm | Enormous distribution lever if docs tools adopt it | **C** | C |
| G14 | Plugin registry (browse/install engines and themes) | — | Only worth it once there are plugins to list | **C** | C |
| G15 | MCP server so LLMs can author and render SGL | — | Increasingly how diagrams actually get written | **C** | C |
| G16 | Turnstile + rate limiting on public render | Kr | Required the day G5 is public | **S** | S |
| G17 | Self-host as a single Docker image | Kr, PU | Enterprise blocker if missing | **C** | C |
| G18 | Telemetry (opt-in, anonymous) | — | Needed to know which engines/themes are used | **C** | C |

## H. Collaboration and accounts

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| H1 | Anonymous use with no account | Ex, Mm | Removes all friction. Strongly recommend as the default | **M** | M |
| H2 | Optional accounts for saved diagrams | D2 playground | Only once there is something worth saving server-side | **C** | C |
| H3 | Real-time collaborative editing (CRDT over Durable Objects) | Ex, tl | Big build. Architecture should not preclude it | **C** | C |
| H4 | Comments / annotations on a diagram | Figma | Needs H2 first | **N** | **C** |
| H5 | Team/shared theme libraries | Figma | Compelling for the tech-writer persona; needs H2 | **C** | C |
| H6 | Read-only public view pages with SEO | Kr | Cheap once G5/G7 exist | **C** | C |

## I. Model and diagram semantics

| ID | Feature | Seen in | Notes | Rec | Call |
|---|---|---|---|---|---|
| I1 | One model, many views (define once, render several perspectives) | **St** | The strongest idea in this space that nobody else copied. Fits containers naturally | **C** | **S** |
| I2 | Layers / steps / scenarios (staged diagrams) | D2 layers | Pairs with D12 for presentations | **C** | C |
| I3 | Sequence diagrams | Mm, D2, PU | A different layout model entirely. A layout *engine*, not a language change — which is a nice proof of the plugin system | **C** | **S** |
| I4 | UML class / ER / SQL table shapes | D2, Mm, PU | Mostly a shape + label-structure problem, not a new language | **C** | **S** |
| I5 | C4 model support (context/container/component levels) | St, Mm C4 | Falls out of I1 plus a class library | **C** | C |
| I6 | Gantt, pie, timeline, mindmap, git graph | Mm | Not graphs. This is where Mermaid lost coherence | **N** | N |
| I7 | State machine diagrams | Mm, PU | Mostly achievable with shapes + `layered` today | **C** | C |
| I8 | Data binding: generate a diagram from CSV/JSON | Vg | Powerful and open-ended; easy to lose a quarter to | **N** | N |
| I9 | Legends generated from classes | — | Small feature, large perceived polish | **C** | **S** |
| I10 | Node grouping/filtering by tag at render time | — | Pairs with I1; useful for large models | **C** | C |
| I11 | Collapse/expand containers in the live view | tl | Essential for navigating big diagrams. Export-time collapse too | **C** | C |

---

## Triage outcome

Reviewed 2026-09-14. 136 features, 0 undecided, **32 changed** from the recommendation.

| | Recommended | **Your call** | Net |
|---|---|---|---|
| **M — Must** | 41 | **51** | +10 |
| **S — Should** | 34 | **38** | +4 |
| **C — Could** | 53 | **40** | −13 |
| **N — Not necessary** | 8 | **7** | −1 |

Rows where the two differ show the call in bold.

*Amended 2026-09-27 (human decision, DD-12 H3): B5's `force` engine was split out as B22 and cut to Could. The counts above are as reviewed on 2026-09-14, before that split.*

*Amended 2026-09-27 (human decision): E19, in-app help, was added as a Must (DD-13). It is not in the counts above.*

### Promoted into Must

A8 variables · A9 imports · A18 markdown labels · D6 PNG export · D7 clipboard ·
E17 multiple documents · F2 drag-and-drop · F4 URL-fragment share · F5 `.sglpack` bundle · G3 PWA

### Promoted into Should

A20 code blocks in nodes · B14 relative positioning · B15 elkjs · B21 edge bundling ·
C15 WCAG validation · E11 search and filter · E14 keyboard navigation · E16 visual diff ·
E18 presentation mode · F7 Mermaid import · F12 version history · G9 GitHub Action ·
G11 VS Code extension · I1 one model many views · I3 sequence diagrams · I4 UML/ER shapes ·
I9 legends

### Demoted

B8 per-container engines (S→C) · B9 sublayout delegation (S→C) · C9 sketch mode (S→C) ·
D12 animated SVG (C→N) · H4 comments (N→C, i.e. reopened)

---

## What the triage changes about the design

### 1. A new subsystem lands on the critical path: SVG rich text

A18 (markdown in labels) is now Must, A20 (code blocks in nodes) and I4 (UML/ER compartment
shapes) are Should — and D9 (no `<foreignObject>`) stays Must. Together those mean the renderer
has to do its own inline text layout: line breaking, styled runs for bold/italic/code,
multi-compartment boxes, all emitted as positioned `<tspan>` elements.

That is a package of its own — **`@sgl/text`** — and it is not small.

It also changes the measurement contract in [ADR-0003](adr/0003-deterministic-text-measurement.md).
A single `measure(text, style)` is no longer enough; a label is a sequence of runs with different
styles, so the interface becomes run-based:

```ts
interface Measurer {
  measureRuns(runs: readonly TextRun[], box: BoxConstraints): TextLayout;
  // TextLayout carries line boxes, baselines, and per-run x-offsets.
}
```

*(As built, DD-11 §19 item 2: the method is `layoutRuns(runs, box)` over `StyledRun`s, per
[DD-05 §2](detailed-design/05-measurement.md#2-interface); `@sgl/text` holds the types, the table
key and the line models.)*

This has to be decided before the layout engine contract is frozen, because node intrinsic sizes
come out of it. **Do this in phase 1 even though A20 and I4 ship later.**

### 2. The plugin system has to prove itself earlier than planned

I3 (sequence diagrams) and B15 (elkjs) are both Should, and both are *layout engines rather than
language features*. That is exactly the bet the architecture makes, and promoting them means the
engine API gets two real external consumers before any third party sees it — the best possible
validation.

One consequence: sequence messages are **ordered**, and `@order` is currently a node-only key.
Edges need it too. Add `@order` to the edge attribute table in the language spec.

### 3. Keep the sublayout seam even though B8/B9 dropped to Could

Per-container engine selection (B8) and sublayout delegation (B9) are Could now. Keep
`ctx.sublayout()` in the **v1 `LayoutContext` type** anyway, documented as reserved.

Adding an optional method to the context later is not a breaking change for engines — they simply
never call it — but publishing it in v1 means engines written against `apiVersion: 1` stay valid
when it does land. It costs one line of type definition now and avoids an API version bump later.

### 4. G11 resolved — VS Code is preview-only

The VS Code extension was promoted to Should while the Language Server that would power it stayed at
Could. Left as-is, that writes the language intelligence twice: once for CodeMirror in the web app,
once for VS Code.

**Decision: scope G11 to preview only.** The extension is a webview that renders the SVG by calling
`@sgl/core` directly — open a `.sgl` file, see the diagram, re-render on save. No completion, no
diagnostics, no hover, no LSP.

This is the right shape for a Should:

- It reuses the isomorphic core with no new code paths, so it cannot drift from the web app.
- It carries no share of the language-intelligence cost, so promoting it does not drag G12 along.
- It delivers the thing people actually open an extension for — seeing the diagram next to the source.

G12 stays at Could as the explicit upgrade path. If preview-only proves insufficient, the extension
becomes a thin LSP client and the same intelligence serves Neovim and JetBrains at the same time.
What must not happen is a VS Code extension growing its own private completion engine.

### 5. E18 presentation mode needs re-scoping

E18 was described as "fullscreen, step through layers" — but I2 (layers, steps and scenarios) stayed
at Could. At Should, E18 therefore means fullscreen plus zoom-to-container navigation and keyboard
stepping between containers. Cheap and useful. Just don't build it expecting I2 to exist.

### 6. B21 edge bundling — accepted, and cheap if scoped to one engine

I had this at Not necessary. Taking it as Should, the way to keep it off the critical path is to
implement it **inside the `force` engine rather than in shared edge routing**. Bundling only pays
off on dense undirected graphs, which is precisely where `force` is used — so it becomes an
engine-local concern, and `layered` never has to know about it.

### 7. Accessibility is now a workstream, not a checkbox

D4 (accessible output) Must, plus E14 (keyboard navigation) and C15 (WCAG contrast validation) at
Should. That is enough to deserve its own test surface: contrast assertions in the theme suite,
keyboard traversal in Playwright, and an axe pass over the app shell in CI.

### 8. Design obligations in phase 1 for features that ship later

These are cheap to design in and expensive to retrofit, so they belong in the phase-1 design even
though they are Should:

| Later feature | What phase 1 must not preclude |
|---|---|
| I1 — one model, many views | Stage 4 (IR compile) takes a **view selector** parameter, rather than assuming one graph per document |
| I3 — sequence diagrams | `@order` on edges; stable edge identity independent of declaration order |
| I4 — UML/ER shapes | Labels are structured (compartments), not a single string — falls out of `@sgl/text` |
| B8/B9 — mixed layouts | `ctx.sublayout()` reserved in the v1 engine contract |
| E16 / F12 — diff and history | Stable content-derived IDs (D3, already Must) plus canonical formatting (A14) |
| C15 — contrast validation | Theme tokens carry enough semantic role information to know what is drawn on what |

---

## The MVP cut

51 Musts is a v1.0. The MVP is the subset that proves the three bets — language, pluggable layout,
pluggable themes — with the smallest thing a real person would use. Reasoning and acceptance
criteria in [06 — Feasibility and MVP](06-feasibility-and-mvp.md).

| Area | MVP | Deferred to v1.0 (still Must) |
|---|---|---|
| Language | A1–A7, A10, **A21 wildcard endpoints** | A8 variables · A9 imports · **A18 markdown labels** |
| Layout | B1, B10, B12, B19 via **elkjs** + `grid`; Worker with timeout/abort | B5 other engines (`fixed` first, then `tree` and `radial`; `force` cut to Could as B22, 2026-09-27) · B6 iframe isolation → with B17 |
| Themes | C1–C4, C6, C12; two themes | C5 four themes |
| Render | D1–D5, D9; fonts by reference | D6 PNG · D7 clipboard |
| Editor | E1–E5, E8, E9 | E17 tabs · E19 in-app help |
| Files | F1, **F4** URL share | F2 drag-drop · F5 `.sglpack` |
| Platform | G1, G2, G3, H1 | — |

## Revised delivery plan

Must is now 51 of 136, which is a large v1 — so Must splits across two phases rather than one.

| Phase | Contents | Exit criterion |
|---|---|---|
| **0 — Spike** | Lexer, parser, IR, `grid` engine, minimal SVG out | The pipeline shape is right |
| **1 — Core loop** (Must) | `layered` engine, theme system with the metrics/paint split, 4 built-in themes, **`@sgl/text` rich labels**, classes, variables, imports, direction, self-loops and parallel edges, inline styles, accessible SVG with stable IDs, editor with live preview and last-good-render, local persistence | Someone can write a real architecture diagram and export it |
| **2 — Rest of Must** | Remaining engines (`fixed`, `tree`, `radial`; `force` is B22, Could), capability negotiation, engine sandbox, `.sgl.json` round-trip, PNG and clipboard export, drag-and-drop, URL-fragment share, `.sglpack` bundles, multiple documents, PWA | It fits a real workflow, offline |
| **3 — Plugin surface** (Should) | Options UI, conformance suite, plugin SDK, ports, pinning, incremental layout, orthogonal routing, elkjs adapter, formatter, icon packs, custom shapes, font embedding, WCAG validation, CLI, Worker render API with KV cache and Turnstile, short links, GitHub Action, VS Code preview | Third parties can extend it |
| **4 — Model and UX** (Should) | One model many views, sequence diagrams, UML/ER shapes, legends, search and filter, keyboard navigation, visual diff, version history, presentation mode, example gallery, autocomplete, source mapping, Mermaid import, relative positioning, edge bundling | It has range |
| **5 — Could** | Pulled in as demand appears | — |

### Still the first thing to cut if schedule bites

**The `force` engine in B5 — cut (human decision, 2026-09-27; now B22, Could; DD-12).** Physics layout is the least used of the six and the hardest to make
deterministic — and B21 (edge bundling), now Should, is scoped to live inside it. Deferring both
together is a clean cut: `layered`, `grid`, `tree` and `fixed` cover the real cases.
