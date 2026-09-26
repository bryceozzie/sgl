# SGL Language — Design Spec (draft v0.1)

Two representations of the same document model:

- **`.sgl`** — the *surface syntax*. A JSON superset tuned for humans: unquoted keys, optional commas, comments, infix edges.
- **`.sgl.json`** — the *canonical form*. Strict JSON, lossless (except comments and formatting), the thing tools generate and consume.

`sgl fmt` normalises `.sgl`. `sgl to-json` / `sgl from-json` convert losslessly in both directions.

---

## 1. The core rule

> **A key with an object body is a container. Inside it, `@`-prefixed keys are configuration; everything else is a child node.**

That single sigil resolves the ambiguity in "contents are children or container configuration" without reserved words. A node can legitimately be called `label`, `shape`, `style`, or `direction` — those are only configuration when written `@label`, `@shape`, `@style`, `@direction`.

```sgl
// A container with two config keys and two children
platform: {
  @label: "Platform Team"
  @shape: package

  api:  { @label: "API Gateway" }
  auth: { @label: "Auth Service" }
}
```

See [ADR-0001](adr/0001-config-key-sigil.md) for the alternatives considered.

**Root braces are optional.** A document may be written as a bare sequence of entries (as above) or
wrapped in a single `{ … }`. This is what makes the superset claim literally true: any JSON object
is a valid SGL document.

---

## 2. Nodes

### Declaration forms

```sgl
db                          // bare node, label defaults to the key
web: "Web Front End"        // string shorthand => @label
cache: Redis                // bareword shorthand => @type (a declared class)
queue: { @shape: cylinder } // full form
```

`Redis` above is a *class* reference, not a label. Classes are declared with `@classes` (§6). An unresolved bareword is a diagnostic, not a silent label.

**A class name may be qualified** by an import's namespace (§8): `lambda: aws.Lambda`, `@type: [aws.Lambda, b.c.D]`, `@extends: lib.Service`. The parts are identifiers joined by `.`; a qualified name in class position is a class, while in an edge endpoint (`api -> aws.lambda`) the same spelling is a path, as it always was. In a document with `@imports`, a class you declare yourself may not contain `.`: such names are reserved for imports, and a quoted `"a.b": { … }` in `@classes` is `SGL2011` and ignored. A document without `@imports` keeps a quoted `"a.b"` class as before.

**In canonical JSON the distinction is by rule, not by quoting** — JSON has no barewords. A string
value under a non-`@` key is *always* a label; a class must be written as `@type`. Canonicalisation
expands `cache: Redis` to `"cache": { "@type": ["Redis"] }`, so a generated file never hits the
ambiguity; the rule exists for hand-written `.sgl.json`.

A non-`@` key whose value is a number, boolean, `null`, or array is an error (`SGL2xxx`), never a
silent label. The only scalar shorthand is the string-to-label one.

### Identity

Every node has a **path**: the dot-joined chain of keys from the document root, e.g. `platform.api.handler`. Paths are the stable identity used by edges, selectors, source maps, and SVG element IDs.

Keys match `[A-Za-z_][A-Za-z0-9_-]*`; anything else must be quoted (`"order service": { ... }`). Quoted keys with dots in them are escaped in paths as `\.`.

### Nesting

Nesting has one meaning: **containment**. A container is a node that happens to have children; there is no separate "group" concept. Containers get their own geometry, their own title, and may carry their own layout engine.

---

## 3. Edges

### Infix form

```sgl
api -> db                       // directed
api <- db                       // reversed (sugar for db -> api)
api <-> db                      // bidirectional
api -- db                       // undirected
api -> queue -> worker -> db    // chain, expands to 3 edges
```

### Labels and attributes

```sgl
api -> db: "reads"                       // string shorthand => @label
api -> db: { @label: "reads", @style: dashed, @width: 2 }
```

### Scoping and references

Edges may be declared at any depth. Endpoints resolve **relative to the enclosing container**, with:

| Form | Meaning |
|---|---|
| `sibling` | a name in the current container |
| `child.grandchild` | descend |
| `../other` | up one level, then descend |
| `/platform/api` | absolute from the document root |

```sgl
platform: {
  api: {}
  auth: {}
  api -> auth              // both resolve inside `platform`
  api -> ../external.cdn   // reaches out of the container
}
```

### Ports

Ports are named attachment points. Layout engines that declare `capabilities.ports` honour them; others fall back to shape-boundary attachment.

```sgl
router: {
  @ports: { in: west, out: east, mgmt: north }
}
client -> router[in]
router[out] -> server
```

Port references use a **bracket suffix** and are valid only in edge endpoints. Graphviz's
`node:port` form was rejected because `router:out -> server` at statement start is
indistinguishable from the key `router` with value `out` without whitespace sensitivity — which
would poison error recovery (FR-L12). `[` never follows an identifier anywhere else in the grammar,
so this needs one token of lookahead and cannot collide with array literals.

### Edges to containers

`a -> platform` attaches to the container's boundary — one edge, drawn to the container's outline. To reach the things *inside* it instead, use a wildcard.

### Wildcard endpoints

```sgl
lane1.* -> switch        // every direct child of lane1, one edge each
switch -> lane1.*        // ...and the same in reverse
lane1.** -> switch       // every descendant of lane1, at any depth
lane1.cam* -> switch     // every child of lane1 whose key starts with "cam"
store*.api* -> payments.api   // every api* child of every store* container
```

| Form | Matches |
|---|---|
| `path.*` | every **direct child** of `path` |
| `path.**` | every **descendant** of `path`, at any depth, containers included |
| `path.cam*` | every direct child whose key **starts with** `cam` |
| `path.*-db` | every direct child whose key **ends with** `-db` |
| `path.cam*hd` | every direct child whose key starts with `cam` **and** ends with `hd` |

A wildcard is **only valid in an edge endpoint**. A `*` or a name glob may be **any part of the path**, not only the last (human decision 2026-09-24); `**` may only be the last:

```sgl
store*.api* -> payments.api      // the api* children of every store* container
*.api -> db                      // the api child of every child of the enclosing container
lane*.cam* -> switch             // every cam* child of every lane* container
/platform.*.handler -> bus       // the handler of every child of platform
platform.**.api -> db            // error (SGL3004): ** only as the last part
```

**Parent segments.** Each wildcard segment matches the **direct children**, by key, of every node the path has reached so far — exactly as a final glob does — and a literal segment after it names that child of each of them. So `lane1.*.handler` is "the `handler` of every child of `lane1`", and `store*.api*` is "every `api*` child of every `store*` child of the enclosing container".

- **`**` stays last.** `platform.**.api` is an error (`SGL3004`), not a search: "every `api` at any depth" is a selector, and selectors are §7. `platform.*.**` is valid — every descendant of every child of `platform`. A path with `**` in a non-final position is reported as `SGL3004` whether or not its prefix resolves: `nope.**.b` is `SGL3004`, not `SGL2001`.
- **Partial matches are skipped silently.** A node matched by a parent segment that has no child matching the next segment, or has no children at all, contributes nothing and gets no diagnostic: `store*.api` over a `store3` without an `api` simply leaves `store3` out. `SGL3003` is only for an endpoint whose **whole** expansion is empty (below).
- **Expansion order** is depth-first, in child declaration order at each level: every match under the first matched parent, in order, before any under the second. `store*.api*` over `store1 { api, apiV2 }` and `store2 { api-edge }` gives `store1.api`, `store1.apiV2`, `store2.api-edge`.

The scoping rules above apply unchanged: the literal part of the path before the first wildcard resolves relative to the enclosing container, so `../lane1.*`, `/platform.cam*` and `../*.handler` mean what they look like, and a prefix that does not resolve is the ordinary `SGL2001`.

