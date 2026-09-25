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
| Collect `@classes`, validate `@type` references | **⟶ v1.0:** `@imports` (A9; designed in §10, not built) |
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
  readonly fromText?: string;                  // a canonical-JSON "from" that is not a path, kept as written (§6)
  readonly toText?: string;
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
- **Scopes** (fix round 1, item 3). A scope holds only its own entries and a pointer to its parent's; a lookup walks the chain. (The first version copied the parent's map into every scoped container, 19 s for 20 000 root variables under 5 000 scoped siblings; now about 0.15 s.)
- **One `@vars` block** is declared in a single pass in declaration order: names only. For each entry, each name its value mentions is resolved once, in the declaring scope: an earlier entry of the same block, or an enclosing scope's variable. A reference to an entry of the same block declared at or after it is `SGL2014` (error) even when an enclosing scope has the name: the block's own declaration shadows it for the whole block. Every self or mutual reference is such a reference, so cycles need no detection of their own: in `a: $b, b: $a` the error is at `a`, and `b` then uses a failed `a`. An unknown name is `SGL2013` here. A variable name must be an identifier (`SGL2011` otherwise): only an identifier can follow `$`, and it keeps the declaration order this pass depends on intact through canonical JSON, where an object moves integer-like keys first (execution plan §1). A redeclared container has one merged `@vars` bag (§3.2, later wins key by key), and "declaration order" is the merged bag's key order, which is order of first appearance.
- **Values are computed lazily** (fix round 1, item 1a). A variable's value is computed on its first use and memoised; its dependencies first, with an explicit stack (the dependency graph is acyclic by the rule above), so no chain length is a stack limit. A variable nobody uses is never computed. While computing, values share arrays and objects (`[$v0, $v0]` holds `v0`'s value twice); each use in an element's configuration then gets its own copy (`copyJson`), so no two elements of the model share an object.
- **Expansion budget** (fix round 1, items 1b and 2). Substitution is charged per document against 2 Mi units: a `$name` costs the size of the value it copies (one unit per value — scalar, array or object — plus one per character of each string, sizes memoised per built object so a shared value is measured once), and a `${name}` string costs its length, checked *before* the string is built. Past the budget the substitution is refused: one `SGL2016` for the document, at the reference that crossed, and that value is dropped like any other (a variable being computed fails, silently for its later uses). The unit and the cap follow DD-09 §1.1's 2 MB posture: a document inside the 2 MB cap cannot spell out more than 2 Mi values and characters itself. It bounds both work and memory: the first version took 38.8 s for `v24` of a doubling chain from a 421-byte document, and threw `RangeError: Invalid string length` for the string form at `n = 28`; now each is a few milliseconds and one `SGL2016`. Measured with 2^12 elements used 2 000 times: the budget is spent after about 250 uses, ~0.35 s.
- **Substitution.** `$name` takes the value with its type. `${name}` inserts a string as itself, a number as `String(n)` (so `1e-7`, `1e+21`), a bool as `true`/`false`; an object, array or null is `SGL2015` (error) and the value is dropped, like an unknown name (fix round 1, item 7: it used to leave the placeholder out and keep the string). A placeholder that is not `${identifier}` is literal text. A name no enclosing scope declares is `SGL2013` (error), and the value that holds the reference is dropped: the key at the top of the bag, an array item, or an object property, as if it were absent; the objects around it stay. A string with an unknown placeholder is dropped whole. Registry validation (§7) then runs on the substituted value, so `@order: $n` is checked as the number it is.
- **`@type` and `@extends`** hold class names. A reference in either is substituted and may give one name or a list; each name is then checked against `@classes` (`SGL2002`, spanning the reference), and a non-string is `SGL2011`.
- **`authored`.** Beside `config`, an element whose values use a variable, or a container that declares `@vars`, carries `authored`: the same bag as written, references unsubstituted, `@vars` included, and with the keys validation dropped also removed. A reference that failed to resolve stays in `authored` (so a round trip reproduces the same diagnostic) while its value is absent from `config`. `toJson` prints `authored` when present (§6); every other consumer reads `config`. Elements without variables have no `authored`, so a document without variables serialises byte-for-byte as before.

