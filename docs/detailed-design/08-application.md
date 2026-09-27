# DD-08 — Application

**Package:** `apps/web` · Preact + `@preact/signals`, CodeMirror 6, Vite, `idb`, `vite-plugin-pwa`
**Owns:** everything that touches the DOM, storage, files, and the network. Nothing in the packages below it does.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Hold the source, settings and derived pipeline state as signals | Contain any parsing, layout, styling or rendering logic |
| Orchestrate the pipeline: sync stages per keystroke, debounced abortable layout | Import `elkjs` directly (the layout worker does) |
| Host the editor, canvas, pickers, diagnostics panel | Persist to any server (**⟶ F6**) |
| Keep the last good render on screen through errors and slow layouts | |
| Persist documents locally; open/save files; share by URL; install as a PWA | |

---

## 2. Screen

```
┌─ toolbar ───────────────────────────────────────────────────────────────┐
│ [≡ docs] Title ▾   engine ▾  theme ▾   ⟳fit  │  Open · Save ▾ · Share   │
├──────────────────────────┬──────────────────────────────────────────────┤
│ editor (CodeMirror)      │ canvas                                       │
│                          │   host <svg> [pan/zoom <g>] ▸ rendered <svg> │
│                          │   status chip: "Showing last good · 2 errors"│
├──────────────────────────┴──────────────────────────────────────────────┤
│ diagnostics (n) │ engine options                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

`[≡ docs]` is built as **Documents ▾** (fix round 2, §9); `Title ▾` is not built. Split is draggable; layout stacks vertically under 900 px. The diagnostics panel is collapsed when empty.

---

## 3. State and pipeline

```ts
// ---- inputs (signals) -----------------------------------------------------
source        = signal<string>
engineId      = signal<'sgl.elk' | 'sgl.grid'>
engineOptions = signal<Record<string, unknown>>
themeId       = signal<'neutral-light' | 'neutral-dark'>
docId         = signal<string>

// ---- synchronous derivations (computed) -----------------------------------
parsed   = computed(() => buildAst(editorTree(), source.value))        // DD-01 §5 — reuses the editor's tree
model    = computed(() => resolve(parsed.value.ast))                   // DD-02
graph    = computed(() => compile(model.value.model))                  // DD-03
theme    = computed(() => resolveTheme(builtin[effectiveThemeId.value])) // DD-04 — see "effective ids" below
styled   = computed(() => styleGraph(graph.value.graph, theme.value))  // DD-04
diags    = computed(() => [...parsed.diagnostics, ...model.diagnostics, ...graph.diagnostics, ...layoutDiags.value])

// ---- async stages (effects with their own state) ---------------------------
table       = signal<MeasureTable>            // updated by the measure effect
layout      = signal<LayoutResult | null>     // updated by the layout effect
layoutDiags = signal<Diagnostic[]>
inFlight    = signal<boolean>

// ---- what the canvas shows ------------------------------------------------
lastGood = signal<{ styled, layout, svg, styleBlock, paintPlan } | null>   // svg: lazy after a paint-only render (F9)
```

**Stage I part 1 implementation notes**, against the pseudocode above:

- **Effective ids (fix round 1).** Everything downstream of the pickers reads
  `effectiveThemeId`/`effectiveEngineId` — the document's own `@theme` /
  `@layout.engine` when it sets one (§10), else the picker's `themeId` /
  `engineId`. The `theme` computed and the measure and layout effects below
  depend on those two computeds, **not** on the raw picker signals, so a
  picker change the document overrides triggers nothing.
- **I1, default engine.** `engineId`'s starting value is not a literal `'sgl.elk'`
  default — `elk` is not registered until Stage K, so starting there would mean
  every first layout fails with "unregistered engine" (`SGL4011`). The app reads
  the default from whatever `apps/web/src/layout.worker.ts` actually registers
  (`gridEngine.id`, i.e. `'sgl.grid'`) rather than from `@sgl/layout-api`'s frozen
  `DEFAULT_ENGINE_ID` constant (`'sgl.elk'`, ADR-0005's eventual default), so the
  two cannot drift out of sync as engines are added.
- **Each derivation signal holds the whole `StageResult`**, not the unwrapped
  value the pseudocode above elides (e.g. `theme.value` is
  `StageResult<ResolvedTheme>`, and `styleGraph` is called with `theme.value.value`)
  — needed because `diags` reads every stage's own `.diagnostics`, not just the
  last one's.
- **`diags` also folds in `theme`'s, `styled`'s and `render()`'s own
  diagnostics** (a malformed theme token, an unknown style property, a disallowed
  link scheme), which the list above omits. These are real, user-visible
  diagnostics — DD-00 §1's "errors are values" only works if every
  diagnostic-producing stage's output actually reaches the UI — so the
  implementation's `diags` computed is
  `[...parsed, ...model, ...graph, ...theme, ...styled, ...layoutDiags, ...(svg?.diagnostics ?? [])]`.

### Measure effect

Runs when `styled.value.geometryHash` or `effectiveThemeId` changes (not the raw `themeId` — see "effective ids" above):

**F9 (`feat/theme-fast-path`): not when nothing it reads has changed.** A pre-measure reads the labels' text (the graph) and their text styles, which are geometry (the graph `geometryHash` covers every label style's geometry half). So a styled graph with the same `graph` object and the same `geometryHash` as the table already measured — a theme switch between themes of equal geometry — would produce the very same table, and the effect returns without measuring (a failed pre-measure is retried next time).

```
await measurer.ready(distinctTextStyles(styled))          // DD-05 §4 — fonts first
table.value = premeasure(styled, measurer, previousTable)  // reuses unchanged keys
```

**Deviation.** `premeasure`'s real, frozen signature (`packages/measure/src/premeasure.ts`)
is `premeasure(styled, measurer)` — no `previousTable` parameter. "Reuses unchanged
keys" is delivered a different way than this pseudocode's third argument implies:
`CanvasMeasurer` (and any `AppMeasurer`) already keeps its own per-run cache keyed
by the same run key `premeasure` uses, so calling `premeasure(styled, measurer)`
fresh on every measure-effect run is cheap for every label whose text and style
did not change — the cache serves those without touching a canvas — without the
app needing to thread a previous table through a call `@sgl/measure` does not
accept. `distinctTextStyles` (DD-05 §4's "fonts first") is not exported by
`@sgl/measure` either — built in the app from the same `labelRuns` helper
`premeasure` itself uses, so the two never disagree about what a label's style is.

**A18 addition (DD-11 T53): the `rich-text` gate.** `PipelineDeps.loadRichText` loads the lazy
`rich-text` chunk (`state/rich-text.ts`: `parseInline` from `@sgl/core/inline` and `layoutWrapped`
from `@sgl/text/wrap`). The `graph` stage compiles without the parser until it has loaded; the `styled` stage then
starts the load and holds if `needsInline(graph)` (a label holding `*` or a backtick) or
`needsWrap(styled)` (a node title with `@size.maxWidth` or `@size.width`). *(Fix round 1: one
check, in the styled stage, where the graph stage had its own; the graph with literal runs goes no
further than `styleGraph`.)* Holding is A9's
`HOLD`: the stages below keep their last value, nothing is reported, and the canvas keeps the last
good or stored picture, so nothing is measured or laid out with literal runs or unwrapped labels.
Once loaded, `measurer.lineModel` becomes `layoutWrapped` and compile always runs with the parser.
**If the chunk cannot load** (fix round 1, item 2), the document degrades as A9's does instead of
holding: compile keeps plain runs, the measurer's line model ignores the box (so `layoutLines`
never throws, and a wrapped label is measured on its hard lines under its usual key), and the
styled stage adds one `SGL6002` warning (boot catalogue, no span: it is about the app, not the
document). The load is tried again on the next change of the document's source, not in a loop. The measure effect does not measure
the boot-time fallback (the empty document) while a stage is held, which would otherwise make an
empty layout the one the document's first render is drawn with. A document without markup in a
label and without a box never fetches the chunk (`e2e/rich-text.spec.ts`); offline, it comes from
the precache (`e2e/offline.spec.ts`). Since the render branch (`feat/a18-render`) the render stage
draws marks as nested run tspans and a wrapped label on its measured lines (DD-07 §5, DD-11 T42,
T43), from the table its layout was sized from (below, *Render*).

**Stage I part 2 addition: `hasMeasuredOnce`.** The layout effect below reads `table`,
which starts at `{}` (before this effect has ever produced a real one) — without a guard, the
layout effect's own dependency on `table` fires it *immediately* on boot with that empty value, so
every label lays out at `buildLayoutInput`'s zero-size fallback until this effect's first real
`premeasure()` call lands and triggers a second, correctly-sized layout. A real, briefly-visible
"wrong size" flash, found chasing a genuinely flaky Playwright test (DD-08 §14 test 8), not assumed
up front. `hasMeasuredOnce` (set here, read by the layout effect) closes it — set *before* the
`table.value` write, not after: `@preact/signals` reruns a dependent effect synchronously, inline
in the write statement itself, so setting the flag one statement later means the layout effect's
very next (correct) run still sees it false.

### Layout effect

Runs when `styled.geometryHash`, `table`, `effectiveEngineId` or `engineOptions` changes (`effectiveEngineId`, not the raw `engineId` — see "effective ids" above). Debounced 120 ms after the last change; aborts any in-flight request first.

```
if engine, options and LayoutInput (spans aside, see below) equal those of the layout that landed:
    skip — the layout would be the same one; fall through to render
else:
    inFlight = true
    try
        // LayoutHost.run() resolves a StageResult, never throws except for
        // AbortError (DD-06 §3) — errors are values here, not exceptions.
        result = await host.run(effectiveEngineId, input, options, metrics, table, signal)
        layoutDiags = result.diagnostics
        if result.value !== null:
            layout.value = result.value   // may still carry warnings (e.g. SGL4003)
        // else: keep layout.value as is — FR-E4, the last good layout stays on
        // screen; layoutDiags already carries what to show for it (SGL4001/
        // SGL4002/SGL4011)
    catch AbortError
        return  // a newer request superseded us; that request owns layoutDiags now
    finally
        inFlight = false