**Name globs.** A segment may carry **one** star, anywhere in it. `cam*` is prefix matching, `*-db` is suffix matching, `cam*hd` is both ends at once; a bare `*` is the degenerate case where both ends are empty, which is why "all children" and "children starting with `cam`" are the same feature and not two.

Three limits, each of them the thing that keeps this a shorthand rather than a query language. They apply to every segment, not only the last:

- **One star per segment.** `a*b*c` is a syntax error. Two stars is a pattern language; one is a naming convention.
- **A glob never crosses a level.** `cam**` is a syntax error — `**` means descendants and takes no glob. A glob matches direct children only, in whichever segment it sits.
- **Matching is on the key, not the label.** `lane1.cam*` matches the child written `cam3: { @label: "Front door" }`; it does not match `door1: { @label: "Camera" }`. Keys are identity (§2); labels are presentation, and are free to change without silently rewiring the diagram.

Matching is case-sensitive, like every other path reference, at every level. A quoted key is matched on its decoded text, so `lane1.order*` matches `"order service"`.

**Not supported, deliberately:** `?` single-character matching, character classes, and alternation. Each of them is a step toward §7 with none of §7's scoping. Ask for a selector if you need one.

**Expansion.** The wildcard is expanded into ordinary edges before anything else happens to them, in the expansion order above (depth-first, child declaration order at each level). Each expanded edge is a normal edge in every respect — it gets the same identity, the same label, and the same `@`-configuration it would have had if written out by hand:

```sgl
lane1.* -> switch: { @label: "joins", @style: dashed }
```

gives every expanded edge that label and that style. There is no way to tell, downstream of compilation, that an edge came from a wildcard — which is the point. Adding a child to `lane1` adds one edge and leaves the identity of the others untouched, so diffs and version history stay meaningful.

**Both sides.** `lane1.* -> lane2.*` is a **cross product**, not a pairwise zip: every child of `lane1` to every child of `lane2`. A zip would depend on declaration order and would silently drop the tail of the longer side. Pairs where both sides resolve to the same node are omitted, so `lane1.* -> lane1.*` does not produce a self-loop on every child. The same holds with wildcards in parent segments: `g*.* -> g*.*` is every child of every `g*` to every other one.

**Ports** attach to the expansion, not to the wildcard: `lane1.*[out] -> switch` uses each matched node's `out` port, and any matched node without one gets the usual `SGL2003` and attaches to its boundary.

**Empty matches are a warning, not an error.** An endpoint whose whole expansion is empty — a wildcard over an empty container or a leaf node, a glob no key satisfies, or parent segments none of whose matches has a matching child — emits `SGL3003` and skips that edge; the rest of the document is unaffected. A wildcard whose literal *path prefix* (everything before its first wildcard) does not resolve is the ordinary `SGL2001`. A glob that matches nothing is the case worth having a warning for at all: it is what a typo looks like.

**Hidden nodes** (`@hidden`) are not matched, at any level, so a hidden parent's children are not reached either.

**There is a ceiling.** One statement may expand to at most 1 000 edges; over that it is skipped with `SGL3005`. A cross product is quadratic, and a document may legitimately hold 2 000 nodes.

---

## 4. Configuration keys

`@` keys are namespaced by dot. Unknown namespaces are preserved and passed through to plugins; unknown keys *within* a known namespace are a warning.