**3.6 The JSON label rule** (06 §4 pitfall 3). A `NodeDecl` with a `StringLit` value is *always* a label. There is no way to write a bare class reference in JSON; a class must be `"@type": [...]`. The rule falls out of the grammar naturally — JSON strings are `StringLit`, never `Word` — and is stated here so nobody "fixes" it.

**3.7 Non-string scalars as node values.** The grammar's `NodeValue` admits only `Block | String | ClassRef`, so `a: 5` is a **syntax** error caught in DD-01 (`SGL1001` expecting one of those). In JSON input, `"a": 5` hits the same rule. No resolver code needed; documented for completeness.

---

## 4. Classes

Collected from `config.classes` on the **root only** (**⟶ v1.0 (A9):** imported documents contribute namespaced classes; designed in §10, I11 and I13).

```ts
// @classes: { Service: { @shape: round }, Critical: { @extends: Service, @style.stroke: "@danger" } }
```

Validation:
- `@extends` is a string or array of strings; each must name a declared class → `SGL2002` otherwise.
- The extends graph must be acyclic → `SGL2004`. Each cycle is broken one canonical way, shared with DD-03 §4 (`class-graph.ts`; A8 fix round 1, item 5): rotate the cycle to start at its lexicographically smallest member, name that member in the message (`Class \`A\` extends itself via \`A -> B -> C -> A\``), and drop the back-edge *into* it — the `@extends` of the member just before it, where the diagnostic is anchored. Cycles are searched over names and bases in sorted order, without recursion, so the result depends only on the class graph, never on declaration order or chain depth. (Before, the DFS broke whichever back-edge declaration order reached first and named that class, and it recursed: 8 000 levels overflowed.)
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

Both live in `packages/core/src/json.ts`, exported as the subpath **`@sgl/core/json`**, not from the package root (A8 fix round 2, execution plan §2.1 F20): only Save ▾ → Canonical JSON uses them, from the app's lazy `file-actions` chunk, so the writers stay out of the boot bundle. Reading `.sgl.json` needs none of it — boot parses stored, opened and shared documents as source, since the grammar reads JSON.

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

A `from`/`to` string that is not a path at all (`"$a"`, `"a b"`: the synthetic
statement does not parse cleanly) used to become an empty path silently, and
`toJson` then wrote `""`. It is now kept as written in `EdgeModel.fromText` /
`toText` (A8 fix round 1, item 9): the path itself stays empty, `compile()`
reports DD-03's `SGL2001` naming the text ("Cannot find `$a` from …; the edge
was skipped"), and `toJson` prints the text back unchanged. Paths are never
substituted, so `"$a"` here is not a variable reference.

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
| `SGL2015` | error | Variable `${name}` holds {kind}, which cannot be interpolated; the value was dropped. |
| `SGL2016` | error | `{text}` would take this document's variable expansion past {limit} units; the value was dropped. |

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
- Variables (`packages/core/test/variables.test.ts`): type preservation, interpolation, shadowing across nested containers, order within a block, self, mutual and long (20 000-entry) cycles, unknown names, the expansion budget and scope-chain cost (`variables-limits.test.ts`), interpolating an object, keys never substituted, and the canonical-JSON round trip keeping the written form; `corpus/variables.sgl` is the clean corpus document.

---

## 10. Imports (A9): design

**Status: Phase 1, design only (2026-09-25). Nothing here is built yet.** The human decided the
key question: **a relative import path resolves against the user's stored documents** (Documents ▾,
DD-08 §9), so imports work offline in every browser; **Share bundles the imported documents into
the link**; **an unresolved import is a warning** and the rest of the document still renders; F5
`.sglpack` is a separate, later item. This section settles the language and core side. The app side
(the stored-document index, freshness, the share bundle) is DD-08 §15. Each decision has an
I-number, which DD-08 §15 continues. Decisions marked **⚑** change a product promise or the
language spec beyond §8's text, and go to the human before Phase 2.

### 10.1 Name matching

`resolve()` never matches names: the host does (§10.2). This is the app host's rule, stated here
because it defines what an import path *means* in SGL's own product.

