# DD-02 — Resolver and Document Model

**Package:** `@sgl/core` · **Input:** `Document` AST (DD-01) · **Output:** `ResolveResult { model: DocumentModel; diagnostics }`

The resolver turns syntax into a **canonical document model**: shorthands expanded, dotted keys merged, redeclarations merged, edge chains split, classes collected and validated. The model is exactly what `.sgl.json` serialises, plus a side table of spans.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Build the container tree with ordered children | Resolve edge endpoints to nodes (DD-03 — it needs the whole tree first) |
| Merge dotted config keys and redeclarations | Apply themes or compute styles (DD-04) |
| Expand `a: "Label"` and `a: Class` shorthands | Validate ports against endpoints (DD-03) |
| Split edge chains into edge records, normalise `<-` | Interpret `@layout.*` hint semantics (engines do) |
| Collect `@classes`, validate `@type` references | **⟶ v1.0:** `@vars` substitution (A8), `@imports` (A9) |
| Validate config keys against the key registry | |
| Serialise to and parse from `.sgl.json` | |

---

## 2. Data model

```ts
interface DocumentModel {
  readonly sgl: '1.0';
  readonly root: ContainerModel;               // key '' — the document itself
  readonly classes: Readonly<Record<string, ClassModel>>;
  readonly spans: SpanTable;                   // side table; never serialised
}

interface ContainerModel {
  readonly key: string;                        // '' for root
  readonly path: readonly string[];            // ['payments', 'api']
  readonly config: ConfigBag;                  // resolved @-keys, dotted keys merged
  readonly children: readonly ContainerModel[];// declaration order, redeclarations merged
  readonly edges: readonly EdgeModel[];        // edges DECLARED here (endpoints unresolved)
}

interface EdgeModel {
  readonly from: PathExpr;                     // relative to this container
  readonly to: PathExpr;
  readonly fromPort?: string;
  readonly toPort?: string;
  readonly directed: 'forward' | 'both' | 'none';   // '<-' already swapped into 'forward'
  readonly config: ConfigBag;
  readonly ordinal: number;                    // index within the declaring chain, for stable IDs
}

interface ClassModel {
  readonly name: string;
  readonly extends: readonly string[];
  readonly config: ConfigBag;                  // only @-keys are meaningful in a class body
}

type ConfigBag = Readonly<Record<string, ConfigValue>>;
type ConfigValue = string | number | boolean | null | readonly ConfigValue[] | ConfigBag;

type SpanTable = ReadonlyMap<string, SourceSpan>;   // key: 'n:payments.api' | 'e:payments.api#3' | 'c:Service'
```

`ConfigBag` is plain JSON. Nested objects come from either dotted keys (`@style.stroke`) or literal objects (`@style: { stroke }`); after merging they are indistinguishable, which is the point.

---

## 3. Algorithm: building the tree

`resolve(ast)` performs one recursive pass over `Document.entries`.

**3.1 Node keys and paths.** A child's path is the parent path plus its key. Keys containing `.` are legal (they were quoted) and are kept verbatim as a single segment; path *strings* used for IDs escape them as `\.` (DD-03 §2). Comparison and lookup always use the segment array, never the joined string.

**3.2 Redeclaration merges.** A second `NodeDecl` with the same key in the same container does not create a second node — it merges:

- `config`: deep-merged, **later wins** for scalars and arrays, recursive for objects.
- `children`: appended if new, merged recursively if already present.
- `edges`: appended.

This is deliberate and load-bearing: it lets a document declare structure first and style later (`api: {}` … `api: { @style.fill: red }`), and it is what makes `@rules`-style bulk styling (**⟶ v1.x, A13**) expressible as a rewrite rather than a new mechanism. Emits `SGL2005` at **info** level so an accidental duplicate is visible without being noisy.

**3.3 Shorthand expansion.**

| Written | Model |
|---|---|
| `a` | `{ key: 'a', config: {} }` |
| `a: "Text"` | `config.label = 'Text'` |
| `a: Word` | `config.type = ['Word']` |
| `a: { … }` | entries processed recursively |

**3.4 Dotted keys.** `ConfigEntry.key = ['style','stroke']` is inserted at `config.style.stroke`. If an intermediate is a non-object scalar, `SGL2006` and the scalar is replaced.