| Key | Applies to | Notes |
|---|---|---|
| `@label` | node, edge, container | Text or inline-markup string |
| `@type` | node, edge | Class reference; may be a list |
| `@shape` | node | `rect` `round` `circle` `ellipse` `diamond` `hexagon` `cylinder` `cloud` `document` `actor` `package` `note`, or a theme-defined shape |
| `@icon` | node | Icon reference (see backlog) |
| `@tooltip`, `@link` | node, edge | `@link` restricted to `https:` and `mailto:`; anything else, including in-document `#path`, is dropped with `SGL6001` (DD-07 §8) |
| `@style.*` | any | Paint overrides: `fill`, `stroke`, `strokeWidth`, `strokeDash`, `opacity`, `font*`, `radius`, `shadow` |
| `@layout.*` | any | Engine hints. `@layout.engine`, plus free-form engine-specific keys |
| `@size.*` | node | `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `aspectRatio` (any other key: `SGL2010`, and no effect) |
| `@pin` | node | `{ x, y }` — absolute position auto-layout must respect |
| `@ports` | node | Named anchors |
| `@direction` | container | Sugar for `@layout.direction`: `down` `up` `left` `right` |
| `@order` | node, edge | Sort hint within a container. **On edges it fixes message order** — required by sequence-style layout engines (I3), where declaration order alone is too fragile |
| `@hidden` | any | Excluded from render but kept in the model |
| `@a11y.*` | any | `label`, `description`, `role` for the accessibility tree |
| `@meta.*` | any | Arbitrary user data; never rendered, always round-tripped |

"Applies to" names *element* scopes: node, edge, container, class. `any` means
all four — it does not include the document root. Document-level keys are
listed separately below; a key is valid at the document root only if it
appears there. `@direction`'s "container" already covers root under §2's
definition (root is a container: a node with children) — root's own
`@layout` block, shown below, is exactly where the sugar it desugars to
applies.

### Document-level keys (root only)

```sgl
@sgl: "1.0"                 // language version — required in canonical form
@title: "Payments Platform"
@theme: "slate-dark"        // or an inline theme object, or a path
@layout: {
  engine: "layered"
  direction: down
  spacing: { node: 40, rank: 70 }
}
@classes: { ... }           // §6
@vars: { ... }              // §5
@imports: [ ... ]           // §8
```

---

## 5. Variables

```sgl
@vars: {
  brand: "#4F46E5"
  tier:  "production"
}