- **I1. The directory part is ignored.** Only the last segment of the path counts, split on `/` or
  `\`. `./shared/classes.sgl`, `./classes.sgl` and `../x/classes.sgl` all ask for `classes`.
  *Stored documents have no folders, so there is nothing for a directory to select.*
- **I2. A path's name is its stem.** One openable extension (`.sgl.json`, `.sgl`, `.json`, `.txt`,
  longest first, DD-08 §7) is stripped if present. Any other suffix is part of the name, so
  `./v1.2 classes` is `v1.2 classes`. The stem is then sanitised exactly as Save ▾ sanitises a
  title (`sanitizeFileStem`, DD-08 §7), NFC-normalised and lower-cased (`toLowerCase`, which does
  not depend on locale). *All four extensions are the same grammar, so the extension selects
  nothing. Case is ignored because file systems and titles disagree about it.*
- **I3. A stored document answers to two names**, normalised the same way: its **file name**,
  a new optional record field `fileName` set by Open (the chosen file's name) and by a share
  bundle (DD-08 §15), and its **save name**, `sanitizeFileStem(title)`, the stem Save ▾ would
  give it. *A repository's `classes.sgl` opened into the app must answer to `./classes.sgl`
  whatever its `@title` says. A document made in the app answers to the name it would be saved
  under, so a saved and re-opened pair keeps resolving.*
- **I4. Candidates come in four tiers, and the first non-empty tier wins:** (1) the importer's own
  group by file name, (2) its own group by save name, (3) ungrouped documents by file name,
  (4) ungrouped documents by save name. A **group** is a new optional record field `group`, set
  only on the documents one share link created (DD-08 §15, I29). Documents in *another* group are
  never candidates. *Tiers keep ambiguity rare. Groups mean a share link's documents cannot change
  how any of your other documents resolve (I22).*
- **I5. When the winning tier holds more than one document, you get both a warning and a
  pick.** `SGL2018` (warning) names the count, and the most recently updated document is used
  (ties go to the smaller id). *The author learns that the name is ambiguous, and the document
  still renders the same way for a given store.*
- **I6. An importer does not have to be stored.** Directories are ignored, so the importer's own
  location never matters. Its identity matters only for noticing that it imports itself:
  `self` is optional in core (a CLI or a test may leave it out), and the app always passes the
  open document's id. In the app every open document is already a record: boot and a share link
  create one before the pipeline runs, and the memory store is used when IndexedDB is unavailable.
  So "a fresh share import that is not stored" does not happen there.

### 10.2 Core API

```ts
// @sgl/core — boot path
function resolve(ast: Document, options?: ResolveOptions): ResolveResult;
interface ResolveOptions { readonly imports?: ImportLinker }
function hasImports(ast: Document): boolean;          // does the root have an `@imports` entry?

