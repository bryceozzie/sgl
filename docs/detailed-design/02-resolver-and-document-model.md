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
| Collect `@classes`, validate `@type` references | **⟶ v1.0:** `@imports` (A9) |
| Validate config keys against the key registry | |
| Substitute `@vars` (A8, §3.5) | |
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
  readonly authored?: ConfigBag;               // @-keys as written, for toJson only (§3.5)
}

interface EdgeModel {
  readonly from: PathExpr;                     // relative to this container
  readonly to: PathExpr;
  readonly fromPort?: string;
  readonly toPort?: string;
  readonly directed: 'forward' | 'both' | 'none';   // '<-' already swapped into 'forward'
  readonly config: ConfigBag;
  readonly ordinal: number;                    // index within the declaring chain, for stable IDs
  readonly authored?: ConfigBag;               // @-keys as written, for toJson only (§3.5)
}

interface ClassModel {
  readonly name: string;
  readonly extends: readonly string[];
  readonly config: ConfigBag;                  // only @-keys are meaningful in a class body
  readonly authored?: ConfigBag;               // @-keys and `extends` as written, for toJson only (§3.5)
}

type ConfigBag = Readonly<Record<string, ConfigValue>>;
type ConfigValue = string | number | boolean | null | readonly ConfigValue[] | ConfigBag;

