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

Split is draggable; layout stacks vertically under 900 px. The diagnostics panel is collapsed when empty.

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
lastGood = signal<{ styled, layout, svg, styleBlock } | null>
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
if styled.geometryHash === lastGood?.styled.geometryHash && engine/options unchanged:
    skip — a paint-only change; fall through to render
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
- **The paint-only skip condition's "engine/options unchanged" half.** `lastGood`'s
  shape (`{ styled, layout, svg, styleBlock }`, above) has no field to compare
  `engineId`/`engineOptions` against, so the app tracks the engine id and a
  stable-stringified options key of the *last issued* layout request separately,
  alongside the `styled.geometryHash === lastGood?.styled.geometryHash` check
  this section names.

### Render (computed)

```
svg = computed(() => layout.value && render(styled.value, layout.value, theme.value))
```

When `svg` produces a result **and** `diags` contains no `error`, it becomes `lastGood`. The canvas always displays `lastGood`; this is FR-E4 in one line.

A paint-only change (`geometryHash` equal, `paintHash` different) skips *layout* — the layout effect's skip condition above — but it cannot skip the *render*, and the canvas cannot swap `lastGood.styleBlock` in place against the retained tree. Two independent properties of `@sgl/render-svg`'s output break that: (1) generated paint classes are named `s-{paintHash}` / `t-{paintHash}` / `p-{paintHash}` (DD-07 §6), so every element's `class` attribute changes along with the `<style>` block, not just the block; and (2) a directed edge's arrowhead marker bakes its stroke colour into a `<defs>` element's `fill` and into the marker's own `id` (`markers.ts`, `context-stroke` deliberately unused — resvg lacks it, Safari support arrived late), so `marker-end`/`marker-start` references change too, for any document containing a directed edge. Reason (1) has a lever — the class name only needs to be a stable key, so keying it on something theme-invariant instead of the paint hash would let the block swap alone repaint the tree — but pulling it is a DD-07 §6 design change deferred to whoever picks this up, not assumed here. Reason (2) needs a different marker strategy or a `context-stroke`-based rewrite; neither is scoped yet.

So a theme toggle is a full re-render (`render()` regenerates the whole string; the canvas replaces the `innerHTML` wrapper as usual, §6), not a `<style>`-text swap. What DD-09 §2's "Paint-only theme switch" budget must actually be met by, and whatever headroom that leaves, is for whoever implements this to establish — not assumed here. See DD-07 §11 and execution plan §2.1 (F7) for the full finding.

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
- **Source of truth is the editor state.** `source` is updated from `EditorView.updateListener`; programmatic changes (open file, load share) dispatch a transaction replacing the document, so undo history survives.
- **Tree reuse**: `syntaxTree(view.state)` is read inside `parsed`; the app never calls `parser.parse` on its own.
- Autocomplete **⟶ E6**; source mapping **⟶ E7** — both hook here with no other changes.

---

## 5. Fonts

Inter (Regular 400, Medium 500, SemiBold 600) is bundled as WOFF2 and declared via `@font-face` in the app CSS with `font-display: block` — block, not swap, so the first measurement is never against a fallback. `measurer.ready()` (DD-05 §4) is awaited before the first pre-measure; the boot sequence shows the last-good SVG from storage (if any) while fonts load, so there is no blank canvas.

**Implemented (Stage I part 2), `apps/web/src/fonts.css`.** Hand-written `@font-face` rules — Latin subset only, `font-display: block` — pointing at `@fontsource/inter`'s own WOFF2 files, rather than importing that package's `400.css`/`500.css`/`600.css` directly: those ship every Unicode subset (cyrillic, greek, vietnamese, …) at `font-display: swap`, which is the one thing this section specifically rules out. The font's SIL Open Font License ships with the build: `apps/web/public/fonts/OFL.txt` (the `@fontsource/inter` package's own `LICENSE`, verbatim) lands at `dist/fonts/OFL.txt`, with a one-line attribution in the root `README.md` (fix round 1). "The boot sequence shows the last-good SVG from storage while fonts load" needs persistence (Stage J) and is not built yet; today's boot sequence shows nothing until the first render completes, which given `font-display: block` and the awaited `ready()` is at worst a brief blank canvas, never a wrongly-sized one.

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
- `innerHTML` replacement: the wrapper `<g>` is replaced wholesale. For a 2 000-node diagram this is ~20 ms in Chromium; if measured above budget, swap in `morphdom` on the wrapper. Not pre-emptively.

---

## 7. Files

**Open** — toolbar, `Ctrl/⌘+O`, or drag-drop (**⟶ F2**; the handler is the same function). `<input type="file" accept=".sgl,.sgl.json,.json,.txt">` → `file.text()` → dispatch a replace-document transaction. Every extension goes through the same Lezer parser (JSON is SGL); the extension is remembered on the document for the default save name. Files over 2 MB are refused with a toast.

**Save ▾** — Blob download via a transient `<a download>`:

| Item | Name | Content |
|---|---|---|
| SGL | `{title}.sgl` | `source` verbatim |
| Canonical JSON | `{title}.sgl.json` | `toJson(model)` |
| SVG | `{title}.svg` | `lastGood.svg` with export options (background, scale) |
| PNG **⟶ D6** | `{title}.png` | rasterise `lastGood.svg` via `<img>` → canvas → `toBlob` |

`title` = `@title` or the first node key or "diagram", sanitised for filenames. **⟶ F3** File System Access `showSaveFilePicker` replaces the download when available, same call site.

---

## 8. Share by URL

```
https://…/#s={base64url(deflate-raw(utf8(source)))}&e={engineId}&t={themeId}
```