// @sgl/core/imports — a new core entry, loaded lazily by the app (§10.9)
interface ImportHost {
  /** Synchronous and side-effect free. `from` is the importing document's key
   *  (undefined for a root without `self`). `candidates` > 1 → SGL2018. */
  lookup(path: string, from: string | undefined): ImportAnswer | undefined;
}
interface ImportAnswer { readonly key: string; readonly source: string; readonly candidates: number }
interface ImportCache { /* opaque; memoises parse and per-import resolve */ }
function createImportCache(): ImportCache;
function createImportLinker(host: ImportHost, options?: { self?: string; cache?: ImportCache }): ImportLinker;
```

- **I7. `resolve()` takes imports through an `ImportLinker` built from a synchronous
  `ImportHost`.** `resolve()` stays synchronous, and it stays a pure function of the AST and the
  host's answers. `resolve.ts` itself only reads `@imports`, calls the linker and folds in what it
  returns: classes, a variable scope, subtrees, failed namespaces and diagnostics. Everything
  else lives in `@sgl/core/imports`: checking paths, lookup, cycles, caps, parsing, resolving each
  import and grafting it. *This keeps the host async-free, keeps the boot bundle small (§10.9),
  and a CLI can supply a file-system host with the same linker.*
- **I8. An imported document is parsed in core, by the linker, with core's own `parse()`**, the
  same Lezer parser `resolve.ts` already uses for `"@edges"` (§6). The app only ever hands core
  text, so its rule that it never calls `parse` holds unchanged: the pipeline's boot-time `parse`
  is still its only, lint-allowed call site. Parsing and each import's `resolve` are memoised in
  an `ImportCache` that the caller owns. The parse is keyed by the source text. The resolve is
  keyed by the source, the `as`, and the answers its own lookups got (checked by looking them up
  again). *On a keystroke in the importer, an unchanged set of imports then costs only lookups.*
- **I9. With no linker, every `@imports` entry is `SGL2017`** (unresolved, a warning). This
  covers `fromJson`, tests, and anything else that calls `resolve(ast)` alone. *The behaviour is
  defined for every caller, and never silent.*

**What `@imports` holds** (spec §8): an array whose items are each a string path, or an object
`{ path: "<string>", as: <identifier> }` (`as` a bareword in `.sgl`, a string in JSON). Anything
else is `SGL2011` and that item is ignored: an `@imports` that is not an array, an item that is
neither form, a missing or non-string `path`, an `as` that is not an identifier, or an unknown
key in the object. `@imports` below the root is `SGL2012`, from the registry scope. A variable in
`@imports` is not substituted, because imports are linked before variables exist: `$x` is
`SGL2011`, and `"$x"` is the literal path `$x`. A redeclared `@imports` follows every other
configuration key: later wins.

### 10.3 Semantics

- **I10. An import without `as`** contributes its classes and its root `@vars`, unqualified.
  Its nodes, its edges and its root configuration (`@title`, `@theme`, `@layout`, …) are not
  imported. If it has any nodes or edges, `SGL2026` (info) says so. *This is §8's "never
  anonymous root nodes". Info rather than warning, because a class library is often written with
  a few preview nodes to look at while editing it.*
- **I11. An import with `as: ns`** contributes:
  - its classes as `ns.Name`, with their own `@extends` rewritten to match;
  - its root variables as `$ns.name`;
  - if it has at least one node or edge, a container `ns` at the importer's root. That container
    holds the import's root children and root edges. Its label is the import's `@title`, or the
    key `ns` if it has none. The import's other root configuration is dropped.

  *Spec §8, with one name reaching all three. A qualified name in class position (`lambda:
  aws.Lambda`, `@type: aws.Lambda`) is a class, and in an edge endpoint (`api -> aws.lambda`) it
  is a path. That is the same split between class names and node keys that SGL already has.*
- **I12. How a subtree is grafted.** Grafted containers come **first** among the root's children,
  in `@imports` order. An absolute path inside the subtree (`/x.y`) is prefixed to `/ns/x/y`. A
  `../` that would climb out of the import's own root is kept as written (`EdgeModel.fromText`,
  §6), so `compile()` reports it (`SGL2001`, contained by I17) instead of letting it reach the
  importer's nodes. Every span in the subtree, including the span-table keys `n:`/`e:`/`c:`, is
  remapped to the span of the `@imports` item (the `remapPathSpans` approach, §6). The `ns`
  container carries a new optional field `ContainerModel.origin` (the import's path and span), and
  so does each imported `ClassModel`. `documentTitle` (DD-08 §7) skips grafted containers, so a
  document with no `@title` is not named after its first import. *An import can reach only
  itself. Identity is stable. A click on an imported node lands on the line that imports it.*
- **I13. Precedence: your own definitions, then later imports, then earlier imports.**
  - **Variables.** The imported names form a scope that encloses the root scope, so your own
    `@vars` shadow them silently, like any shadowing in §5. Among imports, a later import
    shadows an earlier one.
  - **Classes.** One flat table. A class name from an unqualified import that you also declare
    is **replaced whole** by yours, with `SGL2023` (info). Between two imports, the later one
    replaces the earlier one, and gets the same info. An unqualified imported class's `@extends`
    names are looked up in that final table, so they bind late: shadowing a base changes what
    the imported class extends. Any cycle this creates is `SGL2004`, from the existing
    `class-graph.ts` machinery, which runs over the merged table.
  - **Extending instead of replacing.** Import with `as` and write `Service: { @extends: lib.Service, … }`.

  *This is lexical shadowing and "later wins", as everywhere else. Replacing rather than merging
  keeps `toJson` exact (I31): a merged class would need to remember which half was written here.*
- **I14. Clashes.**
  - Two imports with the same `as`: the second is skipped (`SGL2022`).
  - An `as` equal to one of your own root node keys, when the import brings a subtree: the
    subtree is not grafted (`SGL2022`), but its classes and variables still arrive.
  - A class name you declare that contains `.` is reserved for imports: `SGL2011`, and that class
    is ignored. **⚑** Before this, a quoted `"a.b"` was a legal class name.

  *An authored tree and an imported tree never merge, so `toJson` prints exactly what was
  written. The container's label comes from the import's `@title`, and its position from import
  order. A way to style or place it is a follow-up item.*
- **I15. Imports are transitive, and each document resolves in isolation.** An import's own
  imports are linked with the same host and linker. Qualifiers compose: if B imports C `as: c`,
  and A imports B `as: b`, A sees `b.c.X`, `$b.c.x` and nodes under `b.c`. An unqualified import's
  names are exported by the document that imported it, as if they were its own. An imported
  document never sees its importer's variables or classes: there is no dynamic scope. *Libraries
  compose, and a document means the same thing wherever it is imported from.*
- **I16. ⚑ Qualified names in the grammar (DD-01).** Today `lambda: aws.Lambda`, §8's own
  example, is a syntax error, because `ClassRef` and `Word` are one `Identifier` and `Variable` is
  `"$" Identifier`. The proposed change:
  - `ClassRef` and `Word` become `Identifier ("." Identifier)*`, a production, not a token.
    `.` never starts an entry, so there is no LR conflict.
  - The `Variable` token becomes `"$" Identifier ("." Identifier)*`.
  - A *string* that is exactly `"$ns.name"`, or holds `${ns.name}`, is a reference **only when
    `ns` is an import namespace of this document**. Otherwise it is literal text, as it is today,
    so an existing label such as `"$user.name"` does not become `SGL2013`.

  Spec §2 (the class shorthand) and §5 (variable names and interpolation) change to match.
- **I17. ⚑ A failed import produces warnings, never errors.** The pipeline adopts a new picture
  as `lastGood` only when no diagnostic is an error (DD-08 §3). So the human's "an unresolved
  import is a warning, and the rest still renders" holds only if nothing that the failure
  *causes* is an error either. Therefore:
  - A reference whose qualifier names an import that failed is `SGL2024` (warning) instead of
    `SGL2002`, `SGL2013` or `SGL2001`, and is dropped. Failed here means unresolved, skipped for a
    cycle or a cap, or refused. Such references include `aws.Lambda`, `$aws.x` and `api ->
    aws.lambda`; the last is checked by `compile()` against `DocumentModel.imports`.
  - If any unqualified import failed, an unknown bare class or variable is `SGL2024`, naming that
    import, instead of `SGL2002` or `SGL2013`.
  - Problems *inside* an import are one `SGL2021` (warning) for each top-level `@imports` item,
    giving the count and the first message. This covers the import's own resolve diagnostics at
    any depth, and `compile()`'s diagnostics on grafted elements, which `compile()` recognises by
    `origin`. Info-level diagnostics are not counted.

  All of this extends the human decision from "unresolved" to every way an import can fail.
- **I18. Identity, order and determinism.** A grafted node's id is its path (`aws.lambda`), so
  it is stable while the `as` stays the same. `graph.order` lists grafted containers first and
  then your own nodes. The `classes` record lists imported classes first, in import order, then
  your own. Its key order still counts as undefined (execution plan §1), so nothing may depend on
  it. `resolve()` is a pure function of the AST and the host's answers, and the double-run test
  uses a fixed host.

### 10.4 Caps and security

- **I19. Only relative paths.** An empty path is `SGL2025` (warning), and the import is skipped.
  So is a path that starts with `/` or `\` or `//`, or that has a `scheme:` or drive prefix before
  its first separator (`https:`, `file:`, `C:`). There is no host option for remote imports in
  v1: a synchronous `lookup` cannot fetch. *Spec §8 and §11, DD-09 §1.1: A9 is relative only.*