```

**Two more deviations, both filling gaps the frozen types below `apps/web` leave
open rather than contradicting them:**

- **`metrics`.** DD-06 §2 calls `ctx.metrics` "the small set of theme-derived
  numbers an engine may want for defaults," but `ResolvedTheme`
  (`packages/theme/src/types.ts`) has no `metrics` field to derive them *from* —
  `packages/theme` is out of this stage's reach. `packages/render-svg/test/pipeline.ts`'s
  `runPipeline`, the one place the whole pipeline already existed end to end
  before this stage, hits the same gap and resolves it with one constant
  (`spacing: { node: 40, rank: 70, edgeLabel: 4 }`, `stroke`, `arrowSize` — this
  section's own worked example), independent of `themeId`. The app reuses that
  same constant (`apps/web/src/state/metrics.ts`) rather than inventing a second
  one. Actually wiring per-theme metrics is an open gap for whichever stage next
  touches `ResolvedTheme`.
- **What the skip compares (F9 fix round 1, item 1; a blocker found on `main`).** It used to
  compare `geometryHash` with the engine and its options, which misses the graph and the measured
  label sizes that the `LayoutInput` is also built from: a label text edit never laid out again, and
  the box kept its old size around the new text. It now compares what `host.run` is handed — the
  engine, its options, the `LayoutInput` as JSON (plain data built in a fixed order) and the measure
  table's keys (metrics are a constant). Source spans are kept out of that key and compared only when
  the landed layout reported diagnostics: no engine or host step reads a span to place anything,
  only to locate a diagnostic, so an edit that only moves text keeps the layout, unless that would
  leave a diagnostic pointing at the wrong place. The key is not built when it cannot differ: the
  same graph object, the same table object and the same `geometryHash` (a theme switch between
  themes of equal geometry). A skip also aborts a request still in flight, which would otherwise
  land after it with an input since superseded.
- **The paint-only skip condition's "engine/options unchanged" half.** `lastGood`'s
  shape (`{ styled, layout, svg, styleBlock }`, above) has no field to compare
  `engineId`/`engineOptions` against, so the app tracks the engine id and a
  stable-stringified options key of the *last issued* layout request separately,
  alongside the `styled.geometryHash === lastGood?.styled.geometryHash` check
  this section names.

### Render (computed)

```
svg = computed(() => layout.value && (paintOnly(last, styled.value, layout.value, layoutTable) ?? render(styled.value, layout.value, theme.value, layoutTable)))
```

**A18 (DD-11 T42): `layoutTable`.** `render()` takes the measure table, and draws each boxed label on the lines its entry holds. The render stage passes the table **the landed layout was sized from**, which the layout effect keeps beside `layout` and sets with it, not the latest `table`: after an edit, the new table lands before the new layout, and drawing its breaks inside the old frames would put a label on lines that sized no node. A theme switch between themes of equal geometry measures nothing and lays out nothing, so `layout` and `layoutTable` are both the same objects and the paint-only guard (`paintPlan.text`, DD-07 §6) holds (`apps/web/test/rich-text.test.ts`).

When `svg` produces a result **and** `diags` contains no `error`, it becomes `lastGood`. The canvas always displays `lastGood`; this is FR-E4 in one line.

A paint-only change (`geometryHash` equal, `paintHash` different) skips *layout* — the layout effect's skip condition above. **Since F9 (`feat/theme-fast-path`) it skips the render too, when that is safe.** Since Stage L's F7/F14 re-baseline paint class names are cascade signatures and marker ids name no colour (DD-07 §6), so two renders of the same layout with equal `RenderResult.structureHash` differ only in the `<style>` (and, in principle, `<defs>`) text; before it they could not (paint classes were `s-{paintHash}`, and a marker baked its stroke colour into its `fill` and its `id`, F7).

- **When:** only the effective theme has changed since the last render — the same `graph` object (so the same document; a document whose own `@theme` is edited has a new graph and takes the full path), the same `layout` object and the same `geometryHash` (an early exit: `structureHash` covers it) — and `renderPaintOnly` (DD-07 §6) finds `structureHash` unchanged too. "The same layout object" means the frames the last full render was drawn with, not frames current for the graph: after a text edit the full render uses the old frames until the new layout lands, and a theme switch in between restyles those frames exactly as a full render would; the layout effect lays out again whenever the `LayoutInput` differs (above), and the landed layout is a new object, so the next render is full.
- **What:** `renderPaintOnly(last.result, styled, layout, layoutTable)`: the new `<style>` text from one style per paint rule of the last render (one per distinct cascade signature; `styleGraph` itself resolved each signature once, DD-04 §5), no `render()`, and the same `paintPlan`, which tells the canvas it can swap that text into the tree it already shows (§6) instead of replacing `innerHTML`.
- **Otherwise,** or when `renderPaintOnly` refuses, a full `render()`, as before.
- **`lastGood.svg`** is a getter onto the result's own: after a paint-only render it is derived on first read, by replacing the `<style>` text in the last full string (`withStyleBlock`, byte-exact, DD-07 §6), and nothing on the switch's own path reads it (P4). Export, Save ▾ SVG, autosave's `lastGoodSvg` and so the next boot's J6 paint all read the exact bytes `render()` would give; §9 says how autosave avoids reading it early.

Either way the result is exactly what `render()` gives. `apps/web/test/theme-fast-path.test.ts` covers the choice and every consumer's bytes; `apps/web/test/paint-swap.browser.test.ts` the DOM (§6). On the bench (`pnpm bench:theme`, execution plan §2.1 F9) a Theme ▾ pick with no `@theme` now costs, at 2 000 nodes, ~3–4 ms of script and ~40 ms of Chromium's own style recalculation, the floor: met on a quiet machine, marginally.

### Timing budget on a keystroke (500-node document)

| Step | Where | Budget |
|---|---|---|
| CodeMirror incremental reparse | main | < 2 ms |
| `buildAst` → `resolve` → `compile` → `styleGraph` | main, sync | < 15 ms |
| pre-measure delta | main | < 5 ms (only changed labels) |
| layout | worker, debounced | not on the keystroke path |
| render + `innerHTML` | main | < 20 ms |

Nothing on the keystroke path awaits the worker. Typing stays responsive even when layout is slow; the chip says "laying out…" after 300 ms.

---

## 4. Editor

- `EditorState` with `LRLanguage` from `@sgl/core/editor` (DD-01 §6), `history`, `foldGutter`, `bracketMatching`, `closeBrackets`, `highlightActiveLine`, `lintGutter`.
- **Diagnostics** → `setDiagnostics(state, diags.map(toCmDiagnostic))` on every `diags` change; severity maps `error → error`, `warning → warning`, `info → info`. Spans are already offsets, so no conversion.
- **Source of truth is the editor state.** `source` is updated from `EditorView.updateListener`; programmatic changes (open file, load share) dispatch a transaction replacing the document, so undo history survives. *Superseded for Open and for switching documents (human decision, 2026-09-23; §7, §9):* those load a **different** document, so the text is still replaced by a transaction (the pipeline hears it through `updateListener`) but the undo history then starts empty (`loadDocument`) — undo never crosses from one document into another.
- **Tree reuse**: `syntaxTree(view.state)` is read inside `parsed`; the app never calls `parser.parse` on its own.
- **The tree handed over is always complete (F19).** CodeMirror parses incrementally: a transaction parses for about 20 ms or to the end of the viewport, and a background worker parses the rest later — a step that changes no text, so no `updateListener` call reports it, and that stops 100 000 characters past the viewport anyway. So `syntaxTree(state)` can cover only part of a document just replaced (Open, Documents ▾) or just booted, and `buildAst` would read that as a document ending at the cut (an `SGL1001` there, every later node gone). The `updateListener` therefore passes `completeSyntaxTree(state)` (`editor/complete-tree.ts`): CodeMirror's own `ensureSyntaxTree(state, state.doc.length)`, which returns the existing tree at once when it is already whole and otherwise runs the same parse context on to the end, synchronously and with no time limit, keeping what was already parsed. It is still the editor's parse, not a second one. The cost lands only where the tree is incomplete — a keystroke whose incremental reparse finished inside its transaction pays one `isDone` check — and there it is smaller than the synchronous `buildAst` → … → `render` the pipeline runs on the same text straight after, so deferring it would only delay that render while the editor and the pipeline disagreed about the document. As a backstop, `parsed` refuses a tree whose length differs from its text: that is a programming error (§13) — the last good stages are held and the chip reports a crash — never a truncated document rendered or diagnosed.
- Autocomplete **⟶ E6**; source mapping **⟶ E7** — both hook here with no other changes.

---

## 5. Fonts

Inter (Regular 400, Medium 500, SemiBold 600) is bundled as WOFF2 and declared via `@font-face` in the app CSS with `font-display: block` — block, not swap, so the first measurement is never against a fallback. `measurer.ready()` (DD-05 §4) is awaited before the first pre-measure; the boot sequence shows the last-good SVG from storage (if any) while fonts load, so there is no blank canvas.

**Implemented (Stage I part 2), `apps/web/src/fonts.css`.** Hand-written `@font-face` rules — Latin subset only, `font-display: block` — pointing at `@fontsource/inter`'s own WOFF2 files, rather than importing that package's `400.css`/`500.css`/`600.css` directly: those ship every Unicode subset (cyrillic, greek, vietnamese, …) at `font-display: swap`, which is the one thing this section specifically rules out. The font's SIL Open Font License ships with the build: `apps/web/public/fonts/OFL.txt` (the `@fontsource/inter` package's own `LICENSE`, verbatim) lands at `dist/fonts/OFL.txt`, with a one-line attribution in the root `README.md` (fix round 1).

**A18 (DD-11 T26, T28; human decision 2026-09-25): the run faces.** Seven more faces draw markdown runs (T25): Inter 700 (`strong`), Inter italic 400, 500, 600 and 700 (`em` at each role's base weight, and `strong` + `em`), and IBM Plex Mono 400 and 700 (`code`, and strong code), Latin subset, from `@fontsource/inter` 5.3.0 and **`@fontsource/ibm-plex-mono` 5.3.0** (OFL-1.1; a new dependency, approved with T26). **None is on the boot path, not even as CSS:** `fonts.css` declares only the three boot faces, and `src/io/run-faces.ts` registers the seven with the CSS Font Loading API (`new FontFace(…, { display: 'block' })` added to `document.fonts`) when the lazy `rich-text` chunk is evaluated — before the import resolves, so before the pipeline marks the chunk loaded and measures anything of the document. `measurer.ready()` then asks `document.fonts.load` for exactly the faces the document's runs use (`distinctTextStyles` iterates `labelRuns`, which applies `runStyle`), so they arrive before the first layout that needs them; a document without markup or a box declares and fetches none of them (`e2e/rich-text.spec.ts`, `e2e/pwa.spec.ts` on the built CSS). No stylesheet is injected, so the CSP is unchanged (`font-src 'self'`; `e2e/csp.spec.ts` walks a markdown document and its exports). A document without markup that asks for weight 700 or italic through a theme or `@style` is drawn with Inter 600 or a synthesised slant, as before A18. All ten faces are precached (§12). Plex's licence ships as `fonts/OFL-IBM-Plex-Mono.txt` (`apps/web/public/fonts/`), attributed in the root `README.md`. `apps/web/test/fonts.test.ts` holds `fonts.css`, export's `SHIPPED` list and T26's set together; `e2e/dd08-14.spec.ts` repeats §14's font gate with italic, bold and code labels (cold and warm layouts equal); `apps/web/test/rich-measure.browser.test.ts` checks in Chromium that every wrapped line's `getComputedTextLength()` is within 0.5 px of its measured width.

**Implemented (Stage J, decision J6): the boot paint.** `main.tsx` opens IndexedDB before the first render (`io/app-boot.ts`, milliseconds), and the canvas paints the open document's stored `lastGoodSvg` into the wrapper `<g>` while `lastGood` is still `null` — before `measurer.ready()` or the worker has answered — fitted to the stored SVG's own `viewBox` (`svgExtent`, `canvas/viewport.ts`). The wrapper carries `data-origin="stored"` until the first live render replaces it (`data-origin="live"`), which fits again: for the same document that lands on the same transform, and it records §6's fit baseline against real bounds. The stored picture is this document's own `render()` output from our own origin's storage, so it gets the same trust as `lastGood.svg`. A first visit (nothing stored) still shows a blank canvas until the first render, as before. `apps/web/e2e/persistence.spec.ts` holds the worker script and every font and asserts the stored picture is on screen and nothing live is.

**A real, unrelated bug surfaced and fixed while proving this**: the layout effect (§3) fired once on boot with `table` still at its initial `{}`, laying every label out at zero size before the real premeasure table landed and produced a second, correctly-sized layout — a genuine "wrong size, briefly" flash on every cold load, nothing to do with fonts (`document.fonts` already reported every face loaded by the time either layout ran). Fixed with a `hasMeasuredOnce` guard on the layout effect; see §3's own update and execution plan §2.

---

## 6. Canvas

```svg
<svg class="host" width="100%" height="100%">
  <g class="viewport" transform="translate(tx ty) scale(k)">
    <g class="rendered" data-theme="…" data-paint-hash="…">  <!-- the wrapper -->
      <!-- lastGood.svg — the exported tree — inserted via the wrapper's innerHTML -->
    </g>
  </g>
  <!-- a sibling of g.viewport, never inside g.rendered: never exported -->
  <g class="overlay" transform="(same as g.viewport)">
    <rect class="node-outline hover"/> <rect class="node-outline selected"/>
  </g>
