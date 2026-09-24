# DD-04 — Theme

**Package:** `@sgl/theme` · **Inputs:** `ThemeDoc`, `SemanticGraph` · **Outputs:** `ResolvedTheme`, `StyledGraph`

Supersedes the `metrics` / `paint` document sections sketched in [Architecture §5.1](../03-architecture.md). The split is now carried by the **style-property registry**, not by the theme document's shape — a theme is a flat set of tokens and rules, and the registry decides which resolved properties invalidate layout.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Define every style property once, with its type and whether it affects geometry | Measure text (DD-05) |
| Validate and resolve a theme document (inheritance, token references) | Emit SVG (DD-07 consumes `ComputedStyle`) |
| Apply the cascade per element: role → shape → theme class → document class → inline | Know layout coordinates |
| Compute a **geometry hash** and a **paint hash** per element | **⟶ v1.x:** modes map (C4 light/dark inside one theme), custom shapes (C7), font embedding (C8) |
| Ship the two built-in themes | |

---

## 2. Style-property registry

`packages/theme/src/registry.ts`. The single source of truth for what a style property is.

```ts
interface StyleProperty {
  readonly name: string;                // 'fill', 'fontSize', 'padding'
  readonly affects: 'geometry' | 'paint';
  readonly type: 'color' | 'length' | 'number' | 'insets' | 'enum' | 'string' | 'dash';
  readonly enum?: readonly string[];
  readonly appliesTo: readonly ('node' | 'container' | 'edge' | 'text')[];
  readonly inherits: boolean;           // text properties inherit from the owning element's rule
}
```

| name | affects | type | applies to | notes |
|---|---|---|---|---|
| `fontFamily` | geometry | string | text | |
| `fontSize` | geometry | length | text | px |
| `fontWeight` | geometry | number | text | 100–900 |
| `fontStyle` | geometry | enum `normal italic` | text | italic changes advances; geometry to be safe |
| `lineHeight` | geometry | number | text | multiplier |
| `letterSpacing` | geometry | length | text | |
| `padding` | geometry | insets | node, container | `[t r b l]`, or one/two values |
| `titleGap` | geometry | length | container | space between title band and content |
| `strokeWidth` | geometry | length | node, container, edge | changes outer bounds and clip points |
| `radius` | geometry | length | node, container | moves edge attachment on rounded corners |
| `minWidth`, `minHeight` | geometry | length | node | |
| `width`, `height` | geometry | length | node | fixed size, from `@size` |
| `aspectRatio` | geometry | number | node | |
| `arrowSize` | geometry | length | edge | route is shortened by it at the head |
| `portSize` | geometry | length | node | port marker radius; affects clip |
| `labelGap` | geometry | length | edge | offset of label from route |
| `fill` | paint | color | node, container | |
| `stroke` | paint | color | node, container, edge | |
| `strokeDash` | paint | dash | node, container, edge | `'4 2'`, `'dashed'`, `'dotted'`, `'solid'` |
| `opacity` | paint | number | any | |
| `color` | paint | color | text | text fill |
| `arrowhead` | paint | enum `triangle open diamond circle none` | edge | shape only; size is `arrowSize` |
| `labelPlate` | paint | color | edge | background plate behind edge labels; `none` |
| `shadow` | paint | enum `none soft` | node, container | |

Rule of thumb applied when classifying: **if changing it could move any pixel other than its own, it is geometry.** The registry test in DD-09 asserts every property has an `affects`, and the renderer's geometry-hash test asserts no geometry property can change without the layout stage re-running.

Adding a property means adding a row here first. **⟶ v1.x** rows: `gradient`, `glow` (C13), `sketch` (C9), `icon*` (C10).

---

## 3. Theme document