- **I20. Cycles.** The linker keeps the chain of host keys, starting from `self`. An import whose
  key is already on the chain is skipped with `SGL2019` (warning), which names the chain
  (`a -> b -> a`). A document that imports itself is the chain of length one. A diamond, the same
  document reached twice by different routes, is not a cycle. It is linked twice (the cache makes
  the second time cheap) and counts twice toward the caps.
- **I21. Caps, per root `resolve()`:**
  - **depth 8**;
  - **64 import instances**;
  - **2 Mi code units of imported source**, summed per instance, the same 2 MB posture as
    DD-09 §1.1 and the variable budget;
  - the **2 Mi-unit variable-expansion budget** (§3.5) is **shared by the whole closure** rather
    than given to each document. **⚑** Spec §5 says "per document".

  The import that would cross a cap is skipped, with one `SGL2020` (warning) per cap. *A diamond
  chain (`D1` imports `D2` twice, `D2` imports `D3` twice, …) is exponential without an instance
  cap. Each import could otherwise bring its own 2 Mi budget.*
- **I22. A stored document's text is untrusted content, like any document.** It is the user's
  own, but it may have arrived in a share link. Every string it contributes goes through the same
  resolve, compile and escaping path as the importer's own text (DD-07 §8). An import adds no new
  capability: no network, no script, no new markup. The new threat is a share link that plants
  documents in your store which change how your *other* documents resolve. Groups mitigate it
  (I4): a bundle's documents are visible only to their own group. Phase 2 adds this as a row in
  DD-09 §1.1, alongside the caps above.

