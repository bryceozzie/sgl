# DD-05 — Measurement

**Package:** `@sgl/measure`, over `@sgl/text` (A18) · **Inputs:** `StyledGraph` (DD-04) · **Outputs:** `MeasureTable`, `TextLayout`

The only place in the pipeline that touches a rendering surface. The MVP implementation is canvas-based (ADR-0003 amendment); the interface is run-based from day one so rich labels (**⟶ v1.0 A18**) and precomputed metrics (**⟶ phase 3**) slot in without touching callers.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Measure styled text runs and lay them into lines within a width constraint | Decide *where* a label goes (DD-06) |
| Pre-measure every label in a graph into a serialisable table before layout | Emit `<text>` (DD-07 consumes `TextLayout`) |
| Serve measurements synchronously inside the worker from that table | Hyphenate, shape or apply kinsoku (DD-11 T37, T38) |
| Fall back to an async RPC for a miss | Load fonts (DD-08 §5 does, and awaits readiness before measuring) |

---

## 2. Interface

**A18 (DD-11 T2, T23):** the run and layout types below, the key (`hashRuns`), the run faces
(`runStyle`), the label helpers (`labelRuns`, `labelBox`, `labelRunKey`, `plainText`) and the line
models live in **`@sgl/text`**, which `@sgl/measure` and `@sgl/render-svg` both import, so the key
is computed by one function wherever the table is read. `@sgl/measure` re-exports every one of
them; `Measurer`, `MeasureMiss` and `MeasureTable` stay here.

```ts
interface TextStyle {
  readonly fontFamily: string; readonly fontSize: number; readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic'; readonly lineHeight: number; readonly letterSpacing: number;
}

interface RunMarks { readonly strong?: true; readonly em?: true; readonly code?: true }   // A18

interface StyledRun {
  readonly text: string;                   // may contain '\n', a hard break (A18)
  readonly style: TextStyle;               // already the run's own face (runStyle, DD-11 T25)
  readonly marks?: RunMarks;               // A18: absent on a plain run
}

interface BoxConstraints { readonly maxWidth?: number }    // the *label's* wrap width; undefined = no wrapping

interface TextLayout {
  readonly width: number; readonly height: number;
  readonly lines: readonly {
    readonly y: number;                    // baseline offset from the top of the block
    readonly width: number;
    readonly runs: readonly { readonly x: number; readonly text: string; readonly style: TextStyle; readonly marks?: RunMarks }[];
  }[];
  readonly ascent: number;                 // the label's largest measured ascent (DD-11 T31)
}

type LineModel = (measureRun: MeasureRun, runs: readonly StyledRun[], box: BoxConstraints) => TextLayout;

interface Measurer {
  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout;          // sync; throws MeasureMiss if unknown
  layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout>;
  has(runs: readonly StyledRun[], box: BoxConstraints): boolean;
}
```

The key for caching and for the table is `hashRuns(runs, box)` = `fnv1a64` over `text\x1f family\x1f size\x1f weight\x1f style\x1f lh\x1f ls` per run, then — **only for a run with marks** (A18, DD-11 T29) — `\x1f` and the letters `s`, `e`, `c` it carries, in that order; runs joined by `\x1e`, then `\x1d` and `maxWidth` as a numeral, or `*`, then `\x1fk` for a box that keeps words whole (`keepWords`, H1) and `\x1fh` for a hexagon's (whose breaker keeps `L + min(L, H)` within `maxWidth`). A plain run's key is exactly the MVP's.

A label's key is **`labelRunKey(styled, labelId)` = `hashRuns(labelRuns(…), labelBox(…))`**: its runs in their faces, and its box. `labelBox` is `{ maxWidth: labelMaxWidth(shape, w, padding) }` for a node title whose node has a finite positive `@size.maxWidth` or `@size.width` (the smaller), plus `keepWords: true` when there is no `maxWidth` (a fixed width breaks only at spaces, H1), and `{}` otherwise (DD-11 T35, T36). `premeasure`, the app's label-size join, the worker's lookup and the test pipelines all use it; `render-svg/test/wrap-pipeline.test.ts` and `apps/web/test/rich-text.test.ts` check, end to end, that the measured box is the size the layout gives the node.

---

## 3. Line models (A18, DD-11 §7)

Until A18 a `LabelSpec` was one run per line and `layoutRuns` laid each run on its own line. From
A18 a label is canonical runs (DD-03 §2) that may hold `\n` and share a line, and there are two
line models, both `LineModel`s with the same output:

- **`layoutLines`** (`@sgl/text`, on the boot path, every measurer's default): hard breaks only.
  It splits the runs at `\n` into lines of fragments, one per piece of a run on that line. It
  **throws** when handed a defined `maxWidth`: a caller that keys a wrapped label must have loaded
  the wrap model (DD-11 T53).
- **`layoutWrapped`** (`@sgl/text/wrap`, lazy): the same, plus a greedy breaker when `maxWidth` is
  defined. Break opportunities are runs of U+0020/U+0009 and U+200B (not U+00A0); a word may span
  runs and keeps their boundaries; whitespace at a soft break is dropped, at the start or end of a
  hard line kept and measured; a word too wide for a line is split at code-point boundaries that
  never enter a surrogate pair, a combining mark, a variation selector, an emoji modifier, a ZWJ
  join or a regional-indicator pair, so CJK breaks between any two characters. No hyphenation, no
  UAX #14, no `Intl.Segmenter` (its rules follow each engine's ICU). With `maxWidth` undefined it
  returns exactly `layoutLines`'s result, and a label that fits is laid out exactly as unwrapped.

```
for each line:                                      // DD-11 T32
  fragments measured whole, each in its own face
  x_j   = Σ_{k<j} (w_k + letterSpacing · glyphs_k)
  width = Σ w_k + letterSpacing · max(0, glyphs − 1)
A = max ascent over every fragment                  // DD-11 T31
lineHeightPx = fontSize · lineHeight                // one per label: runStyle never changes them
y_i = i · lineHeightPx + A   (accumulated line by line, as the MVP did)
height = lines · lineHeightPx
```

For a plain one-face label this is the MVP formula to the bit (`text/test/line-model.test.ts`
checks every corpus label against the MVP model). An empty line is measured as an empty fragment
in the style of the run whose `\n` made it, as the MVP measured an empty line.

`ascent` comes from `TextMetrics.fontBoundingBoxAscent` when the browser provides it, else `0.8 × fontSize`. Both are recorded in the table so the worker never needs the canvas.

## 4. Implementations

### `CanvasMeasurer` — main thread, MVP default

- `new CanvasMeasurer({ lineModel? })` (A18): `lineModel` defaults to `layoutLines` and is writable; the app sets it to `layoutWrapped` once the lazy `rich-text` chunk has loaded (DD-11 T53), keeping the measurer the worker host holds and its per-run cache, which caches runs, not lines. `StaticMetricsMeasurer` takes the same option.
- Lazily creates one `OffscreenCanvas` (fallback `<canvas>`) 2D context.
- `ctx.font = \`${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}\``; `ctx.letterSpacing` is *not* used (patchy support) — letter spacing is added arithmetically as above.
- Per-run cache `Map<runKey, { width, ascent }>` bounded at 20 000 entries (LRU by insertion; cleared when full).
- **Font readiness is a precondition.** `CanvasMeasurer.ready(styles: TextStyle[])` calls `document.fonts.load()` for each distinct `family/weight/style` and awaits `document.fonts.ready`. DD-08 awaits this before the first pre-measure and again whenever the set of text styles changes (theme switch). Measuring before fonts load silently measures the fallback — the classic "labels are the wrong size on first paint" bug.

### `TableMeasurer` — inside the worker

Wraps a `MeasureTable`. `layoutRuns` is a lookup; a miss throws `MeasureMiss`. `layoutRunsAsync` on a miss posts a `measure` request to the host (DD-06 §3 protocol) and resolves with the reply, which it also inserts into its table.

### `FontMetricsMeasurer` — **⟶ phase 3**

Same interface over precomputed advance/kerning tables. Introduced alongside the Worker render API; becomes the default then, `CanvasMeasurer` becomes opt-in. No caller changes.

---

## 5. Pre-measure table

```ts
type MeasureTable = Readonly<Record<string, TextLayout>>;   // runKey → layout

premeasure(styled: StyledGraph, measurer: Measurer): MeasureTable
```

Walks `graph.labels`, builds each label's `StyledRun[]` (`labelRuns`: its runs, each in its face from `labelStyles[labelId].geometry` and `runStyle`) and its box (`labelBox`), calls `layoutRuns(runs, box)`, and collects into a plain object keyed by `hashRuns(runs, box)`. It is what crosses to the worker by `structuredClone`. For a 2 000-label document the table is ~200 kB — acceptable; keyed so that an unchanged label's entry is reused across edits (the application keeps the previous table and only measures new keys).

Coverage target (DD-00 §6): **100 % of labels pre-measured on the corpus**, so the worker RPC path is exercised only by tests and by engines that synthesise labels at layout time (none in MVP).

---

## 6. Where sizes are computed

Measurement produces label boxes only. Node **intrinsic size** is computed in `layout-api`'s pre-pass (DD-06 §2) from `TextLayout` + `ComputedStyle.geometry` + shape content insets, so that engines receive a finished `sizing` and never touch text.

---

## 7. Determinism note

Canvas measurement is platform-dependent by design (ADR-0003 amendment). Within one browser session it is stable, which is all the MVP needs. The quantization in DD-06 §5 applies to layout output, not to measurement.

Line breaks (A18, DD-11 T30) are a function of those measurements and nothing else, so they are deterministic within a browser session and, with `StaticMetricsMeasurer`, byte-stable in Node (it classifies `IBM Plex Mono` as `mono` and applies its bold scalar at 700; italic costs nothing). Across browsers a label within a sub-pixel of its wrap width can break differently, exactly as label sizes differ today; `FontMetricsMeasurer` (phase 3) makes them identical, and its tables must then include DD-11 T26's faces.

---

## 8. Tests

- `layoutRuns` arithmetic with a stub measurer returning fixed advances: multi-line height, ascent, letter-spacing.
- A18: `layoutLines` against the MVP model over every corpus label; fragments, marks and `x`s; the breaker's cases and properties (every line fits unless it is one unit; the lines plus the dropped whitespace rebuild the text; determinism) in `packages/text/test/`.
- `TableMeasurer`: hit, miss → async round trip through a fake host.
- `premeasure` coverage assertion over the corpus.
- Font-readiness: a Playwright test asserting label widths are identical on first render and after a reload with a warm font cache (guards the fallback-font bug).
