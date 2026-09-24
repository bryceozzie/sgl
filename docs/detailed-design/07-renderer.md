# DD-07 — SVG Renderer

**Package:** `@sgl/render-svg` · **Inputs:** `StyledGraph` (DD-04), `LayoutResult` (DD-06), `ResolvedTheme` · **Output:** `RenderResult { svg: string; styleBlock: string; structureHash: string; bounds: Rect; diagnostics: readonly Diagnostic[] }`

A pure string renderer. No DOM, no virtual DOM. The same function serves the live view (DD-08 §6 sets `innerHTML`), export, the CLI and, later, the Worker.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Emit a self-contained, accessible SVG document from geometry + computed styles | Lay anything out |
| Generate shape paths and anchor functions for the built-in shapes | Rasterise (DD-08 §7 does PNG on the main thread) |
| Emit text as positioned `<tspan>`s from `TextLayout` — no `<foreignObject>` | Embed fonts (**⟶ C8**) |
| Assign stable, sanitised element IDs | Add interaction chrome (DD-08 §6 overlays it *outside* this tree) |
| Escape every string that reaches markup; allowlist link schemes | |
| Return `styleBlock` (the `<style>` element's text) and `structureHash` separately, so a paint-only change can be a `<style>`-text swap (§6, §11) | Perform that swap: the live view's canvas does (DD-08 §3, §6; execution plan §2.1 F9) |

---

## 2. Document structure

```svg
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     class="sgl" data-sgl="1.0"
     width="{bounds.w}" height="{bounds.h}" viewBox="0 0 {bounds.w} {bounds.h}"
     role="img" aria-labelledby="sgl-t sgl-d">
  <title id="sgl-t">{title or 'Diagram'}</title>
  <desc id="sgl-d">{n} nodes, {m} connections, {c} groups.</desc>
  <style>{styleBlock}</style>
  <defs>{markers}</defs>
  <rect class="canvas" width="100%" height="100%"/>
  <g class="L-containers">{containers in order}</g>
  <g class="L-edges">{edges}</g>
  <g class="L-nodes">{leaf nodes in order}</g>
  <g class="L-labels">{edge labels}</g>
</svg>
```

Layer order is fixed: containers, edges, nodes, edge labels. Node and container titles are emitted inside their own element's `<g>` so they move with it; edge labels are a separate top layer so plates never sit under a node.

The renderer returns the whole string **and** `styleBlock` (the `<style>` element's text, §6) separately, with `structureHash` (§6). Since Stage L's F7/F14 re-baseline the output has the **paint-only property**: two renders of the same layout whose `structureHash` is equal differ only in the text of `<style>` (and `<defs>`), so a live view can keep its tree and swap that text alone (§6 "Structure", §11). Whether the application does so is DD-08 §3's business (execution plan §2.1 F9).

---

## 3. Element templates

**Container**
```svg
<g id="{nid}" class="c {classes}" role="group" aria-label="{title}">
  <path class="c-shape [g-{geometry}] s-{signature token}" d="{shapePath}"/>
  <text class="c-title [g-{geometry}] t-{signature token}" ...>{tspans}</text>
</g>
```

**Leaf node**
```svg
<g id="{nid}" class="n sh-{shape} {classes}" role="group" aria-label="{title}">
  <path class="n-shape [g-{geometry}] s-{signature token}" d="{shapePath}"/>
  {ports: <circle class="n-port" cx cy r/>}
  <text class="n-title [g-{geometry}] t-{signature token}" ...>{tspans}</text>
</g>
```

**Edge**
```svg
<g id="{eid}" class="e {classes}" role="graphics-symbol" aria-label="{from} to {to}{: label}">
  <path class="e-path [g-{geometry}] s-{signature token}" d="{routePath}" marker-end="url(#m-{arrowhead}-{arrowSize}-{signature token})" [marker-start="url(#m-{arrowhead}-s-{arrowSize}-{signature token})"]/>
</g>
```
Edge label (in `L-labels`):
```svg
<g class="el" data-for="{eid}">
  <rect class="el-plate p-{edge signature token}" x y width height/>
  <text class="el-text [g-{geometry}] t-{signature token}" ...>{tspans}</text>
</g>
```

`{classes}` = `k-{name}` per document class, so a theme or a consumer stylesheet can target `.k-Critical`. Class names are sanitised (§6).

Links: a node or edge with a valid `@link` wraps its `<g>` in `<a href="{url}" target="_blank" rel="noopener">`. Tooltips become a nested `<title>` inside the `<g>` (native SVG tooltip; **⟶ D13** adds a styled tooltip in the live view).

---

## 4. Shapes

Each shape is a pure module exporting three functions over a frame `{x,y,w,h}` and `radius`:

```ts
interface Shape {
  path(f: Rect, r: number): string;                       // SVG path data, absolute coordinates
  contentInsets(labelW: number, labelH: number): Insets;  // extra space the shape needs beyond padding
  anchor(f: Rect, from: Point): Point;                    // boundary intersection of ray centre→from
}
```

| id | path | content insets (in terms of the shape's own `w`/`h`, per this column) | anchor |
|---|---|---|---|
| `rect` | `M x y h w v h h -w Z` | 0 | box |
| `round` | rect with `a r r 0 0 1` corners, `r = min(radius, w/2, h/2)` | 0 | box (corner error ≤ r(1−1/√2), accepted) |
| `ellipse` | two `a w/2 h/2` arcs | `w·(1−1/√2)/2` each side, same for h — so the label fits inside the inscribed rectangle | ellipse: parametric solve |
| `diamond` | `M cx y L x+w cy L cx y+h L x cy Z` | `w/4`, `h/4` each side | polygon |
| `hexagon` | inset `i = min(h/2, 0.25w)`; `M x+i y L x+w−i y L x+w cy L x+w−i y+h L x+i y+h L x cy Z` | `i` left/right | polygon |
| `cylinder` | body rect + top ellipse (`ry = min(8, h/6)`) + visible bottom arc | top `2·ry`, bottom `ry` | box |
| `package` | tab (`w·0.35 × 14`) over a rect | top 14 | box |

**The content-insets column above is written in terms of the shape's own `w`/`h`** — the same `w`/`h` its `path` column draws with, and the frame `Shape.path`/`Shape.anchor` receive. `Shape.contentInsets(labelW: number, labelH: number): Insets`, by contrast, is handed the *label's* width and height and must return the inset for a shape *sized to exactly hold that label* — i.e. the solution of the column's equation for the shape whose content box (frame minus insets) equals `labelW × labelH`. The two are equal only at that fixed point, and reading the column's `w`/`h` as the label's, uncorrected, gives the wrong inset for every non-box shape (ellipse, diamond, hexagon, cylinder): a diamond sized by `w/4` in *label* terms comes out roughly half the size it needs to be. `packages/render-svg/src/shapes.ts` documents each shape's solved form inline; `@sgl/layout-api`'s duplicate (`content-insets.ts`, DD-06 §2) must match it, and both are tested against the underlying containment property, not just against each other, so a future change to one has somewhere to be checked against.

**Anchor functions.** `box`: clip the ray to the rectangle (Liang–Barsky, 4 comparisons). `ellipse`: `t = 1/√((dx/a)² + (dy/b)²)`. `polygon`: test the ray against each edge segment, take the nearest hit. All three return the centre if `from` equals the centre (degenerate self-loop — DD-06 §4.5 handles routing before this is reached). Unlike `contentInsets`, the anchor functions take the frame directly — no label-vs-shape distinction applies to them.

**⟶ C7:** user shapes are parameterised path templates; `contentInsets` and `anchor` come from the template's declared `anchor: box|ellipse|polygon`. The `Shape` interface does not change.

---

## 5. Text

For a `LabelPlacement` and its `TextLayout`:

```svg
<text x="{x0}" y="{frame.y + layout.ascent}" text-anchor="{start|middle|end}">
  <tspan x="{x0}" dy="0">{line 0}</tspan>
  <tspan x="{x0}" dy="{lineHeightPx}">{line 1}</tspan>
</text>
```

- `x0` = frame left / centre / right by `align`. `y` is computed from `ascent` explicitly; **`dominant-baseline` is never used** — it is inconsistent across Inkscape, Safari and resvg, and it is the usual reason exported labels sit 2 px off.
- `y` also honours `placement.baseline`: `top` → `frame.y + ascent` (the formula above); `middle` → `frame.y + (frame.h − block.height) / 2 + ascent`; `bottom` → `frame.y + frame.h − block.height + ascent`. Found missing during Stage F's review round — the renderer always computed `top` regardless of `baseline`, latent only because the host fallbacks (DD-06 §4.1) always emit a frame sized exactly to the label, where `top` and `middle` coincide.
- `align` and `baseline` are enumerated fields (DD-06 §0's `contract.ts`), but that is a compile-time guarantee only: an engine's output is untrusted at runtime (worker-boundary JSON from Stage H erases the union). `align` is mapped to one of `start|middle|end` before it reaches `text-anchor`, falling back to `middle` for anything else — the one attribute in this package that took a raw union member straight from `LayoutView` without going through `escapeXml` or an allowlist, and the one place `corpus/injection/*.sgl` could not catch the gap, since every producer in the real pipeline already emits a literal union member. `validateResult` (DD-06 §5) rejects an out-of-range value before it reaches here at all; the renderer's own guard is defence in depth for a caller that skips validation.
- `rotation` → `transform="rotate(deg cx cy)"` on the `<text>`.
- Font properties come from the generated classes, never inline: the family, size, weight and spacing (geometry) from `g-{hash}`, the colour and opacity (paint) from `t-{token}`, whose name is the label's cascade signature (§6), so a font-*colour* change is a new declaration inside the same class, never a new class name (F7).
- `xml:space="preserve"` on `<text>` so leading spaces in a line survive.

**⟶ A18:** runs with `style: code|strong|em` become nested `<tspan class="r-code">` etc. inside the line `tspan`. Same emitter.

---

## 6. IDs, classes, markers and the `<style>` element

**IDs.** `n-` + sanitised `NodeId`; `e-` + the hash part of `EdgeId`. Sanitise = replace any character outside `[A-Za-z0-9_.-]` with `_`, then if the result differs from the original append `-` + 6 chars of `fnv1a64(original)` to prevent collisions (`a b` and `a_b` must not both become `n-a_b`). IDs are unique per document by construction because paths are unique.

**Generated style classes.** Two families, each element carrying at most one of each, geometry first:

- **Geometry**, `g-{shortHash(declarations)}`: the visual properties DD-04 §2 classifies as geometry (`stroke-width`, the font family, size, style, weight and letter spacing), named after the declaration text itself.
- **Paint**, `s-{token}` (shape fill, stroke, opacity, dash), `t-{token}` (text fill and opacity), `p-{token}` (label plate fill). **The name never derives from a resolved value** (F7, Stage L re-baseline): `token` is `fnv1a64` of the element's **cascade signature** (`cascadeSignature`, `style.ts`) — the inputs DD-04 §4's cascade reads from the element itself before any theme value applies:

  ```
  signature = role | shape | classes | inline
    role    = node | container | edge                    (step 1: rules.<role>)
            | node.title | container.title | edge.label  (a label: rules.<role>.title / rules.edge.label)
    shape   = the node's shape, '' for an edge or a label (step 2: byShape; nodes and containers only)
    classes = the element's classes, in linearised order  (steps 3 and 4: theme byClass[c] and the
                                                            document's @classes[c].style, both keyed by name)
    inline  = canonicalise(@style), or ''                 (step 5; keys sorted at every depth,
                                                            values JSON, so 1 and "1" differ)
  ```

  Step 6 (`@size`) is geometry and not part of it. Within one render (one document, one theme) equal signatures resolve to equal paint, so the signature is a sound de-duplication key — a 500-node diagram with three visual variants still emits three rules, not 500 attributes — and nothing in it comes from a theme, so **the same element has the same class name under every theme** and a theme switch changes only rule bodies. A plate takes its edge's signature (`labelPlate` is an edge property). The theme's resolved values appear only inside the `<style>` rules. DD-04 §4 pins the cascade steps this list mirrors; a new cascade input added there must be added here.

**One `<style>` element.** `styleBlock` holds every rule that paints the diagram, markers included, with literal resolved values:
```css
/* <style> — styleBlock: literal values only, no custom property declared or read */
.canvas { fill:#F7F8FA }                                  /* the resolved canvas colour, never var() */
.c-shape, .n-shape { stroke-linejoin: round }
.e-path   { fill:none; stroke-linecap:round }
.g-8ab4…  { stroke-width:1.5px }
.mf-6176… { fill:#8A96A8 }                                /* a marker's own paint (below) */
.p-6176…  { fill:#F7F8FA }
.s-6176…  { stroke:#8A96A8 }
.s-f87f…  { fill:#FFFFFF; stroke:#8A96A8 }
.t-5e01…  { fill:#1B2330 }
…
```

**No token element, and no custom property anywhere** (F17, F18). Re-theming an exported SVG by overriding its tokens is not supported (human decision, 2026-09-24; §2.1 F18 of the execution plan, closed): to change an exported diagram's colours, re-export it under another theme. Until Stage L's F7/F14 re-baseline the file carried a second, vestigial `<style>` element (`tokenBlock`, one `svg.sgl{--…}` rule of theme tokens that nothing read); the re-baseline removed it and `RenderResult.tokenBlock` with it.

`styleBlock` must never contain a custom property, declared or read. Some tools do **not** merely ignore a rule they cannot parse: they discard the **whole** `<style>` element that holds it. Inkscape 1.2.2 does exactly that with a rule of custom properties, and when the tokens were the first rule of the single block, every shape in an exported file fell back to the default black fill (**F17**, found at T5 on 2026-09-23 and bisected with Inkscape 1.2.2; `var()` use was not the cause). `packages/render-svg/test/style-elements.test.ts` holds this over the whole corpus: exactly one `<style>` element, no custom property or `var()` in it or anywhere else in the file.

**Markers.** One `<marker id="m-{arrowhead}[-s]-{arrowSize}-{token}">` per distinct (arrowhead kind, start/end, `arrowSize`, edge signature token) actually used — `token` is the edge's own `s-` token, so the id names no colour (F7). The colour is the marker's **own paint**, a class rule in `<style>`: the marker's shape carries `class="mf-{token}"` (triangle, diamond, circle: `.mf-{token}{fill:<the edge's stroke>}`) or `class="ms-{token}"` (`open`, which is stroked: `.ms-{token}{stroke:…}`, with `fill="none"` on the element), and no colour attribute. So a theme switch changes a rule body and leaves every marker id, every `marker-end`/`marker-start` reference and the `<defs>` text as they were. Two edges with different stroke colours still get different markers — they have different signatures, hence different tokens — while the colour itself never reaches the id. `context-stroke` is deliberately not relied on (Safari support arrived late; resvg lacks it). A class rule on an element inside `<marker>` was checked at the re-baseline in **Chromium**, **Inkscape 1.2.2** and **resvg** (resvg-js 2.6.2), both themes, every arrowhead drawn its edge's colour (and, as a control, black once the rule is deleted); `test/browser/markers.browser.test.ts` holds Chromium to it for every kind. Marker geometry is in user units with `markerUnits="userSpaceOnUse"` sized by `arrowSize`. A start marker (`both`) is drawn flipped 180° about its own centre and given its own `refX`, rather than relying on `orient="auto-start-reverse"` alone — a reversed marker still needs its `refX` on the other side — so every marker uses plain `orient="auto"`.

`refX`/`refY` anchor the marker's own **base**, not its tip, to the same path vertex that `orient="auto"` orients the marker's local +x axis along (the direction of travel there): the host's arrow reserve (DD-06 §4.4) already shortens the path's head — and, for `both`, tail — end by `arrowSize` along that same direction, so the tip must sit `arrowSize` beyond the anchored point for it to land back on the node boundary the reserve pulled away from. Anchoring the tip itself instead (`markers.ts`'s bug, fixed by `fix/arrowhead-gap`) put the tip at the already-shortened path end — still `arrowSize` short of the boundary on every directed edge. `triangle`/`open`/`diamond` reach their own point at the marker box's far edge, so their base is the near edge (`refX = start ? w : 0`); `circle` is capped to fit inside `markerHeight` and so falls short of the far edge by `(w - h) / 2`, which `refX` folds in the same way (`packages/render-svg/src/markers.ts`).

**Structure is independent of paint** (F7). Outside the text of `<style>` and `<defs>`, the output is a function of the graph, the layout and the **geometry** of the styles, plus one paint property by design. Three places where a resolved paint value could otherwise decide what is emitted each have a fixed rule:

| Where | Rule |
|---|---|
| A paint class whose declarations are empty under a theme (a text style with no colour, say) | The class stays on the element; only its rule is omitted. |
| `labelPlate: none` (or no plate colour at all) | The plate `<rect>` is still emitted whenever the placement asks for a plate (`occlusion: 'plate'`); its rule is `fill:none`. |
| `arrowhead: none` | The arrowhead kind is part of the marker id (above), so the kind is the one paint property the structure follows: `none` draws no marker and the `marker-end`/`marker-start` attribute is omitted. `structureHash` includes it. |

**`structureHash`** (`RenderResult.structureHash`; also exported as `structureHash(styled)`, which needs no render) hashes everything that decides the output outside the `<style>` and `<defs>` text **except the layout**: `styled.geometryHash` (the `g-` classes, text metrics, radii, arrow sizes), the title, and per element in document order its id, its cascade signature (which names its paint classes and markers, and carries its shape and classes — so an inline `@style` edit changes it), its hidden flag, its label text and the config the output shows (`@link`, `@a11y`); per edge also its endpoints, direction and arrowhead kind. The guarantee is one-way and conservative: **for the same `LayoutResult`, equal `structureHash` ⇒ the SVG outside the `<style>` and `<defs>` text is byte-identical**, so replacing those texts turns one render into the other. Unequal hashes may still render the same bytes (a geometry change the renderer does not emit, such as `padding`, changes the hash). It does not rely on the caller knowing the graph is unchanged — the application's layout skip compares only `geometryHash`, engine and options (DD-08 §3), which an inline `@style.fill` edit passes — but the layout must be the same one (the application reuses it on a paint-only change). Its hash is two 32-bit multiplicative hashes over UTF-16 code units, not `fnv1a64` (which is part of the output's compatibility surface and ~6× slower here); it never leaves the process. Cost, Node, n2000: ~2.2 ms (n500 ~0.45 ms), against ~15 ms for hashing the structural bytes themselves and ~62 ms for `render()`; `test/paint-only.test.ts` holds that an inline `@style` edit, a class, a label, a link and a direction change it and a theme switch does not. The two built-in themes share geometry and arrowheads, so switching between them is always paint-only (`test/paint-only.test.ts`, over the whole corpus).

---

## 7. Accessibility

- Root: `role="img"`, `<title>`, `<desc>` with counts, `aria-labelledby`.
- Nodes/containers: `role="group"` + `aria-label` = title text (or key). Edges: `role="graphics-symbol"` + `aria-label` = "A to B" (+ ": label"). Undirected: "A and B".
- Document order = `graph.order` for nodes, edge order for edges — so a screen reader walks the diagram in declaration order, which is the author's intended reading order.
- `@a11y.label` / `@a11y.description` override `aria-label` / add `aria-description`.
- Decorative elements (`canvas` rect, plates, ports) carry `aria-hidden="true"`.

---

## 8. Escaping and safety

Every string from the document passes through exactly one of:

| Context | Function | Rule |
|---|---|---|
| Text content and attribute value | `escapeXml` | `& < > " '` → entities. One function covering both contexts, not the `escText`/`escAttr` split an earlier draft of this section assumed: the attribute set (`& < > " '`) is a strict superset of the text set (`& < >`), the extra `&quot;`/`&apos;` in text content is legal XML and renders identically, and one function is one thing to audit. |
| ID / class | `sanitizeId` | §6 |
| `href` | `safeUrl` | allow `https:`, `mailto:` only; anything else (including `http:`, `javascript:`, `data:`, protocol-relative, and in-document `#…`) → link omitted, `SGL6001` warning. Narrower than an earlier draft of this row, which also listed `http:` and in-document fragments — neither is implemented, and the language spec's own `@link` row (§4) already agrees with the two-scheme allowlist. In-document fragment links remain a documented gap, not a supported feature; the language spec's `#path` mention there needs the same correction. |
| CSS values | `cssColor` / `cssFontFamily` / `cssKeyword` / `cssCustomProperty` | colours must match `#hex`, an `rgb()/hsla()` grammar, or a keyword (`none`, `transparent`, `currentColor`); font families quoted; anything else rejected → the registry's loud fallback (`#FF00FF`, `sans-serif`), not a diagnostic, because `SGL5004` upstream (the theme resolver) already rejects a bad value before it reaches here |

There is no path by which document text becomes markup. The injection corpus in DD-09 asserts this against every context.

---

## 9. Export serialisation

`render()` output *is* the export. Export-time options are applied by the caller (DD-08 §7):

- `background: 'theme' | 'transparent'` → `.canvas` rect present or omitted.
- `scale` → `width`/`height` attributes multiplied; `viewBox` unchanged.
- Fonts: by reference in MVP — the `font-family` stack includes system fallbacks, so the file is legible everywhere and pixel-faithful where Inter is installed. **⟶ C8** embeds a subsetted `@font-face` into the `<style>` element (`styleBlock`, §6); nothing else changes.

The live view's pan/zoom `<g transform>` and selection overlay live in a *host* `<svg>` around this one and are never part of the exported string.

---

## 10. Diagnostics

| Code | Severity | Message template |
|---|---|---|
| `SGL6001` | warning | Link on `{element}` uses `{scheme}:`, which is not allowed; the link was removed. |

---

## 11. Tests

- Byte-exact SVG goldens for the corpus × both themes × both engines.
- Shape unit tests: path strings, content insets, anchor hits for rays at 0°, 45°, 90° and edge cases.
- Text: `y` from ascent, multi-line `dy`, rotation transform.
- ID sanitisation: collision pair, unicode key, dotted quoted key.
- Injection corpus: labels, keys, links, tooltips, class names containing `<script>`, `"`, `javascript:`, `&#x` — assert no element or attribute other than the intended text is produced, via an XML parser over the output.
- **Paint-only swap** (holds since Stage L's F7/F14 re-baseline): render A, render B differing only in paint → the SVGs are identical once the `<style>` and `<defs>` texts are removed, and replacing A's `<style>` text with B's gives B. `test/paint-only.test.ts` asserts it for every corpus document, `neutral-light` against `neutral-dark`, with equal `structureHash`; that a document differing only in its `@theme` gets the same class names and marker ids; that stripping every paint declaration and turning plates off leaves the structure alone; and that changing the arrowhead kind changes both the structure and `structureHash`. The class and marker naming is pinned by `test/naming-memo.test.ts` (the whole corpus, plus the marker key's cross product) and the marker colour in Chromium by `test/browser/markers.browser.test.ts`. Until the re-baseline this did not hold, for two reasons: paint classes were named after `paintHash`, and a marker baked its stroke colour into its `fill` and its id (F7); both are gone.
- Manual gate (release checklist): open a golden in Inkscape, Figma and Safari; labels within 1 px.