api: {
  @style.stroke: $brand
  @label: "API (${tier})"
}
```

`$name` for a whole-value substitution (preserves type), `${name}` for interpolation inside a string. Variables are lexically scoped — a container may declare its own `@vars` that shadow the parent's. No expressions, no conditionals, no loops: SGL is a data language, not a template engine. Generate complexity upstream and emit `.sgl.json`.

The rules in full (settled with A8 and its first fix round):

- **Where a variable may appear.** Only where the grammar's `Value` appears: configuration values at any depth (`@style.stroke: $brand`, `@meta: { tags: $tags }`), class bodies, `@type` and `@extends` (checked against `@classes` after substitution), and labels, including interpolation in the `a: "…"` and `a -> b: "…"` shorthands. **Never in a key, a path or a node name**: identity is keys (§2), so a variable cannot change what a node *is*. `$a: {}` and `a -> $b` are syntax errors; a quoted key or path segment such as `"$a"` is the literal name `$a`.
- **Not a node value.** The node shorthand `b: $c` is **not** supported: a node's value is a block, a label string or a class name, never a `Value`, so `$c` there is `SGL1002` ("unexpected `$c`"). Write `b: { @label: $c }` or `b: "${c}"`. The parser's recovery then reads on: after the skipped `$c` it takes the next line's key as `b`'s class name, so in `b: $c` followed by `d: "D"` you also get `SGL2002` (unknown class `d`), the `:` skipped, and a node named `D`. Fix the first error and the rest go away.
- **Names.** A variable name is an ASCII identifier, exactly the grammar's `Identifier`: a letter or `_`, then letters, digits and `_`, with single `-` allowed between them (`brand`, `brand_2`, `brand-dark`). Only such a name can follow `$`, so declaring any other name (`"é"`, `"1"`) is `SGL2011`. (Keeping names to identifiers also keeps a block's declaration order intact through canonical JSON, where an object would move integer-like keys first.)
- **Imported variables** (§8). An import with `as: ns` brings its root variables as `$ns.name` (and `${ns.name}` in a string); qualifiers compose (`$b.c.x`). `$ns.name` written as a token is always a reference, and unknown if there is no such namespace. A *string* that is exactly `"$ns.name"` or holds `${ns.name}` is a reference **only when `ns` is one of this document's import namespaces**; otherwise it is literal text, so an existing label such as `"$user.name"` keeps meaning what it says. An import without `as` brings its variables unqualified, in a scope around the root's own: your `@vars` shadow them silently, and a later import shadows an earlier one.
- **Whole value.** `$name` takes the variable's value with its type: a string, number, bool, null, object or array. A string whose entire text is `$name` is the same reference: that is how canonical JSON (§9) and any `.sgl.json` write one. Every use gets its own copy.
- **Interpolation.** `${name}` inside a string is replaced by the value's text: a string as itself, a bool as `true`/`false`, a number as JavaScript's `String(n)` exactly — `2.5`, `-0.5`, and exponent forms where `String` uses them: `0.0000001` interpolates as `1e-7`, `1000000000000000000000` as `1e+21`. An object, array or null has no text: that is an error (`SGL2015`) and the value is dropped, the same as for an unknown name. A placeholder that is not `${identifier}` — `${ tier }`, `${1}` — is literal text with no diagnostic, deliberately: there is no `$` escape, so this is how literal `${…}` stays writable. Any other `$` is literal too: `"costs $5"`.
- **No escape.** There is no way to write a literal `${name}`, or a string that is exactly `$name`, as text. The grammar has no escape for `$` (`\$` is an unknown escape, `SGL1004`, kept as written), and adding one is a grammar decision still open.
- **Scope.** A container's `@vars` apply to everything inside it — its own configuration, its edges and its children — wherever in the container they are written. A child's `@vars` shadow its parent's. Class bodies are declared at the root and see the root's `@vars`. A `@vars` value is resolved in the scope that declares it, not where it is used: with `@vars: { a: 1, b: $a }` at the root, a child that declares its own `a: 2` still gets `1` from `$b`. `@vars` is not valid on a class or an edge (`SGL2012`); `@vars` whose value is not an object, `@vars: $o` included, is `SGL2011`.
- **Redeclaration.** `@vars` follows the redeclaration rule for all configuration (§2, DD-02 §3.2): a container declared twice has one merged `@vars`, later wins, merged key by key, and it applies to every declaration of the container. In `a: { @vars: { x: 1, y: $x } }` then `a: { @vars: { x: 2 }, @order: $y }`, `x` is `2`, so `$y` and `@order` are `2`.
- **Order within a block.** A `@vars` entry may use the enclosing containers' variables and the entries declared *before* it in the same block. For a merged block, "before" means earlier in order of first appearance across the declarations: `a: { @vars: { y: 1 } }` then `a: { @vars: { x: $y } }` is fine, the other way round is `SGL2014`. Using an entry declared at or after it in the same block — itself, a later entry, and so any self or mutual reference — is an error (`SGL2014`) even if an enclosing container has the name: the block's own declaration shadows it for the whole block. In `a: $b, b: $a` the error is at `a`; `b` then uses the failed `a` and is dropped with it.
- **Unknown names.** A reference to a name no enclosing `@vars` declares is an error (`SGL2013`), and the value that holds it is dropped: the key, array item or object property is treated as absent — only that value, so in `@meta: { o: { p: $nope }, q: 1 }` the result is `{ o: {}, q: 1 }`. The same happens, silently, to a use of a variable whose own declaration failed (it already carries the error). A string with an unknown `${name}` is dropped whole.
- **When values are computed.** Names are checked where a `@vars` block is declared (`SGL2013`, `SGL2014`); a variable's value is computed the first time it is used, once, so a variable nobody uses costs nothing and value errors (`SGL2015`, `SGL2016`) are reported at first use.
- **Expansion budget.** Substitution may produce at most 2 Mi (2 097 152) units per document — for a document with `@imports`, per document *together with everything it imports*: the whole import closure shares one budget (§8), where a unit is one value copied in by `$name` (a scalar, array or object, each of its elements counted too) or one character produced by `${name}`: as much as a document at the 2 MB cap (DD-09 §1.1) could spell out itself. Past it, `v1: [$v0, $v0]`, `v2: [$v1, $v1]`, … ("billion laughs") stops: the use that would cross the budget is one `SGL2016` error for the document and its value is dropped, as is every later use that does not fit.
- **Canonical form.** `.sgl.json` keeps `@vars` and every reference as written (`"$brand"`, `"API (${tier})"`), so a round trip preserves the authoring. Merging a redeclaration or a dotted key works on that written form, before substitution: `@style: $s` followed by `@style.fill: red` replaces `$s` (`SGL2006`), exactly as it would replace a string.

---

## 6. Classes

```sgl
@classes: {
  Service: {
    @shape: round
    @style: { fill: "@surface.raised", stroke: "@accent" }
  }
  Datastore: {
    @shape: cylinder
    @style.fill: "@surface.sunken"
  }
  Critical: {
    @style: { stroke: "@danger", strokeWidth: 3 }
  }
}