- Encode: `new CompressionStream('deflate-raw')` → `Uint8Array` → base64url (no padding).
- Decode on load: if `location.hash` has `s=`, inflate with a **hard cap of 2 MB inflated** (decompression bomb guard); on failure toast "This share link is not valid" and open the last document instead.
- Size guard: if the encoded fragment exceeds 8 000 characters, the Share dialog warns that some chats and browsers truncate long URLs and offers the file save instead.
- Opening a share link creates a **new local document** (never overwrites the current one) and clears the hash so a reload does not re-import.
- The fragment never reaches a server. **⟶ F6** short links are a separate button that *does* upload; that distinction is shown in the dialog.

---

## 9. Persistence

IndexedDB `sgl`, version 1, via `idb`:

| Store | Key | Value |
|---|---|---|
| `documents` | `id` (nanoid) | `{ id, title, source, engineId, engineOptions, themeId, createdAt, updatedAt, lastGoodSvg? }` |
| `settings` | `key` | `{ key, value }` — `lastOpenDocId`, `splitRatio`, `themePreference` |

- Autosave 500 ms after the last change (source or settings) — `put`, whole record. `lastGoodSvg` is stored so the next open paints instantly before fonts and the worker are ready.
- Boot: read `lastOpenDocId` → open it; else create a document from `examples/checkout.sgl`. A crash mid-edit loses at most 500 ms of typing.
- Multiple documents **⟶ E17**: the store is already a list; the deferred part is only the "≡ docs" drawer UI.
- Quota/`QuotaExceededError` → toast, editing continues in memory.

---

## 10. Engine and theme pickers

- **Engine ▾** lists registered engines with name and `determinism` badge (ADR-0004). Selecting sets `engineId`, resets `engineOptions` to the engine's defaults.
- **Engine options** panel: MVP is a hand-built form per engine — `elk`: direction, node spacing, rank spacing, edge routing, node placement; `grid`: columns, gap, align. **⟶ B7** generates this from `optionsSchema`; the form values already round-trip through `engineOptions` so nothing else changes.
- **Theme ▾** lists built-in themes with a 24 px swatch of `bg/surface/ink/accent`. Switching sets `themeId`; because the two built-ins share geometry, layout is skipped (§3's layout-effect skip), but the render itself is not a `<style>`-only swap — see §3.
- `@layout.engine` / `@theme` in the document **override** the pickers; the picker shows "(set by document)" and editing it writes into the document's root config via a transaction — the document stays the source of truth.

**Implemented (Stage I part 2).** `apps/web/src/toolbar/{ThemePicker,EnginePicker}.tsx`, over pure
option-list builders in `apps/web/src/state/pickers.ts` (Node-tested). "Registered engines" is
`apps/web/src/App.tsx`'s own `REGISTERED_ENGINES` constant, read from `gridEngine` directly (the
same object `layout.worker.ts` registers) rather than from a shared registry object — the worker's
own `EngineRegistry` lives inside the worker, with no synchronous view from the main thread. The
engine options panel (this section's second bullet) is **not** built — F11 (execution plan §2.1),
owned by Stage K, which is when a second engine exists to prove the form's generality against.
Overriding writes through `apps/web/src/state/root-config-edit.ts`'s `setRootConfigString`
(fix round 1). The picker's own write must never make the document emit a diagnostic or grow a
second entry for the key, so it edits whatever already sets the key, in place: an exact
`@theme`/`@layout.engine` entry, or the `engine` property of an `@layout: { … }` object, whatever
the old value's kind; the last such entry, since later wins. An `@layout` object without `engine`
gets the property added inside it. A new `@key.path: "…"` line is inserted at the document's start
only when nothing sets the key and no parent object exists. The edit is built from the pipeline's
own `parsed` AST (§4: the app never calls `parse` itself — `apps/web/src/state/picker-actions.ts`,
enforced by a lint rule on `apps/web/src`). Selecting an engine resets `engineOptions` to `{}`:
"the engine's defaults" until the options form (F11, Stage K) gives an engine real ones.

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
Toasts are not built (file/share outcomes are Stage J).

**Decision (fix round 1): chip priority.** When several states hold at once, the chip shows the
highest of **crashed > timeout > errors > laying out > idle** (`deriveChipState`). A crash (§13)
wins because nothing else is safe to claim once the pipeline itself has thrown. `SGL4001` is more
specific than the generic error count. The error count beats "laying out…" because a retry in
flight after an error is still showing last-good-with-errors until it lands. The "Fit" offer is
independent of all five.

---

## 12. PWA

`vite-plugin-pwa`, `generateSW`:

- Precache: app shell, both engine chunks (the `elk` chunk is large and is precached deliberately so offline first-render works), Inter WOFF2, both themes, the example document.
- `navigateFallback: 'index.html'`; `skipWaiting` gated behind an "Update available — reload" chip so an in-progress edit is never lost.
- `manifest.webmanifest`: name, icons (192/512, maskable), `display: standalone`, `file_handlers: [{ action: '/', accept: { 'text/plain': ['.sgl'], 'application/json': ['.sgl.json'] } }]` — with `launchQueue` consumer in the app that routes to §7 Open.
- Offline is the full experience: nothing in MVP fetches after the shell loads.

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
`vite preview`).** Tests 1–3 and 8: `dd08-14.spec.ts`. Tests 4–7 wait for Stage K (engine switch)
and Stage J (files, share, offline). `criteria.spec.ts` covers the MVP acceptance criteria
directly (2, 3, and 1's single-engine half); `f8-style-decode.spec.ts` covers F8;
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
