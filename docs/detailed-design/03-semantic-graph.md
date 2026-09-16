# DD-03 — Semantic Graph (IR)

**Package:** `@sgl/core` · **Input:** `DocumentModel` (DD-02) · **Output:** `CompileResult { graph: SemanticGraph; diagnostics }`

The IR is the contract every downstream package consumes: theme, measurement, layout, renderer. It is theme-independent and layout-independent. It is frozen, plain JSON, and crosses the worker boundary by `structuredClone`.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Flatten the tree into an indexed node map with stable IDs | Know about pixels, fonts or colours |
| Resolve every edge endpoint to a `NodeId` (+ port) | Apply the theme cascade (DD-04 does, producing `StyledGraph`) |
| Linearise each node's class list | Measure anything |
| Produce `LabelSpec`s with stable `LabelId`s | Decide what a layout hint means |
| Produce a deterministic traversal `order` | **⟶ v1.x (I1):** take a *view selector* — the signature reserves the parameter now |
| Drop unresolvable edges with diagnostics, keeping the rest | |

---

## 2. Types

```ts
interface SemanticGraph {
  readonly nodes: Readonly<Record<NodeId, GraphNode>>;
  readonly edges: readonly GraphEdge[];              // in stable order (§5)
  readonly rootChildren: readonly NodeId[];          // top-level nodes, declaration order
  readonly order: readonly NodeId[];                 // pre-order traversal, declaration order
  readonly labels: Readonly<Record<LabelId, LabelSpec>>;
  readonly title?: string;                           // @title
  readonly meta: { readonly nodeCount: number; readonly edgeCount: number; readonly containerCount: number };
}

interface GraphNode {
  readonly id: NodeId;                               // 'payments.api'   (§2.1)
  readonly path: readonly string[];                  // ['payments','api']
  readonly parent: NodeId | null;
  readonly children: readonly NodeId[];              // declaration order; [] for leaves
  readonly depth: number;
  readonly shape: ShapeId;                           // resolved from inline > class > default 'rect'
  readonly classes: readonly string[];               // linearised, low → high precedence
  readonly labelId: LabelId | null;                  // null when @label is '' or @hidden
  readonly ports: readonly PortSpec[];
  readonly config: ConfigBag;                        // the merged @-bag from DD-02 (inline only)
  readonly hidden: boolean;
  readonly span: SourceSpan;
}

interface GraphEdge {
  readonly id: EdgeId;                               // 'e-3f9a…'      (§5)
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly directed: 'forward' | 'both' | 'none';
  readonly classes: readonly string[];
  readonly labelId: LabelId | null;
  readonly config: ConfigBag;
  readonly declaredIn: NodeId | null;                // the container whose block declared it; null = root
  readonly hidden: boolean;                          // effectively hidden (§6) — own @hidden, or either endpoint's node
  readonly span: SourceSpan;
}

interface Endpoint { readonly node: NodeId; readonly port?: PortId }

interface PortSpec { readonly id: PortId; readonly side: 'north' | 'south' | 'east' | 'west' }

interface LabelSpec {
  readonly id: LabelId;                              // 'l:payments.api' | 'l:e-3f9a…'
  readonly owner: { kind: 'node'; id: NodeId } | { kind: 'edge'; id: EdgeId };
  readonly role: 'title' | 'edge';                   // 'title' covers node and container titles
  readonly runs: readonly TextRun[];                 // MVP: one plain run per line  ⟶ v1.0 (A18) rich runs
}
interface TextRun { readonly text: string; readonly style?: 'code' | 'strong' | 'em' }   // style unused in MVP
```

`GraphEdge` was listed Frozen through Stage C's brief without a `hidden` field, even though the language spec (§4) puts `@hidden` at `any` scope and the config registry accepts it at edge scope — so `a -> b: { @hidden: true }` validated cleanly and did nothing. Corrected here, in the same change as the code that reads it (`compile.ts`), because nothing outside `@sgl/core` consumed `GraphEdge` yet: this was the cheapest point in the project to fix a frozen type that was simply wrong.

### 2.1 Node IDs

