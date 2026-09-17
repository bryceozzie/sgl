# DD-07 — SVG Renderer

**Package:** `@sgl/render-svg` · **Inputs:** `StyledGraph` (DD-04), `LayoutResult` (DD-06), `ResolvedTheme` · **Output:** `RenderResult { svg: string; styleBlock: string; bounds: Rect }`

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
| Split output so a paint-only change can swap the `<style>` block without re-emitting the tree | |

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

The renderer returns the whole string **and** `styleBlock` separately. The live view keeps the tree and replaces only the `<style>` text on a paint-only change (`geometryHash` equal, `paintHash` different) — DD-08 §3.

---

## 3. Element templates

**Container**
```svg
<g id="{nid}" class="c {classes}" role="group" aria-label="{title}">
  <path class="c-shape s-{paintHash}" d="{shapePath}"/>
  <text class="c-title t-{labelPaintHash}" ...>{tspans}</text>
</g>
```

**Leaf node**
```svg
<g id="{nid}" class="n sh-{shape} {classes}" role="group" aria-label="{title}">
  <path class="n-shape s-{paintHash}" d="{shapePath}"/>
  {ports: <circle class="n-port" cx cy r/>}
  <text class="n-title t-{labelPaintHash}" ...>{tspans}</text>
</g>
```

**Edge**
```svg
<g id="{eid}" class="e {classes}" role="graphics-symbol" aria-label="{from} to {to}{: label}">
  <path class="e-path s-{paintHash}" d="{routePath}" marker-end="url(#m-{arrowhead}-{colorHash})" [marker-start=…]/>
</g>
```
Edge label (in `L-labels`):
```svg
<g class="el" data-for="{eid}">
  <rect class="el-plate p-{plateHash}" x y width height rx="2"/>
  <text class="el-text t-{labelPaintHash}" ...>{tspans}</text>
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
- `rotation` → `transform="rotate(deg cx cy)"` on the `<text>`.
- Font properties come from the `t-{hash}` class, never inline, so a paint-only font-colour change needs no tree rewrite. (Font *size* is geometry and does re-render.)
- `xml:space="preserve"` on `<text>` so leading spaces in a line survive.

**⟶ A18:** runs with `style: code|strong|em` become nested `<tspan class="r-code">` etc. inside the line `tspan`. Same emitter.

---

## 6. IDs, classes and the `<style>` block

**IDs.** `n-` + sanitised `NodeId`; `e-` + the hash part of `EdgeId`. Sanitise = replace any character outside `[A-Za-z0-9_.-]` with `_`, then if the result differs from the original append `-` + 6 chars of `fnv1a64(original)` to prevent collisions (`a b` and `a_b` must not both become `n-a_b`). IDs are unique per document by construction because paths are unique.

**Generated style classes.** `s-{paintHash}` for shape fill/stroke, `t-{hash}` for text, `p-{hash}` for plates. Identical styles across elements share one class — a 500-node diagram with three visual variants emits three rules, not 500 attributes.

**`styleBlock`**:
```css
svg.sgl { --bg:#F7F8FA; --ink:#1B2330; … }              /* every theme token, scoped to the root svg — never :root */
.canvas { fill: var(--bg) }
.n-shape, .c-shape { stroke-linejoin: round }
.s-8f2a…  { fill:#FFFFFF; stroke:#8A96A8; stroke-width:1.5 }
.t-0c41…  { font-family:Inter,system-ui,sans-serif; font-size:13px; font-weight:500; fill:#1B2330 }
.e-path   { fill:none; stroke-linecap:round }
…
```

Tokens are emitted as custom properties so a consumer can re-theme an *exported* SVG by overriding them, but generated rules use literal resolved values (not `var()`) so the file renders identically in tools that ignore custom properties (older Inkscape).

**Markers.** One `<marker id="m-{arrowhead}-{colorHash}">` per distinct (arrowhead, stroke colour) actually used. `context-stroke` is deliberately not relied on (Safari support arrived late; resvg lacks it). Marker geometry is in user units with `markerUnits="userSpaceOnUse"` sized by `arrowSize`, `orient="auto-start-reverse"` for `both`.

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
| Text content | `escText` | `& < >` → entities |
| Attribute value | `escAttr` | `& < > " '` → entities |
| ID / class | `sanitizeId` | §6 |
| `href` | `safeUrl` | allow `https:`, `http:`, `mailto:`, and in-document `#n-…`; anything else (including `javascript:`, `data:`, protocol-relative) → link omitted, `SGL6001` warning |
| CSS values | `escCss` | colours must match `#hex` or a `rgb()/hsl()` grammar; font families quoted; anything else rejected → `SGL5004` upstream |

There is no path by which document text becomes markup. The injection corpus in DD-09 asserts this against every context.

---

## 9. Export serialisation

`render()` output *is* the export. Export-time options are applied by the caller (DD-08 §7):

- `background: 'theme' | 'transparent'` → `.canvas` rect present or omitted.
- `scale` → `width`/`height` attributes multiplied; `viewBox` unchanged.
- Fonts: by reference in MVP — the `font-family` stack includes system fallbacks, so the file is legible everywhere and pixel-faithful where Inter is installed. **⟶ C8** embeds a subsetted `@font-face` into the `<style>` block; nothing else changes.

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
- Paint-only swap: render A, render B differing only in paint → trees identical when `<style>` is stripped.
- Manual gate (release checklist): open a golden in Inkscape, Figma and Safari; labels within 1 px.