api:   Service                      // single class
db:    { @type: [Datastore, Critical] }   // multiple, later wins
cache: { @type: Datastore, @style.fill: "#eee" }  // inline beats class
```

Classes may extend other classes (`@extends`). Class application order is the declaration order in `@type`.

### Cascade (lowest to highest precedence)

1. Theme role defaults for the resolved `@shape`
2. Theme rules matching the node's classes
3. `@classes` definitions, in `@type` order
4. Selector rules (§7), in declaration order
5. Inline `@style` / `@size` on the element itself
6. **Theme force** — a theme may *force* paint properties (fill, stroke, text colour, plate, shadow) over everything above, including inline `@style`. Only the built-in `print` theme uses it (every fill white, every stroke and text black, no shadow). Force never touches geometry: a forced geometry key is ignored with a warning. (Human decision, 2026-09-25; DD-04 §4 step 7.)

`@token` references (`"@accent"`, `"@surface.raised"`) resolve against the active theme, so a class written once works in light, dark, and print.

---

## 7. Selectors (Could — see backlog)

```sgl
@rules: {
  "**.@type(Datastore)": { @style.strokeDash: "4 2" }
  "platform.*":          { @layout.rank: same }
}
```

Glob over paths plus a small predicate set. Deliberately last on the list: powerful, and easy to make debugging miserable.

**Not the same feature as wildcard edge endpoints (§3),** despite sharing the `*` and `**` spelling. The difference is what they are allowed to do:

| | Wildcard endpoint (§3) | Selector rule (§7) |
|---|---|---|
| Where it may appear | an edge endpoint only | anywhere, any depth |
| Pattern vocabulary | a one-star glob in any segment, direct children per segment; `**` final only | globs, `**` anywhere, predicates |
| What it produces | a fixed set of ordinary edges, expanded once at compile | a cascade layer, consulted per element |
| Failure mode | a warning on an empty match | a rule that quietly stops matching after an unrelated edit |

The first is a shorthand for typing out edges you could have written by hand. The second is a query over the document. Since the human decision of 2026-09-24, `lane1.*.handler` and `store*.api*` are shorthand too: each segment still walks exactly one level, so the expansion is a set you could enumerate by reading the tree one level at a time, and it expands once to ordinary edges. The line between the two features now lies at three things §3 still refuses: `**` anywhere but last (`platform.**.api` is a search at unbounded depth), predicates (`@type(...)` and anything else that reads more than a key), and any position other than an edge endpoint. The moment one of those works, `@rules` has arrived in the edge syntax through the back door.

---

## 8. Imports

```sgl
@imports: [
  "./shared/classes.sgl",
  { path: "./aws-icons.sgl", as: aws }
]