### 10.5 Canonical JSON

- **I31. `@imports` is kept exactly as written.**
  - The model keeps it in `DocumentModel.imports`, a new optional field (`{ path, as?, form:
    'string' | 'object', span }[]`) that is present only when the document has `@imports`.
  - The failed imports are kept too, with a status that `compile()` reads (I17).
  - A new registry row `imports` (root, array) orders it just before `classes`.
  - `toJson` prints it in the form it was written in, and **omits** grafted containers and
    imported classes (anything with `origin`).
  - `fromJson(toJson(m)) ≡ m` still holds, given the same host.
  - A `.sgl.json` is therefore **not self-contained**: it needs its imports, just as the `.sgl`
    does. Bundling them is F5.
  - A document without `@imports` serialises byte for byte as before, so no golden changes.

### 10.6 Diagnostics

New rows. Every one is a **warning** or **info** (I17), and each gets a corpus fixture (§10.8).
Existing codes are reused where they fit: a malformed `@imports` is `SGL2011`, `@imports` below
the root is `SGL2012`, a class name containing `.` is `SGL2011` (I14), and a shadowed-base cycle
is `SGL2004` (I13).

| Code | Severity | Message template | Where |
|---|---|---|---|
| `SGL2017` | warning | Cannot find `{path}` to import; nothing was imported from it. | boot catalogue (no linker, I9) + linker |
| `SGL2018` | warning | `{path}` matches {n} documents; importing `{chosen}`, the most recently updated. | import catalogue |
| `SGL2019` | warning | `{path}` imports itself via `{cycle}`; this import was skipped. | import catalogue |
| `SGL2020` | warning | Importing `{path}` would go past {limit}; it was skipped. | import catalogue |
| `SGL2021` | warning | `{path}` has {n} problems of its own; the first: {first} | boot catalogue (`compile()` emits it too) |
| `SGL2022` | warning | `{name}` is already {what}; {outcome}. | import catalogue |
| `SGL2023` | info | Class `{name}` here replaces the one imported from `{path}`. | import catalogue |
| `SGL2024` | warning | `{name}` may come from `{path}`, which could not be imported; {what} was skipped. | boot catalogue (`resolve()` and `compile()`) |
| `SGL2025` | warning | `{path}` is not a relative path; only your own documents can be imported. | import catalogue |
| `SGL2026` | info | The nodes and edges of `{path}` are not imported; give the import an `as:` name to include them. | import catalogue |

The "import catalogue" rows live in `@sgl/core/imports`, built with the same `fromCatalogue` that
`LAYOUT_CATALOGUE` uses (execution plan §1), so they stay off the boot path. `DiagnosticCode`
still names every code, through a type-only import, and the coverage gate reads both catalogues.