</svg>
```

The wrapper `<g class="rendered">` is what `innerHTML` replaces; its only child
is `lastGood.svg`'s own `<svg>`, which is exactly what Save ▾ SVG exports
(§7). The overlay carries the same transform as the viewport but sits beside
it, so no outline can ever end up in the exported markup
(`apps/web/e2e/canvas.spec.ts` asserts both). `data-theme`/`data-paint-hash`
name the render currently on screen (fix round 1): the e2e suite waits on
them after a theme switch instead of sleeping.

- **Pan**: pointer drag on empty space; **zoom**: wheel (ctrl/⌘ + wheel or pinch on trackpads) centred on the cursor; `k ∈ [0.1, 8]`.
- **Fit**: on document open and on the toolbar button — `k = min(vw / bounds.w, vh / bounds.h) × 0.94`, centred. **Not** on every render: the viewport is preserved across re-renders so the diagram does not jump while typing. When `bounds` changes size by more than 40 % the chip offers "Fit".
- **Hover** on a node adds `.hover` to the overlay outline computed from the node's frame (read from `lastGood.layout`, not from the DOM). **Click** selects (outline) — the hook for **⟶ E7** source mapping, which will scroll the editor to `graph.nodes[id].span`.
- `innerHTML` replacement: the wrapper `<g>` is replaced wholesale. At 2 000 nodes that update measures ~50 ms in Chromium, plus ~80 ms of the style recalculation and layout it causes (`pnpm bench:theme`, a Theme ▾ pick on a document with `@theme`). `morphdom` on the wrapper, an earlier plan, measured **slower** than this at every size and is dropped.
- **Paint-only swap (F9, `canvas/paint.ts`'s `showLastGood`).** The canvas remembers the `paintPlan` of the render it last put in the wrapper (`null` for nothing or the stored boot picture). A `lastGood` with that same plan differs from what is on screen only in its `<style>` text (§3, DD-07 §6), so only that text is replaced (`textContent` of the one `<style>`: the parser builds the same text node from `render()`'s escaped text), with no parse, no new elements and no read of `lastGood.svg`; anything else replaces `innerHTML`. `apps/web/test/paint-swap.browser.test.ts` checks in Chromium and Firefox, for the whole corpus both ways (`neutral-light` ↔ `neutral-dark`, `neutral-light` ↔ `high-contrast`, `high-contrast` ↔ `print`) and the synthetic theme pair, that the swapped DOM serialises (`innerHTML` and `XMLSerializer`) exactly as a full render's; `e2e/theme-picker.spec.ts` that after a pick the DOM is the one a reload renders afresh. A switch at 2 000 nodes is then ~40 ms of Chromium style recalculation (the floor: the measured cost of replacing one rule's text is already ~24 ms) plus ~3–4 ms of script.
- `data-paint-hash` is removed at every swap and stamped after the next frame (`requestAnimationFrame`, then a task) if that render is still on screen: it reads `StyledGraph.paintHash`, which is computed on first read (DD-04 §5), and nothing on screen depends on it. `data-theme` is stamped with the swap as before; the e2e helper `paintHash()` waits for the stamp.

---

## 7. Files

**Open** — toolbar, `Ctrl/⌘+O`, or drag-drop (**⟶ F2**; the handler is the same function). `<input type="file" accept=".sgl,.sgl.json,.json,.txt">` → `file.text()` → dispatch a replace-document transaction. Every extension goes through the same Lezer parser (JSON is SGL); the extension is remembered on the document for the default save name. Files over 2 MB are refused with a toast.

**Save ▾** — Blob download via a transient `<a download>`:

| Item | Name | Content |
|---|---|---|
| SGL | `{title}.sgl` | `source` verbatim |
| Canonical JSON | `{title}.sgl.json` | `toJson(model)` |
| SVG | `{title}.svg` | `lastGood.svg` with export options (background, scale) and the Inter weights it uses embedded (D2, below) — the options UI is deferred to **⟶ D10** (Stage L); today the default options (background on, scale 1), which are `render()`'s own output |
| PNG (D6) | `{title}.png` | rasterise `lastGood.svg` via `<img>` → canvas → `toBlob`, at a chosen scale (1×, 2×, 3×; 2× by default), `width × scale` by `height × scale` pixels, with Inter embedded in a rasterisation-only copy (below) |
| Copy SVG (D7) | clipboard, `text/plain` | the SVG item's text, byte for byte (fonts embedded, D2), as a `ClipboardItem` whose text is a promise, or `navigator.clipboard.writeText` where there is no `ClipboardItem` |
| Copy PNG (D7) | clipboard, `image/png` | the PNG item's image at the default scale (2×), as `navigator.clipboard.write([new ClipboardItem({ 'image/png': promise })])` |

`title` = `@title` or the first node key or "diagram", sanitised for filenames. **⟶ F3** File System Access `showSaveFilePicker` replaces the download when available, same call site.

**Implemented (Stage J).** The decisions are DOM-free and Node-tested — `apps/web/src/state/filename.ts`, `state/files.ts` (`apps/web/test/files.test.ts`); the DOM around them is `toolbar/FileMenu.tsx` and `io/download.ts`. What this section left open, settled:

- **One Open path.** The toolbar button, `Ctrl/⌘+O` (a capture-phase `keydown` listener, so it wins over CodeMirror and the browser) and the launch queue (§12) all call the same function: size check → `file.text()` → a new local document (next bullet) → fit on the next render (§6's "fit on document open"). The 2 MB check runs on `file.size` *before* anything is read; exactly 2 MB opens, one byte more is refused. An Open that has been read before the editor view exists (the launch queue can deliver during the first render) is held — the latest one — and applied once the view is up, never dropped (fix round 1; `state/open-queue.ts`).
- **Save ▾ is a disclosure** (`<details>`) of plain buttons, not an ARIA menu — it does not implement a menu's arrow-key model, so it does not claim the role. Escape closes it (focus back on its summary), and so does a pointer-down outside it (fix round 1).
- **An extension Open does not accept** (the `accept` list is advisory in every file chooser, and the launch queue bypasses it) is refused with a toast, like an oversize file, rather than opened as text.
- **Open creates a new local document** (human decision, 2026-09-23; it replaces Stage J's first rule, "Open replaces the current document's text", under which the previous stored document was overwritten 500 ms later). The open document's pending autosave is flushed first, so its last edits land in its own record, which is otherwise left exactly as it was. The new record gets a new id, the opened text, the remembered extension and the current engine, theme and options; it becomes `lastOpenDocId` and is loaded into the editor with a fresh undo history (§4). A toast says "Opened {filename} as a new document. Your previous document is in Documents." — which is where it is (§9). Share does the same (§8). DOM-free part: `state/documents.ts` (`switchDocument`) and `DocumentSession.switchTo` (`state/document-session.ts`).
- **"The extension is remembered … for the default save name"** is read as: each Save ▾ item keeps the remembered extension when it is one of its own — a document opened from `.txt` saves its source as `{title}.txt`, one opened from `.json` saves canonical JSON as `{title}.json` — and otherwise uses its own default (`.sgl`, `.sgl.json`). The extension is stored on the document record (§9, `fileExtension`).
- **Canonical JSON is refused while the document has a parse or resolve error**, with a toast pointing at the SGL item: the model is partial then, and `toJson` of it would quietly drop whatever did not parse. The SGL item always saves the text exactly as it is.
- **SVG** is `lastGood.svg` with its fonts embedded (D2, below) and otherwise unchanged: the default export options (background on, scale 1) are `render()`'s own output (DD-07 §9: the `.canvas` rect *is* the background; scale multiplies `width`/`height`). Before the first live render it is the stored `lastGoodSvg` (§9) — the same document's last good picture. The export-options UI is not built: it is **D10**, scheduled in Stage L (execution plan §5).
- **Title fallback.** A blank `@title` falls through to the first node key, which is the first top-level key in declaration order (`model.root.children[0]`). **Sanitising**: bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E/U+200F — they can make `evil\u202Egpj.svg` display as `evilsvg.jpg`) and zero-width characters (U+200B–U+200D, U+FEFF) are removed; whitespace runs become one space; `<>:"/\|?*` and control characters become `-`; leading and trailing dots, dashes and spaces are stripped (Windows drops a trailing dot; a leading one hides the file on Unix); the stem is capped at 120 **code points** (never splitting a surrogate pair); a Windows device name as the part before the **first** dot (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM0`–`COM9`, `LPT0`–`LPT9`, and `COM`/`LPT` with a superscript `¹` `²` `³` — `con.backup` is as reserved as `con`) gets a `_` after it; an empty result is `diagram` (fix round 1 added the invisibles, the first-dot rule, the extra device names and the code-point cap).