lambda: aws.Lambda
```

`@imports` is a root key: an array whose items are each a path string or `{ path: "…", as: name }` (`as` a bareword identifier; a string in `.sgl.json`). Anything else is `SGL2011` and that item is ignored; `@imports` below the root is `SGL2012`. Variables are not substituted in it: `"$x"` is the literal path `$x`.

**What a path finds.** Paths are relative only: an empty path, one starting with `/`, `\` or `//`, or one with a scheme or drive (`https:`, `file:`, `C:`) is `SGL2025` and skipped; nothing is ever fetched. Which document a relative path names is the host's decision. In the SGL app it is one of **your stored documents** (Documents ▾): only the path's last segment counts, one openable extension is stripped (`.sgl.json`, `.sgl`, `.json`, `.txt`), and case is ignored, so `./shared/classes.sgl` asks for `classes`. A document answers to the name of the file Open read it from, and to the name Save would give it (its title). If a name finds nothing, `SGL2017`; if it finds several, `SGL2018`, and the most recently updated is used. Documents that arrived together in one share link find one another first, and are invisible to your other documents.

**What an import brings.**

- **Without `as`:** its `@classes` and its root `@vars`, unqualified. Its nodes, edges and root configuration are not imported (`SGL2026`, info, if it has nodes or edges).
- **With `as: ns`:** its classes as `ns.Name` (their `@extends` rewritten to match), its root variables as `$ns.name`, and, if it has nodes or edges, a container `ns` at the root, first among the root's children, holding them; the container is labelled with the import's `@title`, or `ns`. Its other root configuration is dropped. An absolute path inside it (`/x.y`) means `/ns/x/y`, and a `../` that would climb out of it is an unresolved edge: an import only ever reaches itself.
- **Transitively:** an import's own imports come with it, and qualifiers compose (`b.c.X`, `$b.c.x`, nodes under `b.c`). Each document means the same wherever it is imported from: it never sees its importer's variables or classes.

**Precedence.** Your own definitions win, then later imports, then earlier ones. A class you declare replaces an unqualified imported one of the same name whole (`SGL2023`, info), as does a later import's; an unqualified imported class's `@extends` is looked up in that final table (a cycle this creates is `SGL2004`). To extend instead, import with `as` and write `Service: { @extends: lib.Service, … }`. Two imports with the same `as`, or an `as` equal to one of your root node keys when the import has nodes, is `SGL2022`: the second is skipped, or its subtree is not grafted.

**Failures are warnings.** A document with a failed import still renders: every way an import can fail, and everything the failure causes, is a warning, never an error. A class, variable or edge endpoint through a namespace whose import failed is `SGL2024` and dropped; so is an unknown bare name when an unqualified import failed. An import's own problems are one `SGL2021` on its `@imports` item, with the count and the first.

**Limits**, per document with everything it imports: 8 levels deep, 64 imported documents (a document imported twice counts twice), 2 Mi characters of imported source, and one shared variable-expansion budget (§5). The import that would cross a limit is skipped with `SGL2020`. A cycle (`a` imports `b` imports `a`, or a document importing itself) is `SGL2019`, naming the chain, and the import that closes it is skipped.