`NodeId` is the path segments joined by `.`, with any `.` or `\` inside a segment escaped as `\.` / `\\`. Root is never a node. IDs are the authoritative identity for edges, layout results, SVG element IDs (DD-07 §6) and source mapping. Reordering unrelated declarations does not change an ID; renaming a container changes the IDs of everything under it, which is correct.

Build it with `nodeIdFromPath` (`packages/core/src/ids.ts`), not a new implementation of this rule: the resolver's own span-table keys (DD-02 §2) already use it, and the two independently escaping the same rule is exactly how they drifted once — `resolve()` originally escaped only `.`.

---

## 3. Algorithm: endpoint resolution

For an `EdgeModel` declared in container `C` (path `cp`) with endpoint `PathExpr { root, parents, segments }`:

```
base   = root ? [] : cp
base   = base[0 .. len(base) - parents]          // SGL2001 if parents > len(base)
target = base ++ segments
```

`target` must name an existing node → `SGL2001` otherwise. The offending edge is **dropped**; every other edge and every node survives. This is the partial-model guarantee at the compile stage.

Resolution is exact, not fuzzy: no implicit node creation (**A11 is Could**; if it is ever enabled it is a resolver rewrite that inserts declarations, not a compile-time special case).

An endpoint may name a container. The edge attaches to the container's boundary; the layout engine decides where (DD-06).

**Ports.** `fromPort`/`toPort` must appear in the target node's *merged* `@ports` — its own inline value cascaded with its classes' (§4) — → `SGL2003` warning and the port is dropped (the edge keeps its node). Port `side` comes from that merged value.

**Self-loops** (`a -> a`) are valid and kept; routing them is the engine's or the host fallback's job (DD-06 §4).

---

### 3.1 Wildcard expansion

An endpoint whose `PathExpr` ends in a `WildcardStep` stands for a set of nodes. Expansion runs **before** endpoint resolution proper and before any ID is allocated, so that every edge it produces is indistinguishable from one written out by hand.

```
expand(endpoint, C):
  if no WildcardStep in segments        -> [endpoint]
  if WildcardStep is not the last step  -> SGL3004, []          // lane1.*.handler
  prefix = resolve(segments[0 .. -1], C)                        // ordinary resolution
  if prefix is unresolved               -> SGL2001, []          // the existing rule
  candidates = depth == 'children'    ? prefix.children
             : depth == 'descendants' ? preorder(prefix) minus prefix
  matches = candidates filter (not hidden) filter (matchesGlob step)
  if matches is empty                   -> SGL3003, []
  return matches                                                 // in declaration order
```

`preorder` is the same walk as §7, so `**` yields descendants in document order, containers included. A container matched by `**` is an ordinary endpoint: the edge attaches to its boundary, and its children are *also* matched. That is the literal reading of "every descendant", and the alternative — leaves only — would make `lane1.**` mean something different depending on whether a lane happened to have been subdivided.

**The glob filter** is `core/ast.ts: matchesWildcard`, and it is three comparisons:

```
key.length >= prefix.length + suffix.length
  && key.startsWith(prefix)
  && key.endsWith(suffix)
```

The length guard is not redundant. Without it `ca*am` would match `cam`, because the same three characters would satisfy both ends at once — a key can be matched by a pattern longer than itself. A bare `*` and `**` carry empty `prefix` and `suffix`, so they pass unconditionally and the filter needs no special case for them.

It matches the **key**, which is the node's last path segment, not its full path and not its label. Keys are identity (§2.1); a label is presentation and may change freely without silently rewiring the diagram. A quoted key is matched on its decoded text, so `lane1.order*` matches `"order service"`.

There is no regex and no compiled pattern, because the token shape (DD-01 §2) admits at most one star. `?`, character classes and alternation are deliberately absent — each is a step toward §7's selectors with none of §7's scoping.

**`depth` is always `'children'` when a glob is present.** The grammar cannot produce `cam**`, so this is a guaranteed invariant rather than a check: a glob never crosses a level.

**Both endpoints wildcarded** is a cross product, taken in `(from, to)` order:

```
for f in expand(from, C):
  for t in expand(to, C):
    if f.node == t.node: continue        // no self-loop from a cross product
    emit edge(f, t)