**3.5 Config value coercion.** Values arrive as AST literals; `Word` becomes its string; `ObjectLit` becomes a `ConfigBag` (its `@`-prefixed property keys drop the `@`; unprefixed keys are kept — both appear inside class bodies and `@layout` objects); `ArrayLit` maps elementwise.

**3.6 The JSON label rule** (06 §4 pitfall 3). A `NodeDecl` with a `StringLit` value is *always* a label. There is no way to write a bare class reference in JSON; a class must be `"@type": [...]`. The rule falls out of the grammar naturally — JSON strings are `StringLit`, never `Word` — and is stated here so nobody "fixes" it.

**3.7 Non-string scalars as node values.** The grammar's `NodeValue` admits only `Block | String | ClassRef`, so `a: 5` is a **syntax** error caught in DD-01 (`SGL1001` expecting one of those). In JSON input, `"a": 5` hits the same rule. No resolver code needed; documented for completeness.

---

## 4. Classes

Collected from `config.classes` on the **root only** (**⟶ v1.0 (A9):** imported documents contribute namespaced classes).

```ts
// @classes: { Service: { @shape: round }, Critical: { @extends: Service, @style.stroke: "@danger" } }
```

Validation:
- `@extends` is a string or array of strings; each must name a declared class → `SGL2002` otherwise.
- The extends graph must be acyclic → `SGL2004`, and the cycle is broken at the back-edge.
- Every `@type` reference anywhere in the tree must name a declared class → `SGL2002`; the reference is dropped, the node kept.
- A class body's non-`@` keys are ignored with `SGL2007` (classes carry configuration, not children).

The resolver **does not flatten** class inheritance into nodes; DD-03 computes `classes: string[]` in linearised order per node, and DD-04 applies them in the cascade. Keeping classes symbolic in the model is what keeps `.sgl.json` round-trippable.

Linearisation: depth-first over `@extends`, left to right, de-duplicated keeping the *last* occurrence — so a class listed later in `@type` overrides one listed earlier, and a subclass overrides its base. Documented in the language spec §6.

---

## 5. Edges

An `EdgeStmt` with endpoints `[e0 … en]` and ops `[o0 … on-1]` yields `n` `EdgeModel`s on the **declaring container**:

| op | from | to | directed |
|---|---|---|---|
| `->` | eᵢ | eᵢ₊₁ | `forward` |
| `<-` | eᵢ₊₁ | eᵢ | `forward` |
| `<->` | eᵢ | eᵢ₊₁ | `both` |
| `--` | eᵢ | eᵢ₊₁ | `none` |

The `EdgeValue` (label string or block) is copied onto **every** edge in the chain. `ordinal` is `i`. A `Block` on an edge must contain only `ConfigEntry`s; a `NodeDecl` or nested `EdgeStmt` inside it is `SGL2008` and ignored.

Endpoints keep their `PathExpr` unresolved. Resolution needs the complete tree and happens in DD-03.

**Wildcards are not expanded here either**, for the same reason and one more. A `PathExpr` whose last step is a `WildcardStep` travels into the model as written, and DD-03 §3.1 turns it into edges. Expansion needs the tree, so it *could* not happen at this stage; but it also *should* not, because the document model is what `toJson` serialises. Expanding at resolve time would mean `.sgl.json` recorded twelve edges where the author wrote one, and the next person to open the file would find their wildcard gone. The canonical form is a record of the document, not of its consequences.

One edge case worth naming: `ordinal` stays the index within the *declaring chain*, not within the expansion. `a.* -> b -> c.*` is two `EdgeModel`s with ordinals 0 and 1 regardless of how many nodes each wildcard matches.

---

## 6. Canonical JSON (`.sgl.json`)

```ts
toJson(model: DocumentModel): string
fromJson(text: string): ResolveResult      // = resolve(parse(text)) — the grammar accepts JSON
```

`toJson` is the only new code. Serialisation rules, so that output is stable and diffable:

1. Root object. `"@sgl": "1.0"` first, then root config keys in **registry order** (§7), then `"@classes"`, then children in declaration order, then `"@edges"` last.
2. Each child: config keys in registry order, then children, then `"@edges"`.
3. Config keys are emitted **nested** (`"@style": { "stroke": … }`), never dotted.
4. `@type` is always an array. Labels are always `"@label"`, never the string shorthand.
5. Edges: `{ "from": "payments.api", "to": "../psp", "fromPort"?, "toPort"?, "directed": "forward", …config }` — paths printed with the surface syntax (`/`, `../`, `.`, `*`, `**`), keys escaped as `\.`. A wildcard endpoint round-trips as itself: `{ "from": "lane1.*", "to": "switch", … }`.
6. Two-space indent, `\n` line endings, UTF-8, trailing newline. Numbers via `JSON.stringify`.

Because the grammar reads JSON directly, `fromJson` is not a separate parser and cannot drift from the surface syntax. The round-trip invariant tested in DD-09: `resolve(parse(toJson(m))).model ≡ m` (ignoring `spans`).

---

## 7. Config key registry

`packages/core/src/config-registry.ts`. One table drives validation here, autocomplete (**⟶ E6**), documentation, and `toJson` ordering.

```ts
interface ConfigKeySpec {
  key: string;                        // 'label', 'style.fill', 'layout.*'
  scope: readonly ('root' | 'node' | 'edge' | 'class')[];
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'any';
  enum?: readonly string[];
  order: number;                      // toJson emission order
}
```

MVP registry (order = row order):

| key | scope | type |
|---|---|---|
| `sgl` | root | string |
| `title` | root | string |
| `theme` | root | string |
| `layout` | root, node | object (`engine`, `direction`, plus engine keys) |
| `classes` | root | object |
| `label` | node, edge, class | string |
| `type` | node, edge | array of string |
| `shape` | node, class | enum — DD-07 §4 list |
| `direction` | node (containers) | enum `down up left right` — sugar, folded into `layout.direction` |
| `style` | node, edge, class | object — properties from DD-04 registry |
| `size` | node, class | object `width height minWidth minHeight maxWidth maxHeight aspectRatio` |
| `ports` | node, class | object name → `north south east west` |
| `order` | node, edge | number |
| `hidden` | node, edge | boolean |
| `link` | node, edge | string |
| `tooltip` | node, edge | string |
| `a11y` | node, edge | object `label description` |
| `meta` | any | any — passed through, never interpreted |
| `layout.*` | node, edge | any — passed through to the engine (DD-06 `hintsSchema`) |

Validation outcomes: unknown top-level `@key` → `SGL2010` warning, key kept (forward compatibility); wrong type → `SGL2011` warning, key dropped; wrong scope → `SGL2012` warning, key dropped.

**⟶ v1.0** adds `vars`, `imports`, `pin`; **⟶ v1.x** adds `icon`, `rules`.

---

## 8. Diagnostics

| Code | Severity | Message template |
|---|---|---|
| `SGL2002` | error | Unknown class `{name}`. Declare it in `@classes`. |
| `SGL2004` | error | Class `{a}` extends itself via `{cycle}`. |
| `SGL2005` | info | `{key}` is declared again here and merged with the earlier declaration. |
| `SGL2006` | warning | `@{key}` was `{scalar}` and has been replaced by an object to hold `@{key}.{sub}`. |
| `SGL2007` | warning | Class bodies hold configuration only; `{key}` ignored. |
| `SGL2008` | warning | Edge blocks hold configuration only; `{thing}` ignored. |
| `SGL2010` | warning | Unknown configuration key `@{key}`; kept but has no effect in this version. |
| `SGL2011` | warning | `@{key}` expects {type}; ignored. |
| `SGL2012` | warning | `@{key}` is not valid on {scope}; ignored. |

(`SGL2001` and `SGL2003` — unresolved endpoint and unknown port — are DD-03's.)

---

## 9. Tests

- Golden `.sgl` → canonical JSON for every corpus document.
- Redeclaration merge cases: config override, child union, edge accumulation, deep object merge.
- Chain expansion: every op, mixed chains, label propagation, ordinals.
- Class linearisation: diamond inheritance, override order, cycle diagnostic.
- Registry: one test per diagnostic code with the exact expected span.
- Round-trip property test over the corpus (DD-09 §3).