**Canonical form.** `.sgl.json` keeps `@imports` exactly as written and leaves out everything imported, so it needs its imports just as the `.sgl` does. A share link carries the imported documents with it (the SGL app's Share); saving a file does not (a bundle format is a later item, F5).

---

## 9. Worked example

```sgl
@sgl: "1.0"
@title: "Checkout Flow"
@theme: "neutral-light"
@layout: { engine: "layered", direction: right }

@vars: { hot: "#DC2626" }

@classes: {
  Service:   { @shape: round }
  Store:     { @shape: cylinder }
  External:  { @shape: cloud, @style.strokeDash: "3 3" }
}

edge: { @label: "CDN", @type: External }

storefront: {
  @label: "Storefront"

  web:  Service
  bff:  { @type: Service, @label: "BFF" }

  web -> bff: "GraphQL"
}

payments: {
  @label: "Payments"
  @layout: { engine: grid, columns: 2 }

  api:     { @type: Service, @style.stroke: $hot }
  ledger:  Store
  outbox:  Store

  api -> ledger
  api -> outbox: { @label: "async", @style: dashed }
}

psp: { @label: "Stripe", @type: External }

edge -> storefront.web
storefront.bff -> payments.api: "POST /charge"
payments.api -> psp: "authorise"
```

### The same document, canonical

```json
{
  "@sgl": "1.0",
  "@title": "Checkout Flow",
  "@theme": "neutral-light",
  "@layout": { "engine": "layered", "direction": "right" },
  "@vars": { "hot": "#DC2626" },
  "@classes": {
    "Service": { "@shape": "round" },
    "Store":   { "@shape": "cylinder" },
    "External":{ "@shape": "cloud", "@style": { "strokeDash": "3 3" } }
  },
  "edge": { "@label": "CDN", "@type": ["External"] },
  "storefront": {
    "@label": "Storefront",
    "web": { "@type": ["Service"] },
    "bff": { "@type": ["Service"], "@label": "BFF" },
    "@edges": [
      { "from": "web", "to": "bff", "directed": "forward", "@label": "GraphQL" }
    ]
  },
  "payments": {
    "@label": "Payments",
    "@layout": { "engine": "grid", "columns": 2 },
    "api":    { "@type": ["Service"], "@style": { "stroke": "$hot" } },
    "ledger": { "@type": ["Store"] },
    "outbox": { "@type": ["Store"] },
    "@edges": [
      { "from": "api", "to": "ledger", "directed": "forward" },
      { "from": "api", "to": "outbox", "directed": "forward",
        "@label": "async", "@style": { "strokeDash": "4 3" } }
    ]
  },
  "psp": { "@label": "Stripe", "@type": ["External"] },
  "@edges": [
    { "from": "edge", "to": "storefront.web", "directed": "forward" },
    { "from": "storefront.bff", "to": "payments.api", "directed": "forward", "@label": "POST /charge" },
    { "from": "payments.api", "to": "psp", "directed": "forward", "@label": "authorise" }
  ]
}
```

Note what canonicalisation does: infix edges become `@edges` arrays on their declaring container, shorthands expand, `@type` normalises to an array. Everything else is untouched, variable references included (§5): `"stroke": "$hot"` is what the author wrote.

---

## 10. Diagnostics

Errors are values, not exceptions. The parser always returns `{ document, diagnostics }`.

```ts
interface Diagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  code: string;              // 'SGL1004' — stable, documented, searchable
  message: string;
  span: SourceSpan;          // file, offset, line, col, length
  related?: { span: SourceSpan; message: string }[];
  fix?: TextEdit[];          // quick-fix for the editor
}
```

Code ranges: `SGL1xxx` lexical/syntax, `SGL2xxx` resolution (unknown path, unknown class), `SGL3xxx` semantic (cycle, duplicate), `SGL4xxx` layout, `SGL5xxx` theme, `SGL6xxx` plugin.

The rule from FR-E4 falls out of this: a document with errors still produces the best partial model it can, so the canvas keeps showing something.

---

## 11. Deliberately excluded from v1

| Excluded | Reason |
|---|---|
| Expressions, conditionals, loops | Turns a data format into a programming language; generate upstream instead |
| Raw HTML in labels | XSS surface, breaks non-browser renderers, breaks measurement determinism |
| Remote imports (any URL) | Supply-chain and privacy risk; v1 imports are relative only (§8) |
| Implicit node creation from edges (`a -> b` creating `a`) | Typos silently become nodes. **Open question — Mermaid and D2 both allow it and users like it.** Flagged in the backlog. |
