# DD-05 — Measurement

**Package:** `@sgl/measure` · **Inputs:** `StyledGraph` (DD-04) · **Outputs:** `MeasureTable`, `TextLayout`

The only place in the pipeline that touches a rendering surface. The MVP implementation is canvas-based (ADR-0003 amendment); the interface is run-based from day one so rich labels (**⟶ v1.0 A18**) and precomputed metrics (**⟶ phase 3**) slot in without touching callers.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Measure styled text runs and lay them into lines within a width constraint | Decide *where* a label goes (DD-06) |
| Pre-measure every label in a graph into a serialisable table before layout | Emit `<text>` (DD-07 consumes `TextLayout`) |
| Serve measurements synchronously inside the worker from that table | Break lines inside a run (**⟶ v1.0** — MVP runs are whole lines) |
| Fall back to an async RPC for a miss | Load fonts (DD-08 §5 does, and awaits readiness before measuring) |

---

## 2. Interface

```ts
interface TextStyle {
  readonly fontFamily: string; readonly fontSize: number; readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic'; readonly lineHeight: number; readonly letterSpacing: number;
}

interface StyledRun { readonly text: string; readonly style: TextStyle }

interface BoxConstraints { readonly maxWidth?: number }    // undefined = unconstrained (MVP always)

interface TextLayout {
  readonly width: number; readonly height: number;
  readonly lines: readonly {
    readonly y: number;                    // baseline offset from the top of the block
    readonly width: number;
    readonly runs: readonly { readonly x: number; readonly text: string; readonly style: TextStyle }[];
  }[];
  readonly ascent: number;                 // of the first line, for aligning the block
}

interface Measurer {
  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout;          // sync; throws MeasureMiss if unknown
  layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout>;
  has(runs: readonly StyledRun[], box: BoxConstraints): boolean;
}
```

The key for caching and for the table is `hashRuns(runs, box)` = `fnv1a64` over `text\x1f family\x1f size\x1f weight\x1f style\x1f lh\x1f ls` per run joined by `\x1e`, plus `maxWidth`.

---

## 3. Line model (MVP)

A `LabelSpec.runs` array from DD-03 is one run per line (split on `\n`). `layoutRuns` therefore treats **each run as one line**: no wrapping, no mixed styles on a line.

```
for each run i:
  w_i = advance(run.text, style) + letterSpacing * max(0, len - 1)
  lineHeightPx = style.fontSize * style.lineHeight
  y_i = ascent_i + i * lineHeightPx        // baseline
width  = max(w_i)
height = n * lineHeightPx
ascent = ascent_0
```

`ascent` comes from `TextMetrics.fontBoundingBoxAscent` when the browser provides it, else `0.8 × fontSize`. Both are recorded in the table so the worker never needs the canvas.

**⟶ v1.0 (A18):** runs gain inline styles and `maxWidth` becomes honoured; the line model becomes a greedy breaker over words with run boundaries preserved. `TextLayout` does not change.

---

## 4. Implementations

### `CanvasMeasurer` — main thread, MVP default

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

Walks `graph.labels`, builds `StyledRun[]` for each from `labelStyles[labelId].geometry`, calls `layoutRuns`, and collects into a plain object. It is what crosses to the worker by `structuredClone`. For a 2 000-label document the table is ~200 kB — acceptable; keyed so that an unchanged label's entry is reused across edits (the application keeps the previous table and only measures new keys).

Coverage target (DD-00 §6): **100 % of labels pre-measured on the corpus**, so the worker RPC path is exercised only by tests and by engines that synthesise labels at layout time (none in MVP).

---

## 6. Where sizes are computed

Measurement produces label boxes only. Node **intrinsic size** is computed in `layout-api`'s pre-pass (DD-06 §2) from `TextLayout` + `ComputedStyle.geometry` + shape content insets, so that engines receive a finished `sizing` and never touch text.

---

## 7. Determinism note

Canvas measurement is platform-dependent by design (ADR-0003 amendment). Within one browser session it is stable, which is all the MVP needs. The quantization in DD-06 §5 applies to layout output, not to measurement.

---

## 8. Tests

- `layoutRuns` arithmetic with a stub measurer returning fixed advances: multi-line height, ascent, letter-spacing.
- `TableMeasurer`: hit, miss → async round trip through a fake host.
- `premeasure` coverage assertion over the corpus.
- Font-readiness: a Playwright test asserting label widths are identical on first render and after a reload with a warm font cache (guards the fallback-font bug).