```jsonc
{
  "id": "neutral-light",
  "name": "Neutral Light",
  "schemaVersion": 1,
  "extends": null,                          // theme id or null

  "tokens": {                               // flat, dotted names, any value type
    "bg": "#F7F8FA",
    "surface": "#FFFFFF",
    "surface.sunken": "#EEF1F5",
    "ink": "#1B2330",
    "ink.muted": "#5B6675",
    "line": "#8A96A8",
    "accent": "#1F5F80",
    "danger": "#A8323F",
    "font.sans": "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  },

  "rules": {                                // each value is a StyleSet
    "node":            { "fill": "@surface", "stroke": "@line", "strokeWidth": 1.5, "radius": 6,
                         "padding": [8, 12], "minWidth": 72, "minHeight": 36 },
    "node.title":      { "fontFamily": "@font.sans", "fontSize": 13, "fontWeight": 500,
                         "lineHeight": 1.3, "color": "@ink" },
    "container":       { "fill": "@surface.sunken", "stroke": "@line", "strokeWidth": 1,
                         "radius": 10, "padding": [16, 16, 16, 16], "titleGap": 6 },
    "container.title": { "fontFamily": "@font.sans", "fontSize": 12, "fontWeight": 600,
                         "lineHeight": 1.3, "color": "@ink.muted" },
    "edge":            { "stroke": "@line", "strokeWidth": 1.5, "arrowhead": "triangle",
                         "arrowSize": 8, "labelGap": 4, "labelPlate": "@bg" },
    "edge.label":      { "fontFamily": "@font.sans", "fontSize": 11, "fontWeight": 400,
                         "lineHeight": 1.3, "color": "@ink.muted" }
  },

  "byShape": { "cylinder": { "fill": "@surface.sunken" } },
  "byClass": {},                            // theme-level class styling, e.g. "Critical": { "stroke": "@danger" }
  "canvas":  { "background": "@bg" }
}
```

`StyleSet` is `Partial<Record<propertyName, value | '@token'>>`. Keys not in the registry → `SGL5003` warning, dropped. Values are validated against the property `type` → `SGL5004`.

### Resolution

`resolveTheme(doc, registry, lookup)`:

1. **Inheritance.** Follow `extends` (max depth 8 → `SGL5001`; cycle → `SGL5002`). Child `tokens`, `rules`, `byShape`, `byClass` deep-merge over parent, later wins.
2. **Token references.** Any string value beginning with `@` is a token name. Resolve transitively; unknown → `SGL5005` and the value becomes the type's fallback (`#FF00FF` for colours — loud on purpose); cycle → `SGL5006`.
3. **Normalise** insets to `[t,r,b,l]`, dash keywords to dash arrays, lengths to numbers.
4. Output `ResolvedTheme { id, rules, byShape, byClass, canvas, tokens }` with no `@` references left.

---

## 4. Cascade

Per element, lowest to highest precedence. Each step is a `StyleSet`; later keys overwrite earlier.

| # | Source | Node | Container | Edge |
|---|---|---|---|---|
| 1 | `rules.node` / `rules.container` / `rules.edge` | ✔ | ✔ | ✔ |
| 2 | `byShape[shape]` | ✔ | ✔ | — |
| 3 | `byClass[c]` for `c` in `classes` (linearised order) | ✔ | ✔ | ✔ |
| 4 | Document `@classes[c].style` for `c` in `classes` | ✔ | ✔ | ✔ |
| 5 | Inline `config.style` | ✔ | ✔ | ✔ |
| 6 | Inline `config.size`, **only** the size keys (`SIZE_KEYS`: `width height minWidth minHeight maxWidth aspectRatio`) | ✔ | ✔ | — |

Step 6 is geometry only. Any other key under `@size` — `@size.fill`, say — is kept by the resolver with `SGL2010` (language spec §4: an unknown key in a known namespace) and never reaches the bag. Until fix round 1 of the Stage L re-baseline, step 6 applied any key, so `@size.fill` painted; and because the renderer names paint classes after the cascade signature, which leaves `@size` out (below; DD-07 §6), such an element shared its paint class with an unstyled sibling and repainted it.

Text properties for the element's label resolve the same way but starting from `rules.<role>.title` / `rules.edge.label` at step 1, then the *same* steps 3–5 filtered to `appliesTo: text`. So `@style.fontSize: 16` on a node applies to its title; `@style.fill` does not.

A container is a node with children; it takes `rules.container` instead of `rules.node`. Everything else is identical.