type SpanTable = ReadonlyMap<string, SourceSpan>;   // key: 'n:payments.api' | 'e:payments.api#3' | 'c:Service'
```

A span-table path is joined and escaped by `nodeIdFromPath` (`packages/core/src/ids.ts`) — the same function DD-03 §2.1's `NodeId` is built from, so a key written `a\b.c` produces the identical string on both sides (`\` escaped before `.`, so the dot introduced by escaping the backslash is never mistaken for a real one). `resolve()` has no reason to reimplement this, and didn't always: an earlier version escaped only `.`, which is a silent lookup miss the moment a key contains a literal backslash.

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

**3.5 Config value coercion and variables.** Values arrive as AST literals; `Word` becomes its string; `ObjectLit` becomes a `ConfigBag` (its `@`-prefixed property keys drop the `@`; unprefixed keys are kept — both appear inside class bodies and `@layout` objects); `ArrayLit` maps elementwise.

Variables (A8; the language rules are language spec §5) are substituted here, so every consumer of the model — `compile()`, the theme cascade reading `classes[…].config`, the layout engines — sees plain values and none of them knows variables exist. Until A8 a `Variable` was kept as its literal `$name` text with `SGL2009`; that code is retired (§8).

- **Coercion keeps references.** A `Variable`, a string that is exactly `$name` (the canonical-JSON spelling, §6), and a string holding a `${name}` placeholder coerce to a `Ref` (`resolve.ts`) that remembers the text as written and its span. Any other `$` is literal text. There is no escape for `$` in the grammar, so none here.
- **Substitution happens when an element is finalised**, not when the value is inserted, because only then is the element's scope complete: a container's `@vars` may come after a use, or in a later redeclaration (§3.2). Merging (§3.2, §3.4) therefore works on the written form. Root's `@vars` are resolved first, since class bodies (§4) are declared at the root and substitute from its scope; an edge's configuration, which used to be validated at the statement, is now finalised with its declaring container (one chain's shared bag once).
- **Scopes.** Each container that declares `@vars` pushes a scope on its parent's; its own configuration, its edges and its children resolve through it. The `@vars` bag itself is taken out of `config` (it has no meaning downstream); the registry row `vars` (§7) exists for key order in `toJson` and to reject `@vars` on a class or an edge (`SGL2012`). `@vars` that is not an object is `SGL2011`.
- **One `@vars` block** resolves in a single pass in declaration order. An entry sees the enclosing scopes and the earlier entries of its own block. A reference to an entry of the same block declared at or after it is `SGL2014` (error) even when an enclosing scope has the name: the block's own declaration shadows it for the whole block. Every self or mutual reference is such a reference, so cycles need no detection of their own: in `a: $b, b: $a` the error is at `a`, and `b` then uses a failed `a`. (A first version found cycles with an iterative Tarjan to name them in the message; it cost more of the core-bundle budget than it was worth.) A failed variable is recorded as failed, and a use of it drops the value without a second diagnostic. Nothing here recurses on the number of variables, so a block of any length cannot overflow the stack. A variable name must be an identifier (`SGL2011` otherwise): only an identifier can follow `$`, and it keeps the declaration order this pass depends on intact through canonical JSON, where an object moves integer-like keys first (execution plan §1).
- **Substitution.** `$name` takes the value with its type, copied, so no two elements share an object. `${name}` inserts a string as itself, a number as `String(n)`, a bool as `true`/`false`; an object, array or null is `SGL2015` (error) and the placeholder is left out. A name no enclosing scope declares is `SGL2013` (error), and the value that holds the reference is dropped: the key at the top of the bag, an array item, or an object property, as if it were absent. A string with an unknown placeholder is dropped whole. Registry validation (§7) then runs on the substituted value, so `@order: $n` is checked as the number it is.
- **`@type` and `@extends`** hold class names. A reference in either is substituted and may give one name or a list; each name is then checked against `@classes` (`SGL2002`, spanning the reference), and a non-string is `SGL2011`.
- **`authored`.** Beside `config`, an element whose values use a variable, or a container that declares `@vars`, carries `authored`: the same bag as written, references unsubstituted, `@vars` included, and with the keys validation dropped also removed. A reference that failed to resolve stays in `authored` (so a round trip reproduces the same diagnostic) while its value is absent from `config`. `toJson` prints `authored` when present (§6); every other consumer reads `config`. Elements without variables have no `authored`, so a document without variables serialises byte-for-byte as before.

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

**Wildcards are not expanded here either**, for the same reason and one more. A `PathExpr` with a `WildcardStep` in any position (`lane1.*`, or since 2026-09-24 `store*.api*`) travels into the model as written, and DD-03 §3.1 turns it into edges. Expansion needs the tree, so it *could* not happen at this stage; but it also *should* not, because the document model is what `toJson` serialises. Expanding at resolve time would mean `.sgl.json` recorded twelve edges where the author wrote one, and the next person to open the file would find their wildcard gone. The canonical form is a record of the document, not of its consequences.

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
5. Edges: `{ "from": "payments.api", "to": "../psp", "fromPort"?, "toPort"?, "directed": "forward", "ordinal": 0, …config }` — paths printed with the surface syntax (`/`, `../`, `.`, `*`, `**`). A wildcard endpoint round-trips as itself: `{ "from": "lane1.*", "to": "switch", … }`.
6. Two-space indent, `\n` line endings, UTF-8, trailing newline. Numbers via `JSON.stringify`.

**Two corrections made while implementing this, both because they would otherwise break the round-trip invariant below:**

- A path segment that needs quoting is printed as a **quoted JSON string**
  segment (`outer."metrics.v2"`), not "escaped as `\.`" as this rule
  originally said. `Identifier` cannot contain a backslash (`sgl.grammar`),
  so a backslash-dot form would not re-parse; a quoted segment is already
  legal in `Path` (`PathSegment { Identifier | String }`) and does. "Needs
  quoting" means *not* matching `Identifier` exactly —
  `^[A-Za-z_](?:[A-Za-z0-9_]|-[A-Za-z0-9_])*$` — not the looser
  `[A-Za-z_][A-Za-z0-9_-]*` a first pass used, which let a trailing or
  doubled `-` (`a-`, `a--b`) print unquoted and re-parse one character short:
  a silent edge retarget with no diagnostic.
- `"ordinal"` is now part of the edge object (rule 5), always emitted. Without
  it, every edge in `"@edges"` is independently declared — there is no way to
  reconstruct "index within the declaring chain" for the second and later
  edges of a hand-written multi-op chain, so `fromJson(toJson(m))` silently
  renumbered them to `0`. A hand-written `.sgl.json` may omit it; it then
  defaults to `0`.

`"@edges"` is also how `resolve()` reads an edge back out of strict JSON — the
grammar has no dedicated production for it (a container's own `Entry*` grammar
never produces one; only infix `a -> b` does). `resolve()` treats a
`"@edges": [...]` config entry as structural rather than generic data: each
array item's `from`/`to` strings are re-parsed through the ordinary `Path`
grammar (as a tiny synthetic `text -> placeholder` edge statement) rather than
a second, hand-rolled path parser that could drift from the real one. That
re-parse's own spans are offsets into the throwaway synthetic string, not the
real document, so `resolve()` immediately collapses every span in the
returned `PathExpr` to the real `from`/`to` string literal's own span
(`remapPathSpans`) — otherwise a later `SGL2001`/`SGL3003`/`SGL3004` (Stage C)
or an editor underline (Stage I) would anchor on arbitrary, unrelated text in
the real source.

**Variables (A8).** A container, edge or class with an `authored` bag (§3.5) is printed from it rather than from `config`: `"@vars"` and every reference appear as written (`"stroke": "$hot"`, `"@label": "API (${tier})"`, `"@type": ["$kind"]`), which is what the worked example in language spec §9 has always shown. Reading them back, a string that is exactly `$name` is a reference again, so `fromJson(toJson(m))` substitutes the same values and rebuilds the same `authored`.

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
| `vars` | root, node (containers) | object — taken out of `config` into the variable scope; kept in `authored` (§3.5) |
| `label` | node, edge, class | string |
| `type` | node, edge | array of string |
| `shape` | node, class | enum — DD-07 §4 list |
| `direction` | root, node (containers) | enum `down up left right` — sugar, folded into `layout.direction` |
| `style` | node, edge, class | any — properties from DD-04 registry |
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

`shape` and `direction` are typed `enum` for documentation only — the resolver
never rejects a value against the list. Whether a shape name is one of the
seven the MVP renderer draws is `SGL3001` (DD-03/DD-07), a rendering fallback,
not a resolution error, and enforcing it twice would just race the two
diagnostics. `style` is typed `any` for the same kind of reason, but for a
concrete case the corpus exercises: `@style: dashed` (`chains.sgl`,
`checkout.sgl`) is a bareword shorthand, not the object this table originally
required, and real validation of a style value is DD-04's job regardless.

`direction`'s scope includes `root`: it is sugar for `@layout.direction`, and
root carries its own `@layout` block (language spec §4's document-level
keys), so the sugar has to reach exactly as far as the thing it desugars to.
An earlier version of this table scoped `direction` to `node` only, which
made `@direction` at the document root a silent no-op — `SGL2012`, dropped —
while the equivalent `@layout: { direction }` worked at the same scope. The
resolver folds the sugar for `root` and `node` alike (before validation runs,
so the registry row's own scope is really only load-bearing for tooling and
for a value outside the enum, same as `shape` above).

A key whose language-spec §4 row says `any` means *any element* — node,
edge, container, class — never the document root; that ambiguity in the spec
table is now resolved explicitly there. `style`, `hidden` and `a11y` keep
this table's narrower per-key scopes (`hidden`/`a11y` exclude `class`, for
instance) rather than widening to match "any element": DD-03 §4 only pulls
`shape` out of a node's class chain today, so a class-scoped `@hidden` would
validate and then reach no consumer — a decision for whichever stage adds
class-derived fallback for other keys, not one to make by relaxing a scope
list ahead of it.

**⟶ v1.0** adds `imports`, `pin` (`vars` landed with A8); **⟶ v1.x** adds `icon`, `rules`.

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
| `SGL2013` | error | Unknown variable `${name}`; the value was dropped. |
| `SGL2014` | error | Variable `${name}` is not declared before `{user}` in its `@vars` block; the value was dropped. |
| `SGL2015` | error | Variable `${name}` holds {kind}, which cannot be interpolated; it was left out. |

`SGL2009` ("Variable `${name}` is not substituted in this version; kept as literal text.") was A8's placeholder and is retired: substitution made it unreachable, and the coverage gate (DD-09 §3.4) requires a fixture that emits every catalogued code, so its row and its fixture were removed. The number is never reused (DD-00 §3).

(`SGL2001` and `SGL2003` — unresolved endpoint and unknown port — are DD-03's.)

---

## 9. Tests

- Golden `.sgl` → canonical JSON for every corpus document.
- Redeclaration merge cases: config override, child union, edge accumulation, deep object merge.
- Chain expansion: every op, mixed chains, label propagation, ordinals.
- Class linearisation: diamond inheritance, override order, cycle diagnostic.
- Registry: one test per diagnostic code with the exact expected span.
- Round-trip property test over the corpus (DD-09 §3).
- Variables (`packages/core/test/variables.test.ts`): type preservation, interpolation, shadowing across nested containers, order within a block, self, mutual and long (20 000-entry) cycles, unknown names, interpolating an object, keys never substituted, and the canonical-JSON round trip keeping the written form; `corpus/variables.sgl` is the clean corpus document.