### 10.7 Where this lands in DD-02's other sections (Phase 2)

- §1: `@imports` moves to "Does".
- §2: `DocumentModel.imports`, `ContainerModel.origin`, `ClassModel.origin`.
- §3: resolution order becomes: split the root entries (`@imports`, `@classes`, `@vars`); link
  the imports; declare the root's `@vars` on the imported scope; collect classes (imported
  first); build the tree, with grafted children first.
- §4: its "⟶ v1.0 (A9)" note is replaced by I11 and I13.
- §6: I31.
- §7: the `imports` row.
- §8: the table above.
- DD-01: I16. DD-03: I17's two `compile()` rules.

### 10.8 Test plan (core; the app's is DD-08 §15)

- **`packages/core/test/imports.test.ts`, against an in-memory `ImportHost`.**
  - Both forms, with and without `as`.
  - Classes, variables and a subtree arriving, with qualifiers composing (I15).
  - Precedence and shadowing, `SGL2023`, the late-bound `@extends` and its `SGL2004` (I13).
  - Clashes (I14).
  - Absolute and escaping paths in a subtree (I12).
  - Spans remapped to the import item (I12).
  - `SGL2024` containment for classes, variables and edges; `SGL2021` summaries, including
    `compile()` diagnostics on grafted nodes (I17).
  - Qualified-name parsing, and a literal `"$user.name"` kept literal (I16).
  - A double-run test for byte-identical output.
  - `hasImports`.
- **`imports-limits.test.ts`.**
  - Every `SGL2025` form.
  - Self, mutual and long cycles.
  - Depth 8 passes and depth 9 does not; 64 and 65 instances; 2 Mi code units of source.
  - A diamond chain at n = 30 finishes in milliseconds with one `SGL2020`.
  - A doubling-variable chain spread across imports hits the shared `SGL2016`.
- **Corpus.** `corpus/imports/`: a directory of documents that import one another, run by a
  Node file-system host that matches stems within the directory (I1–I2). It has at least one
  clean document with goldens, and one fixture per new code, for the coverage gate. No existing
  golden changes.
- **Round trip.** `fromJson(toJson(m)) ≡ m` over `corpus/imports/`, with the same host (I31).
- **Cache.** A second `resolve` with an unchanged closure does no parse, which the test checks by
  counting the host's and the parser's calls.
- **Performance.** `bench/generate.js` gains an importer of a 500-node import. The keystroke path
  stays within DD-09 §2 (50 nodes: < 60 ms, with the import cached).

### 10.9 Bundle budget

Headroom on `main` is **1.10 kB** of the 180 kB limit (execution plan §2.1 F20). The rough
estimates below are to be measured, not trusted.

- **I32. The boot path carries only the hook.**

  | Piece | Estimated cost, gzipped |
  |---|---|
  | `resolve.ts`: read `@imports`, call the linker, fold in the result; `hasImports` | ≈ 0.35–0.5 kB |
  | `compile()`: the I17 rules | ≈ 0.1–0.15 kB |
  | The grammar change (I16), in the parser tables | < 0.1 kB |
  | Three catalogue rows (`SGL2017`, `SGL2021`, `SGL2024`) | ≈ 0.15 kB |
  | The pipeline's gate and lazy load (DD-08 §15) | ≈ 0.15 kB |
  | **Total** | **≈ 0.8–1.0 kB** |

  Everything else goes in a lazy **`imports`** chunk: `@sgl/core/imports` (path checks, lookup,
  cycles, caps, grafting, its catalogue) and the app's index and host. It loads only for a
  document with `@imports` (DD-08 §15, I25). `size-limit` names it as excluded, like `share` and
  `file-actions`, and `check-core-chunks.mjs` keeps it off the entry's static imports.
- **Prerequisite, and the first commit of Phase 2:** F20's named candidate, **`DocumentsMenu` as a
  lazy chunk** (about 1.75 kB minified). This is expected to take the headroom to about
  1.7–1.8 kB before A9 adds its share. If A9's measured boot cost still leaves less than 0.3 kB,
  Phase 2 stops and reports under §1's rule. It does not trim anything else unasked, and it does
  not raise the limit.