**Cascade inputs (pinned by Stage L's F7 re-baseline).** Everything steps 1–5 read from the element itself, rather than from the theme, is its *cascade signature*: its role (`node`, `container`, `edge`, or the label role `node.title` / `container.title` / `edge.label`), its shape (step 2; nodes and containers), its classes in linearised order (steps 3 and 4 look both the theme's `byClass` and the document's `@classes` up by name), and its inline `@style` bag (step 5). Under one theme and one document, two elements with the same signature get the same paint. DD-07 §6 names the renderer's paint classes after this signature so that they are the same under every theme; a new input to steps 1–5 must therefore be added to `cascadeSignature` (`@sgl/render-svg`'s `style.ts`) as well. Step 6 (`@size`) is geometry only and is not an input to paint.

Document-class and inline values may also be `@token` references, resolved against the active theme. This is what lets `@style.stroke: "@danger"` in a document work under every theme.

---

## 5. Output

```ts
interface ComputedStyle {
  readonly geometry: Readonly<Record<string, number | string | readonly number[]>>;
  readonly paint:    Readonly<Record<string, number | string | readonly number[]>>;
  readonly geometryHash: string;      // fnv1a64 over sorted 'k=v' of geometry
  readonly paintHash: string;         // likewise over paint
}

interface StyledGraph {
  readonly graph: SemanticGraph;
  readonly styles: Readonly<Record<NodeId | EdgeId, ComputedStyle>>;
  readonly labelStyles: Readonly<Record<LabelId, ComputedStyle>>;   // text properties only
  readonly canvas: { readonly background: string };
  readonly themeId: string;
  readonly geometryHash: string;      // hash of all element geometry hashes in `order` — one number for "does layout need to re-run"
  readonly paintHash: string;         // likewise over paint, PLUS `canvas.background` (Stage G fix: the canvas has no ComputedStyle of its own to fold it in otherwise, so a theme that changed only the background left this hash — and so "did paint change?" — wrongly unchanged)
}
```

`styleGraph(graph, theme)` is pure and synchronous. Two `StyledGraph`s with equal `geometryHash` produce identical layout inputs; the application uses this to skip re-layout on a paint-only change (DD-08 §3). Two with equal `paintHash` and equal layout produce identical SVG.

**Node sizing inputs** (consumed by DD-05/DD-06) are derived from `geometry`:

```
contentInsets = padding + shape.contentInsets(w, h)     // DD-07 §4 per shape
intrinsic     = labelSize + contentInsets               // measured in DD-05
size          = fixed ?? clamp(intrinsic, min, max)      // width/height/aspectRatio applied
container: contentFrame top inset += titleHeight + titleGap
```

---

## 6. Diagnostics

| Code | Severity | Message template |
|---|---|---|
| `SGL5001` | error | Theme inheritance deeper than 8 (`{chain}`); stopping at `{id}`. |
| `SGL5002` | error | Theme `{id}` extends itself via `{cycle}`. |
| `SGL5003` | warning | Unknown style property `{name}` in {where}; ignored. |
| `SGL5004` | warning | `{name}` expects {type}, got `{value}`; ignored. |
| `SGL5005` | warning | Unknown token `@{name}`; using a fallback value. |
| `SGL5006` | error | Token `@{name}` refers to itself via `{cycle}`. |

`SGL5003`/`5004` from a *document's* `@style` carry the document span; from a theme they carry no span and are shown in the theme picker instead.

---

## 7. Built-in themes (MVP)

Two, sharing everything except tokens:

| | `neutral-light` | `neutral-dark` (`extends: neutral-light`) |
|---|---|---|
| `bg` | `#F7F8FA` | `#0E131C` |
| `surface` | `#FFFFFF` | `#171E2B` |
| `surface.sunken` | `#EEF1F5` | `#10161F` |
| `ink` | `#1B2330` | `#E4E9F1` |
| `ink.muted` | `#5B6675` | `#A6B1C2` |
| `line` | `#8A96A8` | `#4A5768` |
| `accent` | `#1F5F80` | `#62A8CA` |
| `danger` | `#A8323F` | `#E4737E` |

Because `neutral-dark` overrides tokens only, its `geometryHash` for any document equals `neutral-light`'s — which is the property MVP acceptance criterion 2 tests. Both themes must pass WCAG AA contrast for `ink`/`surface`, `ink.muted`/`surface`, and `edge.label`/`bg` (test in DD-09; **C15** later generalises this to user themes).

**⟶ v1.0 (C5):** `high-contrast`, `print` — print sets every `fill` to white and every `stroke` to black and disables `shadow`; still tokens only.

---

## 8. Tests

- Registry completeness: every property has `affects`, `type`, `appliesTo`.
- Cascade goldens: a fixture graph × both themes → `styles` JSON.
- Hash properties: change one paint property → `paintHash` differs, `geometryHash` identical; change one geometry property → both differ; the geometry-hash of `neutral-dark` equals `neutral-light` for the whole corpus.
- Token resolution: transitive, unknown, cycle.
- Contrast assertions on both themes.
