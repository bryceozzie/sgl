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
```

| Form | Matches |
|---|---|
| `path.*` | every **direct child** of `path` |
| `path.**` | every **descendant** of `path`, at any depth, containers included |
| `path.cam*` | every direct child whose key **starts with** `cam` |
| `path.*-db` | every direct child whose key **ends with** `-db` |
| `path.cam*hd` | every direct child whose key starts with `cam` **and** ends with `hd` |

A wildcard is **only valid in an edge endpoint**, and **only as the last part of a path**. `lane1.*.handler` is an error (`SGL3004`), not a search — matching "the handler of every lane" is a selector, and selectors are §7.

The scoping rules above apply unchanged: the part of the path before the wildcard resolves relative to the enclosing container, so `../lane1.*` and `/platform.cam*` mean what they look like.

**Name globs.** A segment may carry **one** star, anywhere in it. `cam*` is prefix matching, `*-db` is suffix matching, `cam*hd` is both ends at once; a bare `*` is the degenerate case where both ends are empty, which is why "all children" and "children starting with `cam`" are the same feature and not two.

Three limits, each of them the thing that keeps this a shorthand rather than a query language:

- **One star per segment.** `a*b*c` is a syntax error. Two stars is a pattern language; one is a naming convention.
- **A glob never crosses a level.** `cam**` is a syntax error — `**` means descendants and takes no glob. A glob matches direct children only.
- **Matching is on the key, not the label.** `lane1.cam*` matches the child written `cam3: { @label: "Front door" }`; it does not match `door1: { @label: "Camera" }`. Keys are identity (§2); labels are presentation, and are free to change without silently rewiring the diagram.

Matching is case-sensitive, like every other path reference. A quoted key is matched on its decoded text, so `lane1.order*` matches `"order service"`.

**Not supported, deliberately:** `?` single-character matching, character classes, and alternation. Each of them is a step toward §7 with none of §7's scoping. Ask for a selector if you need one.

**Expansion.** The wildcard is expanded into ordinary edges before anything else happens to them, in child declaration order. Each expanded edge is a normal edge in every respect — it gets the same identity, the same label, and the same `@`-configuration it would have had if written out by hand:

```sgl
lane1.* -> switch: { @label: "joins", @style: dashed }
```

gives every expanded edge that label and that style. There is no way to tell, downstream of compilation, that an edge came from a wildcard — which is the point. Adding a child to `lane1` adds one edge and leaves the identity of the others untouched, so diffs and version history stay meaningful.

**Both sides.** `lane1.* -> lane2.*` is a **cross product**, not a pairwise zip: every child of `lane1` to every child of `lane2`. A zip would depend on declaration order and would silently drop the tail of the longer side. Pairs where both sides resolve to the same node are omitted, so `lane1.* -> lane1.*` does not produce a self-loop on every child.

**Ports** attach to the expansion, not to the wildcard: `lane1.*[out] -> switch` uses each matched node's `out` port, and any matched node without one gets the usual `SGL2003` and attaches to its boundary.

**Empty matches are a warning, not an error.** A wildcard matching nothing — an empty container, a leaf node, or a glob no key satisfies — emits `SGL3003` and skips that edge; the rest of the document is unaffected. A wildcard whose *path prefix* does not resolve is the ordinary `SGL2001`. A glob that matches nothing is the case worth having a warning for at all: it is what a typo looks like.

**Hidden nodes** (`@hidden`) are not matched.

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
| `@tooltip`, `@link` | node, edge | `@link` restricted to `https:`, `mailto:`, and in-document `#path` |
| `@style.*` | any | Paint overrides: `fill`, `stroke`, `strokeWidth`, `strokeDash`, `opacity`, `font*`, `radius`, `shadow` |
| `@layout.*` | any | Engine hints. `@layout.engine`, plus free-form engine-specific keys |
| `@size.*` | node | `width`, `height`, `minWidth`, `maxWidth`, `aspectRatio` |
| `@pin` | node | `{ x, y }` — absolute position auto-layout must respect |
| `@ports` | node | Named anchors |
| `@direction` | container | Sugar for `@layout.direction`: `down` `up` `left` `right` |
| `@order` | node, edge | Sort hint within a container. **On edges it fixes message order** — required by sequence-style layout engines (I3), where declaration order alone is too fragile |
| `@hidden` | any | Excluded from render but kept in the model |
| `@a11y.*` | any | `label`, `description`, `role` for the accessibility tree |
| `@meta.*` | any | Arbitrary user data; never rendered, always round-tripped |

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
| Where it may appear | an edge endpoint, final path part only | anywhere, any depth |
| Pattern vocabulary | one `*` in the final segment | globs, `**`, predicates |
| What it produces | a fixed set of ordinary edges, decided once at compile | a cascade layer, consulted per element |
| Failure mode | a warning on an empty match | a rule that quietly stops matching after an unrelated edit |

The first is a shorthand for typing out edges you could have written by hand. The second is a query over the document. Keeping them apart is why §3 forbids a wildcard in a non-final position: the moment `lane1.*.handler` works, `@rules` has arrived in the edge syntax through the back door.

---

## 8. Imports

```sgl
@imports: [
  "./shared/classes.sgl",
  { path: "./aws-icons.sgl", as: aws }
]

lambda: aws.Lambda
```

Rules: relative paths only by default; no remote URLs unless the host explicitly allows them; cycles are detected and reported; imported documents contribute `@classes`, `@vars`, and (namespaced) subtrees, never anonymous root nodes.

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

Note what canonicalisation does: infix edges become `@edges` arrays on their declaring container, shorthands expand, `@type` normalises to an array. Everything else is untouched.

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
| Arbitrary remote imports | Supply-chain and privacy risk; opt-in only |
| Implicit node creation from edges (`a -> b` creating `a`) | Typos silently become nodes. **Open question — Mermaid and D2 both allow it and users like it.** Flagged in the backlog. |