**Implemented (Stage L, D6 and D7, `feat/export-png`).** DOM-free part: `apps/web/src/state/png.ts` (`apps/web/test/png.test.ts`); DOM part: `io/png.ts` and the `SaveExtras` component and `savePng`/`copySvg`/`copyPng` in `toolbar/file-actions.tsx` (`test/png.browser.test.ts`, `e2e/png-export.spec.ts`). All of it is in the lazy `file-actions` chunk; Save ▾ starts loading that chunk when it is opened and shows these items once it has loaded. What the rows above left open, settled:

- **The UI.** Save ▾ stays a disclosure of plain controls with no menu roles. After SVG image come PNG image, then its scale as a native radio group (a `<fieldset>` showing "Scale", named "PNG scale" for assistive technology; 1× · 2× · 3×, 2× checked), then Copy SVG and Copy PNG. The scale is kept while the page is open and is not stored. Copy PNG always uses 2×, whatever scale is selected: the clipboard is for pasting into a document or a chat, where 2× is right for a high-DPI screen, and one fixed scale keeps the item a single click.
- **Fonts: the rasterisation-only copy.** An SVG drawn through `<img>` is an isolated document. It cannot use the page's web fonts (§5) and cannot load anything except `data:` URLs, so rasterising `lastGood.svg` as it is would draw every label in a fallback face whose glyphs have a different shape and width from the ones the layout was measured with. So the PNG item rasterises a **copy**: the Inter faces the `<style>` asks for (400 always, plus 500 and 600 when a `font-weight` names them) are put at the start of its one `<style>` element as `@font-face` rules with `data:font/woff2;base64,…` URLs. The WOFF2 files are the ones `fonts.css` loads (Vite gives both the same hashed URL). They are fetched from our own origin, or offline from the precache, once per page. In the copy, the root's `width`/`height` are also set to the pixel size, with `preserveAspectRatio="none"` and the `viewBox` kept, so the vectors are drawn at full resolution rather than a 1× bitmap scaled up, and rounding to whole pixels (a change of under half a pixel) never leaves a transparent edge. The copy is never saved or shown. The embedding is the same function Save ▾ SVG and Copy SVG use (D2, below), applied to the copy after it is resized, so only the weights the diagram uses are fetched (before D2, 400 was always embedded). If the fonts cannot be fetched, the PNG is refused with a toast rather than drawn in the wrong face. `png.browser.test.ts` checks that the text in the PNG is Inter: the ink of a probe line at each weight ends where canvas `measureText` with the same WOFF2 files says it should, to within 3 px, where the unembedded copy misses by about 30 px.
- **Size and background.** The PNG is `round(width × scale)` by `round(height × scale)` pixels (at least 1), with `width`/`height` from the root element. The background is whatever the SVG draws: its `.canvas` rect in the theme's canvas colour (DD-07 §9), opaque to every edge. A future transparent-background SVG (D10) would give a transparent PNG with no change here.
- **The pixel cap.** A PNG is refused, with a toast and before anything is fetched or drawn, when either side would be over **16 384 px** or the total over **8192² ≈ 67 Mpx**. Past sizes like these, browsers fail a canvas silently, with a blank image or a `null` blob rather than an error. Chromium's and Firefox's per-side limit is 32 767 px, and Safari's area limit is lower still on some devices. 67 Mpx of RGBA is 256 MiB, which the canvas holds while `toBlob` encodes a second copy. The toast gives the size, states the limit, and names the largest smaller scale that fits (or points at the SVG when none does). A draw that still fails (a `null` blob, a decode error) gets its own toast.
- **Copy.** Copy SVG is plain text, which every editor and design tool accepts: the same bytes Save ▾ SVG saves (D2). Since the fonts are fetched first, it hands `ClipboardItem` a `text/plain` promise inside the click, as Copy PNG does, and uses `writeText` after the fetch only where `ClipboardItem` is missing. The `image/svg+xml` clipboard type is not used, since support for it is new and uneven. Copy PNG passes the image to `ClipboardItem` as a **promise** and calls `clipboard.write` inside the click. Safari refuses a clipboard write that starts after an `await`, because by then the user activation it needs is gone. It checks the pixel cap first, synchronously. Each item toasts its outcome: "SVG copied" / "PNG copied" (info), or an error toast when the browser has no clipboard API here, refuses access, or the PNG could not be made (that refusal's own message). Nothing is copied before anything has rendered. Before the first live render, the stored `lastGoodSvg` is used, as for Save ▾ SVG.

**Implemented (Stage L, D2, `feat/svg-fonts`; human decision 2026-09-25: exported SVGs always embed the Inter weights they use).** Save ▾ SVG, Copy SVG and the PNG's rasterisation-only copy all pass through `withEmbeddedFonts` (`apps/web/src/io/fonts.ts`), which asks `usedFontFaces` (`@sgl/render-svg/fonts`, DD-07 §9) which of the shipped faces — Inter 400/500/600, Latin, the very WOFF2 files `fonts.css` loads, and since A18 (DD-11 T49) the seven run faces too (`RUN_FACES`, the same module the `rich-text` chunk registers them from) — the SVG uses (per element when it has run tspans, T50), fetches only those (from our own origin, or offline from the precache; once per page, a failure not kept), and calls `embedFonts`. The embedding happens where an SVG leaves the app and nowhere else: `lastGood.svg`, the canvas, autosave's `lastGoodSvg` and the J6 boot paint stay `render()`'s output. If a face cannot be fetched, Save ▾ SVG and Copy SVG are refused with a toast ("the diagram's font (Inter) could not be loaded…"), as the PNG is, rather than hand over a file that draws in the wrong face. No subsetting: the three weights add up to about 97 kB of base64 (the app's `checkout.sgl`: 8 206 → 105 131 bytes). All of it is in the lazy `file-actions` chunk. Tests: `e2e/svg-export.spec.ts` (exactly the used weights, base64 that decodes to the shipped bytes, the exported file loaded as an `<img>` inks its label within a pixel of Inter's metrics and misses by ~10 px without the faces, Copy SVG equal to Save ▾ SVG, a failed fetch refused), an offline case in `e2e/offline.spec.ts`. Checked by hand in **Inkscape 1.2.2**: it parses the rules, warns "font face rule limited support" and draws with an installed face (DejaVu Sans here, Inter not being installed), byte-identical to the unembedded file; the rest of the `<style>` still applies. That is Inkscape's limitation, not D2's. Figma not checked (no access).

---

## 8. Share by URL

```
https://…/#s={base64url(deflate-raw(utf8(source)))}&e={engineId}&t={themeId}
```

- Encode: `new CompressionStream('deflate-raw')` → `Uint8Array` → base64url (no padding).
- Decode on load: if `location.hash` has `s=`, inflate with a **hard cap of 2 MB inflated** (decompression bomb guard); on failure toast "This share link is not valid" and open the last document instead.
- Size guard: if the whole link (origin, path and fragment — what actually gets pasted and truncated) exceeds 8 000 characters, the Share dialog warns that some chats and browsers truncate long URLs and offers the file save instead.
- Opening a share link creates a **new local document** (never overwrites the current one) and clears the hash so a reload does not re-import.
- The fragment never reaches a server. **⟶ F6** short links are a separate button that *does* upload; that distinction is shown in the dialog.

**Implemented (Stage J), `apps/web/src/state/share.ts` + `base64url.ts`** (Node-tested with Node's own `CompressionStream`, `apps/web/test/share.test.ts`; boot's handling in `state/boot.ts`, `test/boot.test.ts`). Settled here:

- **The cap stops reading, not checking.** The reader is cancelled the moment output passes 2 MB, and the compressed input is fed to the `DecompressionStream` in 512-byte slices: a `TransformStream` inflates each *written* chunk in full whatever the reader does, so the slice size is what bounds the overshoot (deflate's maximum ratio is about 1032:1, so about 0.5 MB). A fragment whose compressed payload alone could not inflate to under the cap is refused before its base64 is decoded.
- **Invalid** means: not canonical unpadded base64url (padding, `+`/`/`, an impossible length or non-zero trailing bits are all refused), a malformed or truncated deflate stream, output that is not UTF-8 (`TextDecoder` with `fatal: true`), or output past the cap. Every case gives the same toast, "This share link is not valid", and every one is a value, never a throw.
- **Invalid link → the hash is cleared too**, not only on success, so a reload does not repeat the toast; then boot carries on as if there were no link (`lastOpenDocId`, else the example).
- **`e`/`t`** carry the *effective* engine and theme (what the sharer sees). A receiver that does not know one — an engine not registered, a theme not built in — uses its default instead; the document's own `@layout.engine`/`@theme`, if any, travel in the source anyway.
- The dialog (`toolbar/FileMenu.tsx`) says the diagram is inside the link and nothing is uploaded; it offers Copy (falling back to selecting the text, with a toast, where the clipboard API is refused) and, for a long link, "Save as a file instead" (the SGL item). A successful open says so in a toast ("Opened the shared diagram as a new document. Your previous document is in Documents.") — §11's "toasts for share outcomes". Opening the dialog moves focus to the link (selected); Escape closes it without tabbing in first, and Escape or Close returns focus to the Share button (fix round 1).
- **A lazy chunk** (F9 fix round 1): `share.ts` and `base64url.ts` are loaded by dynamic `import()` — at boot only when the hash has an `s=` payload, and by Share and a pasted link when used — to keep the core bundle under DD-09 §2's 180 kB; they are precached like every chunk, and `e2e/offline.spec.ts` shows Share and opening a link working offline from the precache alone.
- **Encoding never rejects** (fix round 1): where `CompressionStream` is missing or fails, `encodeShareFragment` returns `{ ok: false }` and the Share button toasts, pointing at Save ▾ → SGL source instead of doing nothing.
- **A link pasted into an already-open tab** (fix round 1). A same-document fragment change fires `hashchange` and never reloads, so "decode on load" alone would ignore it. The app decodes the new hash (`io/app-boot.ts`, `watchShareLinks`): an invalid link toasts, clears the hash and leaves the open document alone; a valid one flushes the open document's pending autosave (§9) and reloads with the hash in place, so boot imports it exactly as above — a new local document, the toast, the hash cleared. One import path, not a second in-page one.

---

## 9. Persistence

IndexedDB `sgl`, version 1, via `idb`:

| Store | Key | Value |
|---|---|---|
| `documents` | `id` (`crypto.randomUUID()`) | `{ id, title, source, engineId, engineOptions, themeId, createdAt, updatedAt, lastGoodSvg?, fileExtension? }` |
| `settings` | `key` | `{ key, value }` — `lastOpenDocId`, `splitRatio`, `themePreference` |

- Autosave 500 ms after the last change (source or settings) — `put`, whole record. `lastGoodSvg` is stored so the next open paints instantly before fonts and the worker are ready. `lastGoodSvg` must only ever hold `render()` output: boot paints it through `innerHTML` (§5, J6), so anything else written there would be markup the renderer never escaped.
- Boot: read `lastOpenDocId` → open it; else create a document from `examples/checkout.sgl`. A crash mid-edit loses at most 500 ms of typing.
- Multiple documents **⟶ E17**: the store is already a list; the deferred part is only the "≡ docs" drawer UI. *Partly pulled forward (human decision, 2026-09-23):* see "Documents ▾" below; the rest stays E17.
- Quota/`QuotaExceededError` → toast, editing continues in memory.

**Implemented (Stage J).** `apps/web/src/state/storage.ts` (the record types, the `DocumentStore` interface, an in-memory store), `state/storage-idb.ts` (the `idb` implementation), `state/autosave.ts`, `state/boot.ts`, `state/document-session.ts` — all but the `idb` adapter Node-tested against the in-memory store (`apps/web/test/{autosave,boot,document-session}.test.ts`); the adapter itself is exercised by the e2e suite against real IndexedDB. Settled here:

- **Ids are `crypto.randomUUID()`** (decision J2; this table said nanoid, which would have been a new dependency for no gain), with the fallbacks under "Boot never rejects" below. `apps/web` is outside the determinism ban; nothing below it generates ids.
- **`fileExtension`** joins the record: §7's remembered extension needs somewhere to live, and this table predates it. Additive and optional.
- **The record's `engineId`/`themeId` are the pickers' values.** A document's own `@layout.engine`/`@theme` already lives in its `source`. A stored engine or theme that is no longer registered/built in falls back to the default on open, and a stored record missing the fields the app reads is treated as missing.
- **Settings**: only `lastOpenDocId` is written. `splitRatio` has nothing to record (§2's draggable split is not built) and `themePreference` has no UI distinct from the per-document theme.
- **Autosave** writes the whole record 500 ms after the last change to the source, the pickers, the options or `lastGood`, so the stored `lastGoodSvg` follows the render. **Since F9 the record's `lastGoodSvg` is a getter onto `lastGood.svg`** (`state/document-session.ts`), so following a theme switch never derives a paint-only render's SVG: two live pictures are compared by which `lastGood` they come from, not by text, and the record reaches autosave with the getter intact (copied by property descriptor); the write, which clones the record, reads it — the exact bytes `render()` gives. Writes are chained, never concurrent (a slow write of an older record can never land after a newer one). A quota error toasts once per run of failures — not every 500 ms — and again only after a save has succeeded in between; any other write error does the same with its own toast. A pending write is flushed on `pagehide`, on `visibilitychange` to hidden, and before an update reload (§12). **The flush must reach the disk while the page is being torn down** (fix round 1): the flush issues its `put` synchronously from the event handler — not queued behind a write still in flight, which is safe because IndexedDB runs `readwrite` transactions on one store in creation order — and every IndexedDB write calls `IDBTransaction.commit()` straight after its `put`. Left to auto-commit, a transaction commits only after its request's success event has been dispatched, a later task that Chromium never runs for a page being unloaded; it aborts the transaction instead, and an edit made in the last 500 ms before a reload or tab close was lost every time.
- **Boot** (`io/app-boot.ts` + `state/boot.ts`) runs before the first render, so the stored `lastGoodSvg` paints immediately (§5). If IndexedDB will not open at all, the app runs on the in-memory store with a toast ("changes are kept in this tab only"); a storage failure at any later boot step does the same and never stops the boot.
- **Boot never rejects** (fix round 1). A new id comes from `crypto.randomUUID()` where it exists — only in a secure context, so not on plain http to a LAN address — else a v4 UUID from `crypto.getRandomValues`, else the time and a counter (`newDocumentId`, never a throw, no dependency). Anything else that throws during boot gives the example document on the in-memory store, with a toast ("Something went wrong opening your documents…"), and `main.tsx` catches a rejection the same way — never a blank page.
- **Documents ▾** (fix round 2; `toolbar/DocumentsMenu.tsx`, `state/documents.ts`): the minimal slice of E17, built now so a document left behind by Open (§7) or a share link (§8) can always be reached. A disclosure at §2's `[≡ docs]` position, with the same pattern as Save ▾ (plain buttons, no menu roles; Escape and an outside click close it). It lists every stored document by title and updated time ("5 min ago", a date after a week), most recent first, the open one marked (`aria-current`, "open now", shown as it is now rather than as last saved). Picking one flushes the open document's autosave, makes the picked one `lastOpenDocId`, loads it with a fresh undo history, paints its stored `lastGoodSvg` until its live render (§5's J6 paint, now after every switch too) and fits. "New document" starts an **empty** one (the example is only for a first visit). Merely opening a document does not save it again, so viewing never reorders the list. **Still E17 (Stage L):** delete, rename, search, tabs and multi-select.
- **The example document** is `apps/web/src/examples/checkout.sgl`, imported as text into the app chunk (so it is precached with it, §12). It is `corpus/checkout.sgl` — the spec's worked example — adapted so it renders with no diagnostics today: no `@layout: { engine: "layered" }` (the corpus file pins `layered`, which is roadmap and not registered, so every new user would have booted into `SGL4011` and a blank canvas), no `@vars`/`$hot` (A8), no `cloud` shape (not drawn yet), and no `@theme` pin, so the theme picker governs. **Stage K fix round 1 (item 23, human decision 2026-09-23):** nor `payments`' `@layout: { engine: grid, columns: 2 }` — a container-level engine now warns `SGL4010` (per-container engines are B8/B9), and so does `columns` under `elk`, so a first visit would have shown two warnings. The corpus file itself is unchanged: its goldens depend on its exact text.

---

## 10. Engine and theme pickers

- **Engine ▾** lists registered engines with name and `determinism` badge (ADR-0004). Selecting sets `engineId`, resets `engineOptions` to the engine's defaults.
- **Engine options** panel: MVP is a hand-built form per engine — `elk`: direction, node spacing, rank spacing, edge routing, node placement; `grid`: columns, gap, align. **⟶ B7** generates this from `optionsSchema`; the form values already round-trip through `engineOptions` so nothing else changes.
- **Theme ▾** lists the four built-in themes (DD-04 §7: `high-contrast`, `neutral-dark`, `neutral-light`, `print`, sorted by id) with a 24 px swatch of `bg/surface/ink/accent` (C5: `high-contrast`'s is white, white, black and its deep blue; `print`'s white, white, black, black). **It is a view preference** (human decision, 2026-09-24; F9 P1): picking sets `themeId`, which the document record persists (§9) and a share link carries as `t=` (§8), and leaves the source alone — unless the document sets `@theme` itself, in which case that entry is edited in place (below). The `themeId` write and that edit are one signal `batch`, so a pick is one style → render → paint (P2). Because every built-in theme shares `neutral-light`'s geometry, layout is skipped (§3's layout-effect skip), and with no `@theme` the render is a `<style>`-text swap (§3, §6).
- `@layout.engine` / `@theme` in the document **override** the pickers; the picker shows "(set by document)" and editing it writes into the document's root config via a transaction — the document stays the source of truth. Engine ▾ writes `@layout.engine` whether or not the document set it; Theme ▾ edits `@theme` only where the document already sets it, and never adds one.

**Implemented (Stage I part 2).** `apps/web/src/toolbar/{ThemePicker,EnginePicker}.tsx`, over pure
option-list builders in `apps/web/src/state/pickers.ts` (Node-tested). "Registered engines" is
`apps/web/src/App.tsx`'s own `REGISTERED_ENGINES` constant, read from `gridEngine` directly (the
same object `layout.worker.ts` registers) rather than from a shared registry object — the worker's
own `EngineRegistry` lives inside the worker, with no synchronous view from the main thread. The
engine options panel (this section's second bullet) is **not** built — F11 (execution plan §2.1),
owned by Stage K, which is when a second engine exists to prove the form's generality against.
Overriding writes through `apps/web/src/state/root-config-edit.ts`'s `setRootConfigString`
(fix round 1); Theme ▾ dispatches only its in-place edit, never its insertion (an edit replaces a
value span, never empty; an insertion is empty) (F9 P1), through
`selectTheme(pipeline, id, dispatch)`, which also runs the `themeId` write and the dispatch in one
`@preact/signals` `batch()` (P2: effects are deferred to the end of the batch and computeds are
lazy, so the pipeline paints once from the final state). The picker's own write must never make the document emit a diagnostic or grow a
second entry for the key, so it edits whatever already sets the key, in place: an exact
`@theme`/`@layout.engine` entry, or the `engine` property of an `@layout: { … }` object, whatever
the old value's kind; the last such entry, since later wins. An `@layout` object without `engine`
gets the property added inside it. A new `@key.path: "…"` line is inserted at the document's start
only when nothing sets the key and no parent object exists. The edit is built from the pipeline's
own `parsed` AST (§4: the app never calls `parse` itself — `apps/web/src/state/picker-actions.ts`,
enforced by a lint rule on `apps/web/src`). Selecting an engine resets `engineOptions` to that
engine's defaults (Stage K; `{}` before F11 gave engines real ones).

**Stage K.** The worker registers `elk` and `grid`, and **`elk` is the default** (ADR-0005),
ending Stage I's interim `grid` default (I1); a stored document keeps its own `engineId` (boot
already falls back to the default only for an engine the worker does not register).
`REGISTERED_ENGINES` (`io/app-boot.ts`) reads `elk` from `@sgl/layout-elk/descriptor` — everything
but `layout()`, and none of elkjs — so the pickers never pull elkjs into the main thread.
**The engine options panel (F11) is built**, as one hand-built form per engine (K9):
`state/engine-options.ts` holds each engine's fields, labels and defaults, normalises the
untrusted stored bag (a value the field does not allow shows, and — since Stage K fix round 1,
item 3, when `state/pipeline.ts` began sending `optionsForEngine(engine, bag)` rather than the
stored bag raw — is also *sent*, as the default: before that, grid's `columns: "x"` reached grid
and threw `SGL4011` while the form showed `auto`) and
writes one field at a time. A refused value (fix round 1, item 22) — not a choice, not a number,
or outside the field's range: elk node/rank spacing 0–500 px, grid gap 0–200 px, grid columns
1–50 — is not written; the field gets `aria-invalid`, a visible `role="alert"` message says why and
which value is in use, and the box shows that value again; a stored value beyond the range is shown
and sent as the default. It is Node-tested,
including that every default and select choice is one the engine's own `optionsSchema` allows.
Since A8 fix round 2 the form is split for the bundle (DD-10 §2): `state/engine-options.ts` keeps the defaults and normalisation the pipeline needs at boot, and the fields, labels and edit rules are `state/engine-form.ts`, rendered by `toolbar/engine-options-form.tsx`, a lazy chunk loaded when Options ▾ is first opened.
`toolbar/EngineOptions.tsx` renders the *effective* engine's form beside Engine ▾ as a plain
`<details>` disclosure — the Save ▾ pattern (`toolbar/disclosure.ts`): no menu roles, Escape and
an outside pointer-down close it, every input has a `<label>`. Values go through the existing
`engineOptions` signal, persisted on the document record (Stage J). `elk`: direction, node
spacing, rank spacing, edge routing, node placement. `grid`: columns (an empty box is `auto`),
gap, align. `e2e/engine-options.spec.ts` covers it end to end (fix round 1, items 3, 13, 22):
Direction → Right re-lays out and persists across a reload, an engine switch resets the form,
a stored bag grid cannot use still renders, and a refused value is flagged. **⟶ B7** still
generates the form from `optionsSchema`. Left as is: when
`@layout.engine` in the document overrides the picker, the form edits the same `engineOptions`
bag for the document's engine; there is one bag per document, not one per engine.

---

## 11. Diagnostics panel and status chip

- Panel rows: severity icon, code, message; click scrolls the editor to `span.from` and selects the span. Sorted by offset.
- Chip states: `idle` (hidden) · `laying out…` (after 300 ms in flight) · `Showing last good render · {n} errors` (any error diagnostic) · `Layout timed out — showing previous` (`SGL4001`).
- Toasts for file and share outcomes only; never for diagnostics.

**Implemented (Stage I part 2).** `apps/web/src/panels/{DiagnosticsPanel,StatusChip}.tsx`, over
`apps/web/src/state/chip.ts`'s pure `deriveChipState` (Node-tested, `apps/web/test/chip.test.ts`)
— the panel/chip components are thin renderers of already-computed state, per I3's "put the chip's
state logic in the DOM-free state layer." One addition this section didn't name: `offerFit`, DD-08
§6's "when bounds change by more than 40% the chip offers 'Fit'" — folded into the same `ChipState`
as an independent boolean (it can co-occur with any of the four named states), tracked by
`pipeline.ts`'s own bounds-vs-last-fit comparison, cleared by `Pipeline.fitDone()`, which the
canvas calls after every fit (on open, or the toolbar button — DD-08 §6's `⟳fit` moved from a
floating canvas button to the toolbar in part 2 to match this section's own screen sketch, §2).
**Toasts (Stage J; fix round 1)**: `apps/web/src/state/toasts.ts` (Node-tested) and `panels/Toasts.tsx`.
An `info` toast sits in a polite `role="status"` region and dismisses itself after 8 s or on its ×.
An `error` toast sits in a `role="alert"` region and is **never dismissed by time** — it stays until
its × is clicked, so a failure that appeared while the user looked elsewhere is still there to read.
Both regions are always in the DOM, so assistive technology is already watching them. Used for Open/Save
refusals, share-link outcomes, storage failures, the Share dialog's copy result, and Save ▾'s PNG
refusals and Copy SVG/PNG outcomes (D6, D7; §7) — never for diagnostics.

**Decision (fix round 1): chip priority.** When several states hold at once, the chip shows the
highest of **crashed > timeout > errors > laying out > idle** (`deriveChipState`). A crash (§13)
wins because nothing else is safe to claim once the pipeline itself has thrown. `SGL4001` is more
specific than the generic error count. The error count beats "laying out…" because a retry in
flight after an error is still showing last-good-with-errors until it lands. The "Fit" offer is
independent of all five.

---

## 12. PWA

`vite-plugin-pwa`, `generateSW`:

- Precache: app shell, both engine chunks (the `elk` chunk is large and is precached deliberately so offline first-render works), Inter WOFF2 (and, since A18, the seven run faces: Inter 700, Inter italic 400–700, IBM Plex Mono 400/700), both themes, the example document.
- `navigateFallback: 'index.html'`; `skipWaiting` gated behind an "Update available — reload" chip so an in-progress edit is never lost.
- `manifest.webmanifest`: name, icons (192/512, maskable), `display: standalone`, `file_handlers: [{ action: '/', accept: { 'text/plain': ['.sgl'], 'application/json': ['.sgl.json'] } }]` — with `launchQueue` consumer in the app that routes to §7 Open.
- Offline is the full experience: nothing in MVP fetches after the shell loads.

**Implemented (Stage J), `apps/web/vite.config.ts` + `src/io/pwa.ts` + `src/io/launch-queue.ts`.** Settled here:

- **Only registered engines are precached (decision J1), by construction.** The precache is every file the build emits that `globPatterns` matches (`**/*.{js,css,html,woff2,png,svg,txt}`, plus the manifest). An engine chunk is only emitted once something imports it — today the worker bundle, which registers `grid`, is the only engine code — so Stage K's `elk` joins the precache by being registered in `layout.worker.ts`, with no change here. The "both engine chunks" wording above assumed `elk` would already exist. Workbox *skips* a file over its size cap with only a build warning, so the cap is raised to 8 MiB and `apps/web/e2e/pwa.spec.ts` fails if any emitted file is ever missing from the precache — that is what will catch an oversize `elk` chunk.
- **What the list above names, concretely**: the shell (`index.html`, the app, editor and grid chunks, CSS), the worker, the three Inter WOFF2 files and `fonts/OFL.txt`, the icons and the manifest. **A18** adds the seven run faces (about 156 kB; the precache's fonts grow from about 72 kB to 228 kB, `pwa.spec.ts` names each) and `fonts/OFL-IBM-Plex-Mono.txt`; the lazy `rich-text` chunk is precached like every chunk. **Both themes and the example document** are compiled into the app chunk (`@sgl/theme`'s built-ins; `examples/checkout.sgl` imported as text), so they are precached with it rather than as files of their own.
- **Registration is hand-written** (`io/pwa.ts`, production builds only) instead of `vite-plugin-pwa`'s `virtual:pwa-register`, which would put `workbox-window` in the app bundle. `generateSW` runs with `skipWaiting: false` and `clientsClaim: false`, so the generated `sw.js` only calls `skipWaiting()` on a `{ type: 'SKIP_WAITING' }` message. A worker that installs behind an existing controller shows the toolbar's "Update available — reload" chip; clicking it flushes autosave (§9), then messages the worker, and the page reloads on `controllerchange` — only for an update the user accepted, never for the first install. The browser re-checks `sw.js` on navigation (and on its own about daily), so an installed app left open would never notice an update: the page calls `registration.update()` when it becomes visible again, at most hourly (`createUpdateCheck`, fix round 1).
- **Icons are placeholders** (a full-bleed dark square with three boxes and two connectors inside the maskable safe zone), 192 and 512 px, each listed as `any` and `maskable`. Generated by `apps/web/scripts/generate-icons.mjs` (Node's own zlib, no image library) and committed under `public/icons/`. A designed mark is still to come.
- **`launchQueue`** routes the first launched file into §7's Open path. Chromium only, and only for an installed app, so it has no automated test; the T5 manual gate ("a `.sgl` opened from the OS") covers it.
- **`_headers`** (DD-10 §5, with DD-09 §1.2's CSP) is emitted into `dist/` by the build, from one definition in `apps/web/build/headers.ts`, which also mirrors the CSP into the built `index.html` as a `<meta>` (minus `frame-ancestors`, which a `<meta>` policy cannot carry) and makes `vite preview` serve the build with those headers. Deploying it is a human step (decision J4).

---

## 13. Error handling (programming errors)

A thrown error anywhere in the pipeline (a violated invariant — not a document problem, which is a diagnostic) is caught at the effect boundary, logged, shown as a single "Something went wrong rendering — your text is safe" chip with a "Report" link that copies the error and the current source hash (never the source) to the clipboard. The editor keeps working; the last good render stays.

**Implemented (Stage I part 2, completed in fix round 1), `apps/web/src/state/pipeline-error.ts` +
`pipeline.ts`.** Every boundary logs the original error with `console.error` (stack intact) and
sets `pipelineError` (`makePipelineError`: `describeError`'s message plus the source hash) for the
chip. The boundaries:

- **Each synchronous stage** — `parse`/`buildAst`, `resolve`, `compile`, `resolveTheme`,
  `styleGraph` and `render()` — is its own guarded computed. On a throw it keeps its last good
  value, and any stage downstream of a frozen one does not run either, so the chain freezes at
  last-good from the throwing stage down. That second rule matters at the fan-in stages:
  `styleGraph` reads `compile`'s graph and `resolve`'s classes, and must never pair a fresh one with
  a frozen one. `parsed`/`model`/`graph`/`theme`/`styled` stay separate public signals, as above.
  A throw on the very first pass, before any good value exists, falls back to that stage's result
  for the empty document. The pipeline still constructs, the editor still mounts, and the next
  edit that stops throwing recovers.
- **The measure effect** — `measurer.ready()` or `premeasure()` throwing.
- **The layout effect** — building the `LayoutInput`, a synchronous throw from `host.run()`, and a
  rejection other than `AbortError`, which violates DD-06 §3's own contract.

`lastGood` is built from the render outcome's own `styled`/`layout`, not from whatever `styled`
holds when the effect runs, so a frozen render is never re-paired with a newer graph. A still-live
error is not logged again when an unrelated stage recomputes. `pipelineError` clears the next time
a render completes cleanly and becomes `lastGood`. That is a reasonable reading of "the editor
keeps working": once it demonstrably is working again, the crash chip should not linger. The
chip's "Report" button copies `reportText` (message and source hash, never the source).

---

## 14. Tests (Playwright, DD-09 §3)

1. Type a document; assert the canvas updates and the viewport does not reset.
2. Delete a closing brace; assert a squiggle at the right offset and the previous SVG still in the DOM.
3. Switch theme; assert *geometry* is untouched — the same node frames, the same edge route `d` attributes, the same `viewBox` — while paint changes. **Not** "the tree is untouched and only `<style>` text differs": F7 (execution plan §2.1) shows that does not hold — paint class names embed `paintHash` and a directed edge's marker id embeds its stroke colour, so a theme switch is a full re-render, not a `<style>`-only swap (§3, §11).
4. Switch engine; assert geometry differs, IDs identical.
5. Open `.sgl`, `.sgl.json`, `.txt` fixtures; save each; assert round-trip.
6. Share: encode in one context, open in a fresh one; assert identical source. Oversize and corrupt fragments produce the toast.
7. Reload with `page.context().setOffline(true)`; assert full function including engine switch.
8. Font gate: label widths on cold and warm loads are identical.

**Implemented (Stage I part 2), `apps/web/e2e/`, against a production build (`vite build` +
`vite preview`).** Tests 1–3, 4 (Stage K) and 8: `dd08-14.spec.ts`. Test 4 switches the example
elk → grid → elk: node, edge and label identity unchanged, geometry different, then exactly
elk's again.
**Stage J** added tests 5–7 and the rest of its gate: `files.spec.ts` (test 5 and MVP criterion 4,
for `.sgl`, `.sgl.json` and `.txt`), `share.spec.ts` (test 6 and criterion 6, with the link opened
in a fresh browser context; corrupt, not-deflate and oversize fragments), `offline.spec.ts` (test 7
and criterion 5 — Stage K added the engine switch: offline, render under elk, switch to grid,
back to elk, no failed request, and the lazy `elk` chunk must be among the responses served by
the service worker after the HTTP cache is emptied (K8); requests are read on the browser
context, since the worker fetches elk; since fix round 1 the
HTTP cache is emptied before going offline and, in Chromium, every response of the offline reload
must come from the service worker, so a precache missing `/assets/*` fails it — WebKit's own server
sends `no-store` instead, and Firefox has neither mechanism), `persistence.spec.ts`
(autosave across a reload; §5's boot paint), `pwa.spec.ts` (the precache and the manifest) and
`csp.spec.ts` (the build under its own `_headers`, with no CSP violation). The first-run document is
now the example (§9), so the older tests wait on its computed node count. Two more things worth
knowing: the suite **blocks service workers** (`playwright.config.ts`) except in the two specs about
them — every context otherwise installs one and fills a ~560 KB precache, and with ten parallel
Firefox workers that alone pushed unrelated tests past their timeouts (the Firefox project is also
capped at four workers, for the same kind of contention in context set-up and teardown); and in
**WebKit**, criterion
5 takes the network away by stopping a server of the test's own (`e2e/static-server.ts`), because
Playwright's WebKit fails an offline navigation (and blocks routed requests) before the service
worker can answer. `criteria.spec.ts` covers the MVP acceptance criteria
directly (2, 3, and — Stage K, K7 — 1 with both engines: `forty-three-level.sgl` under elk, then
grid; node ids, edge ids, label texts and the pipeline's paint hash (`data-paint-hash`) are
identical, and a layout geometry hash differs. The pipeline has no layout hash of its own —
`StyledGraph.geometryHash` is style geometry, the same under both engines — so
`e2e/helpers.ts`'s `layoutGeometryHash` hashes the rendered shapes, routes, label positions and
`viewBox`); `f8-style-decode.spec.ts` covers F8;
`canvas.spec.ts` (fix round 1) covers §6. **Decision: criterion 1's "40 nodes" counts containers**
(06 §3 does not say either way): `corpus/forty-three-level.sgl` has 2 top-level containers, 4
second-level containers and 34 leaves, and the test counts rendered `g.n` and `g.c` together.
"At the right span" (test 2, criterion 3) is checked as document offsets. The test reads back
where CodeMirror drew every error decoration and compares that with the parser's own spans for the
text read back from the editor. It also compares the panel's diagnostic codes exactly. Two things worth
knowing before extending this suite: `closeBrackets` (§4) auto-pairs a typed opening `"`/`{`, so
per-character `page.keyboard.type()` of anything containing one can pass through a momentarily
*valid* intermediate document a debounced layout may legitimately adopt as `lastGood` before the
rest of the keystrokes land — use `page.keyboard.insertText()` (one atomic input event) instead
whenever the test's point is the document's *final* state, not the act of typing it. And test 2's
"delete a closing brace" needs two `Backspace` presses after `Control+End`, not one — the example
document ends with a trailing newline, so the cursor lands on an empty final line first.

---

## 15. Imports (A9): the app side, design

**Status: implemented (A9 phase 2, branch `feat/imports`, 2026-09-26).** Deviations are listed in
§15.6. The language and core side, with decisions I1–I22 and I31–I32, is DD-02 §10. This section continues the numbering. **⚑**
marks a decision that changes a product promise, for the human.

### 15.1 Records

- **Two optional, additive fields on `DocumentRecord` (§9).**
  - `fileName`: the name Open read the file under, or the name a share bundle gave the document.
    DD-02 I3 uses it.
  - `group`: an id shared by the documents one share link created. DD-02 I4 uses it.

  `DocumentSession` carries both unchanged from the base record, as it does `fileExtension`, and
  `isDocumentRecord` accepts a record with or without them. *They are additive, like
  `fileExtension`. An older record simply has neither.*

### 15.2 The stored-document index and freshness

- **I23. The index is an in-memory snapshot of the stored documents.** For each document it
  holds `{ id, title, fileName?, group?, source, updatedAt }`. `lastGoodSvg` is left out, because
  it is large and imports do not need it.
  - **Loading.** It is loaded together with the lazy `imports` chunk, by one `listDocuments()`.
  - **Keeping it current.** The app's own writes keep it current: `DocumentStore.putDocument` is
    wrapped, so every write updates the document's entry synchronously **when the write is
    issued**. That covers autosave, its flush on a switch or on leaving the page, Open, New
    document and a share link. The wrapper is installed before the list is read, and an entry
    written after that wins over the listed one.
  - **Other tabs.** The index is read again when the tab becomes visible (`visibilitychange`).

  *The pipeline is synchronous and storage is not. A snapshot that the app's own writes keep
  current lets `lookup` answer synchronously, and it is never staler than the last write this tab
  issued.*
- **I24. Only a document you import can re-run your pipeline.** Each entry is its own signal,
  and a `names` signal maps normalised names to ids and changes only when a title, a `fileName`,
  a group or the set of documents changes. The host's `lookup` reads `names` and the signals of
  the entries it matched, so the `model` computed depends on exactly the documents it imports, at
  any depth, and on naming.
  - **When.** It re-resolves synchronously on the write: when the imported document's autosave
    is issued (500 ms after an edit), and at the latest in the flush a switch performs before the
    importer is loaded (§9). So switching to B, editing it and switching back to A shows B's edit.
  - **What does not trigger it.** The importer's own autosave. A title change anywhere does,
    which is rare.

  *@preact/signals tracks dependencies at this grain for free. One signal over the whole index
  would re-resolve on every autosave of the open document.*
- **I25. A document with `@imports` waits for its imports before its first resolve.** When
  core's `hasImports(ast)` is true and the chunk or index is not loaded yet, the pipeline starts
  loading them and the `model` stage holds. The canvas meanwhile shows the stored `lastGoodSvg`
  (§5, J6), and no diagnostic is shown. A document without `@imports` never loads the chunk.
  Offline, the chunk comes from the precache (§12), like `share`. The session still saves what is
  typed meanwhile, under the stored title (fix round 1). If the chunk or its index cannot load, see
  §15.6. *Without this, the first render
  would briefly show every import as unresolved, and a render missing the imported classes could
  become `lastGood`.*
- **The host** (DD-02 I1–I6) lives in that chunk. `lookup(path, fromId)` runs DD-02 I19's check,
  then I4a (an empty name finds nothing), then the tiers of I4 over the index (only the
  importer's own group, or only the ungrouped documents: H2), then I5. It returns `{ key: id, source, candidates }`, with
  the pick's name available for `SGL2018`. The pipeline creates one linker per open document,
  with `self` set to the open document's id and one `ImportCache` that lives as long as the
  pipeline. Switching documents is the ordinary `switchTo` (§7). The host also records which
  documents the last resolve used (the import closure), for Share.

### 15.3 Share bundling

- **I26. The format is backwards compatible in both directions.**
  `#s={…}&e={…}&t={…}&i={base64url(deflate-raw(utf8(JSON)))}`, where the JSON is
  `{"v":1,"d":[{"n":"classes","t":"Shared classes","s":"…"}, …]}`: `n` is the normalised name
  (DD-02 I2) the document was matched by, `t` its title, and `s` its source. `s=`, `e=` and `t=`
  are unchanged.
  - A link without `i=` opens exactly as today.
  - An older app ignores `i=` (it reads only `s`, `e` and `t`), opens the main document, and shows
    `SGL2017` warnings: a degraded result, not a broken one.
  - A `v` other than 1 is ignored with a toast.

  *A second stream loses a little compression compared with one shared stream, but it keeps every
  existing link and every older build working.*
- **I27. What goes in the bundle.** The import closure of the importer's last resolve, in the
  order a breadth-first walk first reached it, and only documents that actually resolved; a
  document reached under two names (its file name and its save name, say) is carried under each,
  so every import of it resolves for the recipient (fix round 1).
  - **The size guard.** The 8 000-character guard (§8) measures the **whole** link, `i=`
    included. When it warns, the dialog also says that "Save as a file instead" saves this
    document without its imports (bundling them is F5).
  - ~~**A name for two documents.**~~ Removed in fix round 1: since H2 every lookup in a closure
    stays inside one group, or among the ungrouped documents, so one name cannot lead to two
    documents; the dialog's paragraph and `ShareBundle.differ` were dead code.
- **I28. Caps on the receiving side.**
  - `i=` is inflated under its own 2 MB cap, with the same sliced reader as `s=`. The two caps
    together bound a link at 4 MB inflated.
  - At most 64 entries, matching DD-02 I21.
  - Every entry must have string `n`, `t` and `s`, and its `s` must be valid UTF-8.
  - **A bad bundle does not invalidate the link.** The main document still opens, and a toast
    says its imported documents could not be read.
- **I29. ⚑ The bundled documents are stored as new documents, in a new group with the main
  document.**
  - Each is a record with `fileName: n + '.sgl'` and `title: t`, created before the main
    document becomes `lastOpenDocId`.
  - The toast becomes "Opened the shared diagram and its N imported documents as new documents."
  - Opening the same link twice makes a second, separate group.
  - A link pasted into an open tab takes the same route through the reload (§8, F13).

  *Imports must keep resolving after a reload or a switch, and the recipient can open and edit
  what they received. A copy held only in memory would vanish, and a per-record copy of the
  imports would be F5's `.sglpack` inside the store.* This changes §8's promise that opening a
  share link creates *a* new local document: one link can now add several documents to Documents ▾.
- **I30. The recipient's own documents never collide with a bundle.** Each bundled document is
  found first through its group (DD-02 I4), and it is invisible to every other document. A
  recipient's own `classes` neither makes the bundle ambiguous nor changes; the recipient's other
  documents keep resolving to their own `classes`. **Imports the bundle does not satisfy are not
  found** (`SGL2017`): a received document never imports the recipient's own documents (human
  decision H2, 2026-09-26; the design first let them fall through).

### 15.4 Documents ▾

- **Documents ▾ is otherwise unchanged:** grouped documents are listed like any other. Its lazy
  loading is the prerequisite in DD-02 §10.9, and the only difference it makes is that the list
  loads a chunk the first time it is opened (precached, so offline too). Delete and rename stay
  E17. When they are built, renaming or deleting a document changes what its importers resolve
  to, through I24.

### 15.5 Test plan (app; the core's is DD-02 §10.8)

- **Unit tests (Node).**
  - `import-host.test.ts`: every rule of I1–I5 and I19, the tiers and the group isolation of
    I30, and the ambiguity pick.
  - `import-index.test.ts`, against the memory store: the put wrapper, the ordering between the
    list and the wrapper, and refresh on visibility.
  - `pipeline.test.ts`:
    - Editing an imported document re-resolves the importer.
    - The importer's own autosave does not (I24), counted by resolve calls.
    - The I25 gate holds the model and never adopts a render that lacks the imports.
  - `share.test.ts`: encoding and decoding `i=`, with and without `i=` and with an unknown `v`; an
    `i=` decompression bomb against its cap; malformed entries; the length guard counting `i=`.
  - `boot.test.ts`: the bundle is stored as a group; a bad bundle still opens the main document.
  - `documents.test.ts`: `fileName` and `group` round-trip through `DocumentSession`.
- **End to end (`e2e/imports.spec.ts`, Chromium).**
  - Open two files; A imports B; A renders B's classes.
  - Switch to B, edit a class, switch back: A shows the change.
  - An unresolved import is a warning and A still renders.
  - A cycle and an ambiguity each show their warning.
  - Share A, open the link in a fresh context: A and B are both in Documents ▾ and A renders the
    same.
  - The same link opened by a recipient who has their own `classes`: that recipient's other
    document does not change.
  - Offline: reload a document with imports and it renders from the precache (extending
    `offline.spec.ts`).
  - `csp.spec.ts` shows no violation.
- **Size.** `pnpm size` passes after the Documents ▾ prerequisite, with the `imports` chunk
  excluded by name; `check-core-chunks.mjs` fails if the chunk reaches the entry.

**As built**, each item above maps to:

| Item | Test |
|---|---|
| `import-host.test.ts`: I1–I5, I19, tiers, I30 groups, the ambiguity pick | `apps/web/test/import-host.test.ts`, with H2 (no fall-through), I4a (empty names) and the tier order inside a group |
| `import-index.test.ts`: the put wrapper, list/wrapper ordering, refresh | `apps/web/test/import-index.test.ts` (refresh drops a deleted document); the `visibilitychange` wiring itself in `imports-runtime.test.ts` |
| Share's closure (I27): breadth first, only resolved, every name a document was reached by; H2 | `apps/web/test/imports-runtime.test.ts` |
| `pipeline.test.ts`: I24 re-resolve on an imported write and not on the importer's own; I25 gate; the chunk failing to load | `apps/web/test/pipeline.test.ts`, "imports (A9, DD-08 §15: I24, I25)" |
| `share.test.ts`: `i=` codec, no `i=`, other `v`, bomb, malformed, 64 entries, length guard | `apps/web/test/share.test.ts` |
| `boot.test.ts`: group stored before `lastOpenDocId`, twice is two groups, bad bundle | `apps/web/test/boot.test.ts` |
| `documents.test.ts`: `fileName`/`group` through `DocumentSession` | `apps/web/test/document-session.test.ts` (where `DocumentSession`'s tests live), with "typing is still saved while the pipeline holds" |
| e2e: A imports B and renders its classes; B edited, A follows | `e2e/imports.spec.ts` (the first case, and `as: aws` with a grafted subtree) |
| e2e: unresolved is a warning, A still renders | `e2e/imports.spec.ts` |
| e2e: a cycle and an ambiguity each warn | `e2e/imports.spec.ts` (two cases) |
| e2e: Share to a fresh context, both in Documents ▾, same rendering; the recipient's own `classes` unchanged | `e2e/imports.spec.ts`, with H2 (a received document importing the recipient's `notes`: `SGL2017`), the dialog's note and a long link counting `i=` |
| e2e: offline reload of a document with imports | `e2e/offline.spec.ts`, "the lazy imports chunk comes from the precache" |
| e2e: `csp.spec.ts` shows no violation | `e2e/csp.spec.ts` loads the imports chunk and makes an `i=` link under the policy |
| Size | `pnpm size`; `check-core-chunks.mjs` (entry reachability, and no import catalogue row at boot) |

### 15.6 As built: deviations

- **The `filename` chunk.** `state/filename.ts` is shared by `file-actions` and `imports`, so the
  bundler gives it a chunk of its own; `size-limit` excludes it by name too, and the offline case
  checks it comes from the service worker.
- **If the chunk or its index cannot load** (not precached, say), the pipeline does not hold for
  ever: it resolves and compiles with core's `resolve()`/`compile()`, which keep `@imports` with
  no effect (DD-02 I9's step A), adds one `SGL2027` warning at `@imports` (a row in the **boot**
  catalogue, since `IMPORT_CATALOGUE` is in the chunk that failed), and drops `SGL2002`, `SGL2013`
  and `SGL2001`, so under I17 the picture is still adopted (fix round 1; they were errors). The
  load is tried again on the next change of the document, not in a loop. Offline the chunk is
  precached, so this is a broken install, not a normal path.
- **While the pipeline holds** (I25), the session saves what is typed, under the stored title:
  the model a title would come from is not this document's yet (fix round 1: it saved nothing, so a
  stalled load and a closed tab lost the typing).
- **The index's put wrapper** does not call `isDocumentRecord`, which reads `lastGoodSvg`, a getter
  that renders on read in autosave's records; it checks `id` and `source` only.
- **A link pasted into an open tab** (I29's last bullet) takes the same route as a link opened in a
  new tab, as designed: `watchShareLinks` flushes autosave and reloads, and boot stores the link's
  documents as a group (`openShared`, in the lazy `share` chunk since fix round 1). F13 is about
  that reload itself (undo history, the memory-store fallback), not about imports.
- **H2 (human decision 2026-09-26).** A document in a share group resolves only within its group
  (I30 above, DD-02 I4); the dialog's "a name for two documents" paragraph (I27) was removed as
  unreachable.
