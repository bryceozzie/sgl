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
theme    = computed(() => resolveTheme(builtin[themeId.value]))        // DD-04
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

Runs when `styled.value.geometryHash` or `themeId` changes:

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

### Layout effect

Runs when `styled.geometryHash`, `table`, `engineId` or `engineOptions` changes. Debounced 120 ms after the last change; aborts any in-flight request first.

```
if styled.geometryHash === lastGood?.styled.geometryHash && engine/options unchanged:
    skip — a paint-only change; fall through to render
else:
    inFlight = true
    try
        // LayoutHost.run() resolves a StageResult, never throws except for
        // AbortError (DD-06 §3) — errors are values here, not exceptions.
        result = await host.run(engineId, input, options, metrics, table, signal)
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

---

## 6. Canvas

```svg
<svg class="host" width="100%" height="100%">
  <g class="viewport" transform="translate(tx ty) scale(k)">
    <!-- lastGood.svg, inserted via innerHTML of a wrapper <g> -->
  </g>
  <g class="overlay"> <!-- selection outline, hover highlight; never exported --> </g>
</svg>
```

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

---

## 11. Diagnostics panel and status chip

- Panel rows: severity icon, code, message; click scrolls the editor to `span.from` and selects the span. Sorted by offset.
- Chip states: `idle` (hidden) · `laying out…` (after 300 ms in flight) · `Showing last good render · {n} errors` (any error diagnostic) · `Layout timed out — showing previous` (`SGL4001`).
- Toasts for file and share outcomes only; never for diagnostics.

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