```

A zip was considered and rejected: it depends on declaration order on both sides and silently drops the tail of the longer one, which is a data-loss bug that looks like a layout bug.

**Open (07 §2.1 F4): the exclusion above is written for the both-wildcarded case only**, so a *one-sided* wildcard whose expansion happens to contain the other endpoint keeps the self-pair — `x -> /**` expands `/**` over every node in the document, `x` among them, and emits `x -> x`. `compile()` implements exactly what is written here, on the reasoning that an ordinary endpoint coinciding with a member of the other side's expansion is a legitimate edge rather than a cross-product artefact. Nothing in `corpus/` covers it either way. Stage F is the first stage that can see the rendered result and owns the decision; until then, treat this paragraph as describing behaviour, not as settled intent.

If the product exceeds `MAX_EDGE_EXPANSION` (1 000), the whole statement is skipped with `SGL3005` and every other edge in the document survives. The ceiling is a hard stop rather than a suggestion because the product is quadratic in a node count already allowed to reach 2 000 (DD-09 §2).

**Ports** ride along: `fromPort`/`toPort` are copied onto every expanded edge, and the existing per-node `SGL2003` fires for each matched node that lacks the port — once per *distinct* node, not once per edge it appears in. So `lane1.*[out] -> switch` across four children, one of which has no `out` port, gives four edges and one warning; and with both sides wildcarded, `lane1.*[out] -> lane2.*[in]` over 3 `lane1` children (all with `out`) and 2 `lane2` children (neither with `in`) gives six edges and **two** warnings, one per portless node in `lane2` — not six, which is what falls out if a side is (re-)validated inside the cross-product loop instead of once per target before it.

**Configuration** — the edge's label and `@`-bag — is copied onto every expanded edge, exactly as a chain's label is (DD-02 §5).

**Chains expand per link.** `a.* -> b -> c.*` is two `EdgeModel`s; each expands independently against its own endpoints.

**Determinism.** The only ordering input is `ContainerModel.children`, which is declaration order, and the iteration is a plain nested loop over it. No sorting, no set iteration (DD-00 §3).

---

## 4. Classes and shape

Per node, `classes` = linearised `@type` (DD-02 §4). `shape` = inline `config.shape` if present, else the first class in **reverse** linearised order that defines `shape`, else `'rect'`. The language spec (§4) names twelve shapes; DD-07 §4 draws seven of them. A resolved name outside all twelve → `SGL3001` ("unknown shape") and `'rect'`; one of the twelve but not one of the seven → `SGL3006` ("not drawn in this version") and `'rect'`, at `info` severity since it names a real, spec-legal choice the renderer just doesn't have yet. Either way the result is total: **`GraphNode.shape` is always a shape DD-07 §4 can draw** — everything downstream of Stage C (Stage F's renderer among it) may assume this without its own fallback.

The compiler resolves *only* `shape`, `hidden`, `ports` and the label — the few things downstream stages need structurally. All other configuration stays symbolic in `config` and `classes` for DD-04's cascade, so the IR never has to know what a style property means.

**Ports** cascade the same way `shape` does, but per port id rather than as a single scalar: for each node, `@ports` from every class in the linearised chain (low → high precedence) are merged, then the node's own inline `@ports` on top, with inline winning per port id. A port whose `side` is not one of `north south east west` — including a non-string value — is `SGL3007` (warning) and falls back to `east`; the registry (DD-02 §7) deliberately does not validate this, the same way it leaves `shape`'s enum unchecked, so it is the compiler's job here too.

---

## 5. Edge order and IDs

Edges are ordered by (declaring container in `order`, then declaration order within it). This is stable under edits elsewhere in the document.

```
EdgeId = 'e-' + fnv1a64( from.node + '\x1f' + (from.port ?? '') + '\x1f'
                       + directed + '\x1f'
                       + to.node + '\x1f' + (to.port ?? '') + '\x1f'
                       + parallelIndex )
```

**Corrected from an earlier `.toString(36)` here: there is no base-36 step.** `fnv1a64` returns its contractual 16 lowercase hex digits, and `compile()` has always used that raw — the `.toString(36)` this line once showed was never implemented, only ever documented, and changing the *code* to match it now would invalidate every committed golden to save three characters. Hex is also what `shortHash` and DD-07 §6's element IDs assume, so the code was self-consistent and this line was the outlier. **The formula above is frozen from here**, hex included, alongside its inputs.

`parallelIndex` is the edge's index among edges with the same `(from, to, ports, directed)` key, in edge order. Consequences, stated so they are not rediscovered as bugs:

- Reordering unrelated edges or nodes: **IDs unchanged**.
- Changing an endpoint or a label: label change → same ID; endpoint change → new ID (it is a different edge).
- Inserting a new parallel edge *before* an existing identical one: the existing one's `parallelIndex` shifts → **its ID changes**. Accepted; parallel duplicate edges are rare and the alternative (position-based IDs) is unstable under every edit.
- **Hiding an edge does not renumber its parallel twins.** `hidden` is not part of the key, so a hidden edge still consumes its `parallelIndex` and every other edge in the group keeps its ID. Hiding and unhiding is therefore ID-neutral, which is what E16/F12 (visual diff, version history) need from it.
- **Adding a child to a wildcarded container: every existing edge keeps its ID**, and the new one gets its own. This falls out of expanding before allocating — the ID is derived from the concrete endpoints, so it does not know or care that a wildcard produced it. Had the wildcard survived into ID allocation and been numbered by expansion index instead, inserting a child at the top of `lane1` would have renumbered every edge below it, and E16/F12 (visual diff and version history) would report a document-wide change for a one-line edit.

---

## 6. Labels

- Node title text = `config.label` if present, else the node's **key** (not the path).
- Edge label text = `config.label` if present, else no label (`labelId: null`).
- `@hidden: true` nodes get `hidden: true` and are still in the graph (so edges to them resolve) but are excluded from `order`; engines skip hidden nodes and edges to them (DD-06 §2 — the host filters before calling the engine).
- A `GraphEdge` is **effectively hidden** — `hidden: true` — when its own `config.hidden` is `true`, or either endpoint's resolved node is hidden, mirroring the node rule above so the two never disagree about an edge whose endpoint is hidden without the edge itself carrying `@hidden`. A hidden edge gets `labelId: null`, same as a hidden node. `SGL3002` stays keyed off hidden **nodes** only: an edge that is self-hidden between two otherwise-visible nodes produces no diagnostic — there is no hidden node for it to be reported against.
- MVP text handling: split on `\n`; each line is one `TextRun`. Leading/trailing whitespace per line is preserved; the empty label `""` gives `labelId: null`.

**⟶ v1.0 (A18):** `runs` become styled runs from a markdown-subset parser. `LabelSpec` does not change shape, which is why it is an array of runs from day one.

---

## 7. Traversal order

`order` is a pre-order walk: a node, then its children in declaration order. Hidden nodes and their subtrees are omitted. This is the order used for SVG document order (accessibility, DD-07 §7), tab order in the live view, and default label z-order.

**`order` is the only filtered traversal.** `GraphNode.children` and `SemanticGraph.rootChildren` are structural — they list every declared child, hidden ones included — because a consumer that needs the tree (a container packer, a source map, a future view predicate) needs it whole. A consumer that walks `children` instead of `order` must test `node.hidden` itself; the flag is already resolved to *effectively* hidden, so that is one comparison and never an ancestor walk. Key order in `nodes` and `labels` is likewise not a traversal: integer-like node keys sort ahead of the rest (07 §1), so `order` is the only thing that carries document sequence.

---

## 8. Reserved for one-model-many-views (I1)

```ts
compile(model: DocumentModel, view?: ViewSelector): CompileResult
```

`ViewSelector` is `undefined` in MVP and the parameter is accepted and ignored. Everything in `compile` already operates on a filtered node set (the `hidden` mechanism), so a view becomes "a predicate plus a config overlay" rather than a new pipeline stage. Listed so nobody removes the parameter as unused.

---

## 9. Diagnostics

| Code | Severity | Message template |
|---|---|---|
| `SGL2001` | error | Cannot find `{path}` from `{container}`. The edge was skipped. |
| `SGL2003` | warning | `{node}` has no port `{port}`; the edge attaches to the node instead. |
| `SGL3001` | warning | Unknown shape `{name}`; using `rect`. |
| `SGL3002` | warning | `{node}` is hidden; {n} edges to it are not drawn. |
| `SGL3003` | warning | `{path}` matched no nodes; the edge was skipped. |
| `SGL3004` | error | A wildcard may only be the last part of a path; `{path}` was skipped. |
| `SGL3005` | error | `{from} {op} {to}` expands to {n} edges, over the limit of {max}; it was skipped. |
| `SGL3006` | info | Shape `{name}` is not drawn in this version; using `rect`. |
| `SGL3007` | warning | `{node}` port `{port}` has side `{side}`; expected north, south, east or west. Using `east`. |

---

## 10. Tests

- Goldens: corpus → IR JSON, byte-exact.
- Endpoint resolution table: every combination of `root`, `parents`, quoted segments, container targets, ports; each unresolvable form emits exactly one `SGL2001` and drops exactly one edge.
- Wildcard expansion: `*` against a container, a leaf, an empty container and a hidden child; `**` across three levels; both-sided cross product including the self-pair exclusion; a mid-path wildcard emitting exactly one `SGL3004`; the expansion ceiling emitting exactly one `SGL3005` and leaving every other edge intact.
- Glob matching: prefix (`cam*`), suffix (`*-db`), both ends (`cam*hd`); a pattern longer than the key (`ca*am` must not match `cam`); case sensitivity; a quoted key with a space; a glob matching nothing emitting exactly one `SGL3003`; a glob combined with `**` and a two-star segment failing to lex as `SGL1002`.
- Wildcard ID stability: expand a wildcard, record the edge IDs, insert a child at the *front* of the matched container, assert every original ID is still present.
- ID stability: reorder a corpus document's declarations randomly, assert node and edge ID sets are identical.
- Class linearisation and shape precedence: inline over class, later class over earlier, subclass over base.
- Hidden: edges to hidden nodes are present in `edges` but absent from the engine's view (DD-06 test).
