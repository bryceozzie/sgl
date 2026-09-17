# DD-06 — Layout Host and Engines

**Packages:** `@sgl/layout-api` (host, protocol, fallbacks, validation), `@sgl/layout-elk` (default engine), `@sgl/layout-std` (`grid`)
**Inputs:** `StyledGraph` (DD-04), `MeasureTable` (DD-05), engine id + options · **Output:** `LayoutResult`

---

## 1. Responsibilities

| `layout-api` | Engines |
|---|---|
| Build `LayoutInput` from a `StyledGraph`: compute node sizing, filter hidden, freeze | Return geometry for the graph they are given |
| Run the engine in a Worker with timeout and abort | Declare capabilities honestly |
| Fill capability gaps: label placement, straight routing, shape clipping, arrow reserve | Never touch the DOM, `Math.random`, or `Date` |
| Validate the result; reject malformed output with a diagnostic | |
| Quantize geometry (ADR-0004) | |
| Own the `LayoutEngine` contract and the conformance suite | |

---

## 2. Contract

The interfaces from [Architecture §4](../03-architecture.md#4-layout-engine-plugin-api) are normative and are not repeated. This section fixes what was left open.

> **Amended by Stage E (07 §5).** Architecture §4.2's sketch — and this section's
> original text — put `sizing`/`min`/`max`/`fixed`/`aspectRatio`/`hints` directly on
> `GraphNode`. The `GraphNode` Stage C actually shipped (`packages/core/src/graph.ts`)
> carries none of that: no geometry, no per-node `hints` bag, only the raw `config:
> ConfigBag` the document declared. `LayoutInput.graph` is that real `SemanticGraph`
> (`contract.ts`'s `LayoutInput.graph` is frozen to it), so there is nowhere on a
> node to hang derived sizing. Two changes, both additive to `contract.ts`'s
> `LayoutInput`, not to `GraphNode`:
> - `sizing: Readonly<Record<NodeId, NodeSizing>>` — everything below, per node,
>   keyed alongside `graph` instead of living on it. See `NodeSizing` in
>   `contract.ts` and `buildLayoutInput()` in `sizing.ts`.
> - `labelSizes: Readonly<Record<LabelId, Size>>` — every label's measured size,
>   needed by the host's label-placement and edge-routing fallbacks (§4.1) as much
>   as by an engine, and by the same argument has nowhere else to live.
>
> `hints` never became a field: `GraphNode.config`/`GraphEdge.config` already carry
> the node/edge's own `@`-bag (`config.layout`, etc.), so an engine (or `grid`) just
> reads `node.config['layout']` directly — one fewer thing to keep in sync. The
> `SGL4010`-on-unknown-hint-key validation this section describes is **not
> implemented**: it needs the JSON-Schema validator `hintsSchema`/`optionsSchema`
> imply, which no stage has pulled in yet. `grid`'s own `columns` hint is read and
> used; an unrecognised key is silently ignored rather than warned about.

**`LayoutInput` construction** (`buildLayoutInput(styled, labelSizes, scope?)`, `sizing.ts`):

Both nodes and edges carry their own `hidden` flag (DD-03 §2, §6) — a node's already excludes it from `graph.order`, and an edge's is already "effectively hidden" (its own `@hidden`, or either endpoint's node, computed once in `compile()`). Filtering either kind of element for `LayoutInput` is therefore a single flag test — `!edge.hidden` for edges alongside the node loop below — not a node filter plus a separate "does this edge touch a hidden node" walk:

```
for each node in graph.order (already excludes hidden):
  g        = styles[node].geometry
  label    = labelId ? labelSizes[labelId] : { w: 0, h: 0 }
  contentInset = g.padding (t r b l) + shape.contentInsets(label.w, label.h)   // DD-07 §4, duplicated in layout-api/content-insets.ts
  intrinsic = { w: label.w + contentInset.l + contentInset.r,  h: label.h + contentInset.t + contentInset.b }
  min      = { w: g.minWidth, h: g.minHeight }; max = { w: g.maxWidth, h: g.maxHeight }
  fixed    = { w: g.width, h: g.height }
  padding  = contentInset; if container: titleHeight = label.h + g.titleGap; padding.top += titleHeight
  sizing   = { intrinsic, min, max, fixed, aspectRatio: g.aspectRatio, contentInset, padding }
```

`contentInset` and `padding` are both kept on `NodeSizing`, not just the post-title-band one: §4.1 needs the *pre*-band inset to place a container's own title (which sits *in* the band), while `grid` (§7) needs the *post*-band one to know where a container's children start. They are equal for a leaf.

**DEVIATION** from `buildLayoutInput(styled, table)`'s original signature: `table` was meant to be the runKey-keyed `MeasureTable`, with this function computing `hashRuns(...)` itself to look a label up. `hashRuns` and the `StyledRun`/`TextStyle` types it needs live in `@sgl/measure` (`run-key.ts`), and `layout-api` may not depend on `@sgl/measure` any more than on `@sgl/theme` (`eslint.config.js` enforces this on `src/**`, not just `test/**`). `buildLayoutInput` therefore takes the already-resolved `LabelId -> Size` table; the runKey lookup is the caller's job (Stage G's pipeline harness, eventually — Stage E's own tests do it inline).

Circles and other `aspectRatio`-locked shapes get `max(w,h)` applied by the engine or the host post-pass (§4.4), not here — engines that lay out containers need the *unconstrained* intrinsic to pack children.

`ResolvedThemeMetrics` passed in `ctx.metrics`: `{ spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {…}, arrowSize }` — the small set of theme-derived numbers an engine may want for defaults. Engines must not read `StyledGraph`; they get `LayoutInput` only.

---

## 3. Worker host

One long-lived `Worker` (`layout.worker.ts`), respawned on termination. Engines are lazy `import()`ed inside it and cached.

### Protocol

```ts
// host → worker
{ t: 'layout', id: number, engine: string, input: LayoutInput, options: object,
  metrics: ResolvedThemeMetrics, table: MeasureTable, seed: number }
{ t: 'abort', id }
{ t: 'measure-reply', id, req: number, layout: TextLayout }

// worker → host
{ t: 'result', id, result: LayoutResult, ms: number }
{ t: 'error',  id, diagnostic: Diagnostic }
{ t: 'measure', id, req: number, runs: StyledRun[], box: BoxConstraints }   // table miss
{ t: 'log', id, level, message, nodeId? }
```

All payloads are plain objects; `LayoutInput` and `MeasureTable` are already `structuredClone`-safe by construction (DD-00 §3).

### Lifecycle per request

```
1. host assigns id, starts timer (default 10 000 ms; grid 2 000 ms)
2. posts 'layout'
3. on 'result'  → clear timer → validate (§5) → quantize → resolve
   on 'error'   → clear timer → reject with the diagnostic
   on timer     → worker.terminate(); respawn; reject SGL4001
4. abort(): post 'abort'; if no 'result'/'error' within 250 ms → terminate + respawn; reject with AbortError
```

Engines receive `ctx.signal`; `elk` cannot be interrupted mid-run (it is synchronous GWT code), so abort on `elk` is effectively the 250 ms terminate path. This is acceptable: respawn is ~30 ms and the next layout request is already queued.

A single in-flight request at a time; a new request aborts the previous one. The application never queues more than one (DD-08 §3).

**Isolation level:** same-origin Worker. Sufficient for bundled engines. **⟶ B17:** the `LayoutHost` interface gets a second implementation that hosts the Worker inside a null-origin iframe; the protocol is identical.

---

## 4. Host fallbacks (`layout-api/fallbacks.ts`)

Applied after the engine returns, based on its `capabilities`. Implemented: `placeLabels` (§4.1) and `routeStraight`, which folds together §4.2 (straight routing), §4.3 (shape clipping) and §4.5 (self-loops) into one pass over each un-routed edge, plus §4.4 (arrow reserve) — see that section's own deviation note. **Not implemented: §4.6 (aspect lock)** — Stage E's brief did not name it as a task and no corpus document exercises `aspectRatio`; a node with `@size.aspectRatio` set will not come out square/circular from `grid` alone until a later stage adds it.

### 4.1 Label placement (`labelPlacement: false`)

| Label | Placement |
|---|---|
| Node title | Centred in the node's content box — `frame` inset by `NodeSizing.contentInset` (theme padding + shape content insets; **not** `padding`, which for a container also carries the title band — see §2's amendment) |
| Container title | Top-left of `frame` inset by `contentInset.left`, `contentInset.top`; align `start`, baseline `top` |
| Edge label | At the route's arc-length midpoint, offset perpendicular by `labelGap + height/2` on the side away from the route's centroid; `occlusion: 'plate'`. For a single-segment straight route the centroid coincides with the midpoint — genuinely degenerate, since there is no bend to be away from — so the implementation falls back to a fixed, deterministic side (90° counter-clockwise from the direction of travel) in that case. |

### 4.2 Straight routing (`edgeRouting: 'straight'`)

Start = centre of `from` node (or its port point); end likewise. One `L` segment. Then §4.3 clips both ends.

### 4.3 Shape clipping (`clip: 'shape'` on an `EdgeLayout`, or always after 4.2)

Intersect the first segment with the `from` shape's boundary and the last with the `to` shape's, using the shape's anchor function (DD-07 §4). `startNormal`/`endNormal` = segment direction at the clipped point.

### 4.4 Arrow reserve

For `directed: forward|both`, shorten the head end by `geometry.arrowSize` along the final segment so the marker tip lands on the boundary rather than the line poking through it. Likewise the tail for `both`.

Stage E's brief (07 §5) named only clipping and self-loops for `routeStraight`, not this subsection — folded in anyway, because without it every directed edge (the large majority of the corpus) would render with its arrowhead straddling the node boundary, and no later stage's task list claims it either. Uses `ctx.metrics.arrowSize`, the one theme-wide constant `ResolvedThemeMetricsView` exposes — not a per-edge `geometry.arrowSize`, despite the registry allowing `arrowSize` to vary by class; `routeStraight`'s signature was extended with a `metrics` parameter to reach it (the DD-06-inherited stub took only `input`/`result`).

### 4.5 Self-loops

If an engine returns a self-loop route of fewer than two segments (or none), replace it with a loop: exit the node's top-right at 45°, three `C` segments forming a teardrop of radius `max(24, node.h/2)`, re-enter at the right. Label at the loop's apex.

### 4.6 Aspect lock

For nodes with `aspectRatio`, after layout: `w = h = max(w, h)` (ratio 1) or the general form, keeping the centre fixed. Applied only if the engine did not already honour it (capability-free — the host checks the returned frame).

---

## 5. Validation and quantization

`validateResult(result, graph, engineId)`, run before anything trusts the engine's output:

| Check | On failure |
|---|---|
| Every non-hidden node has a `NodeLayout`; no unknown ids | `SGL4002` |
| Every edge has an `EdgeLayout`; no unknown ids | `SGL4002` |
| All numbers finite; all frame sizes ≥ 0 | `SGL4002` |
| Every `LabelPlacement.labelId` exists in `graph.labels` | `SGL4002` |
| Container `contentFrame` inside its `frame` | `SGL4003` warning |
| Child frames inside parent contentFrame (± 0.5 px) | `SGL4003` warning; not corrected — some engines overflow deliberately |

**DEVIATION:** the "contentFrame reset to frame inset by padding" correction this table originally specified for the first `SGL4003` row is **not implemented**. `validateResult`'s signature — inherited unchanged from the stub Stage E started from — returns `readonly Diagnostic[]` only; it has no way to hand back a corrected `LayoutResult`. Both `SGL4003` rows are therefore warnings with no correction, which is what the table's own second row already said for the sibling case. A future stage wiring this into a real pipeline, with a code path that can return a new `LayoutResult`, can add the correction then. `engineId` is a third parameter Stage E added, needed only to fill in `SGL4002`'s `{id}` placeholder in the message text — it plays no part in what is checked.

`SGL4002` rejects the whole result; the application keeps the previous `LayoutResult` (FR-E4 at the layout stage).

**Quantization** (ADR-0004): every `x y w h`, every path point, every label frame → `Math.round(v * 64) / 64`. Applied to the validated result; the `LayoutResult` the renderer sees is always quantized.

`bounds` is recomputed by the host from the quantized frames and routes plus `canvas.margin` (16 px), so engines may leave it approximate.

---

## 6. `elk` engine (`@sgl/layout-elk`)

```ts
id: 'sgl.elk', apiVersion: 1,
capabilities: { containers: true, edgeRouting: 'orthogonal', ports: true,
                labelPlacement: true, incremental: false, determinism: 'quantized' }
optionsSchema: { direction: enum down|up|left|right (default down),
                 nodeSpacing: number (40), rankSpacing: number (70),
                 edgeRouting: enum ORTHOGONAL|POLYLINE|SPLINES (ORTHOGONAL),
                 nodePlacement: enum BRANDES_KOEPF|NETWORK_SIMPLEX|LINEAR_SEGMENTS (BRANDES_KOEPF) }
hintsSchema: { rank: 'same' (⟶ B13), priority: number, portConstraints: enum }
```

Loads `elkjs/lib/elk.bundled.js` (synchronous, single-thread) inside the layout worker — never `elk-worker.js`.

### 6.1 Input mapping

```
root ElkNode:
  id: 'root'
  layoutOptions:
    'elk.algorithm':                 'layered'
    'elk.direction':                 DOWN|UP|LEFT|RIGHT
    'elk.hierarchyHandling':         'INCLUDE_CHILDREN'
    'elk.randomSeed':                '1'
    'elk.edgeRouting':               options.edgeRouting
    'elk.spacing.nodeNode':          nodeSpacing
    'elk.layered.spacing.nodeNodeBetweenLayers': rankSpacing
    'elk.spacing.edgeLabel':         metrics.spacing.edgeLabel
    'elk.layered.nodePlacement.strategy': options.nodePlacement
  children: map(rootChildren, toElkNode)
  edges:    map(all edges, toElkEdge)          // ALL edges live on root — valid under INCLUDE_CHILDREN

toElkNode(n):
  id: n.id
  width/height:  sizing.fixed ?? clamp(sizing.intrinsic, min, max)      // leaves
                 (omitted for containers — ELK sizes them from children + padding)
  labels: [{ text: '', width: label.w, height: label.h,
             layoutOptions: leaf ? { 'elk.nodeLabels.placement': '[H_CENTER, V_CENTER, INSIDE]' }
                                 : { 'elk.nodeLabels.placement': '[H_LEFT, V_TOP, INSIDE]' } }]
  ports: map(n.ports, p => ({ id: n.id + '#' + p.id, width: portSize*2, height: portSize*2,
                              layoutOptions: { 'elk.port.side': NORTH|SOUTH|EAST|WEST } }))
  layoutOptions (containers): { 'elk.padding': `[top=${padding.t},left=${l},bottom=${b},right=${r}]`,
                                'elk.portConstraints': ports.length ? 'FIXED_SIDE' : 'FREE',
                                'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${min.w},${min.h})` }
  children: map(n.children, toElkNode)

toElkEdge(e):
  id: e.id
  sources: [ e.from.port ? e.from.node + '#' + e.from.port : e.from.node ]
  targets: [ likewise ]
  labels: e.labelId ? [{ text: '', width, height, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] : []
  layoutOptions: { 'elk.layered.priority.direction': hints.priority }   // when present
```

`directed: 'none'` and `'both'` are still passed as directed edges (ELK is layered; direction drives rank). Arrowheads are the renderer's concern.

### 6.2 Output mapping

ELK coordinates are **relative to the parent node** (edges relative to their container — here root, so absolute). Walk the tree accumulating offsets:

```
NodeLayout.frame        = { x: abs.x, y: abs.y, w: node.width, h: node.height }
NodeLayout.contentFrame = frame inset by sizing.padding (containers)
NodeLayout.ports[p]     = { point: abs(port.x + port.width/2, port.y + port.height/2), normal: bySide }
EdgeLayout              = sections[0]: start=startPoint, route = bendPoints.map(L) ++ [L endPoint]
                          (multi-section edges — hyperedges — are not produced for simple edges)
                          startNormal/endNormal from the first/last segment direction; clip: 'none' (ELK already stops at the boundary)
LabelPlacement (node)   = frame at abs(node) + label.x/y, size from label; align per placement; role from LabelSpec
LabelPlacement (edge)   = frame at label.x/y (absolute), align 'middle', baseline 'top', occlusion 'plate'
```

Then the host applies §4.4 (arrow reserve) and §4.5 (self-loops — ELK routes them but with a tight box; the host's teardrop is used when ELK's loop is under 16 px tall).

### 6.3 Known ELK behaviours to test around (06 §4 pitfall 8)

- Hierarchy-crossing edges with `ORTHOGONAL` occasionally route through a sibling container. The corpus includes this case; the mitigation is the `edgeRouting` option, and the test asserts no route segment intersects an unrelated container's frame — a *warning* in CI, not a failure, until the rate is known.
- Edge labels on very short edges may overlap the node; the host's plate makes this legible, and a later pass may nudge.

---

## 7. `grid` engine (`@sgl/layout-std`)

```ts
id: 'sgl.grid', apiVersion: 1,
capabilities: { containers: true, edgeRouting: 'straight', ports: false,
                labelPlacement: false, incremental: false, determinism: 'bitwise' }
optionsSchema: { columns: number | 'auto' ('auto'), gap: number (24), align: enum start|center (center) }
hintsSchema:   { columns: number, span: number (⟶ v1.x) }
```

Post-order over containers so child sizes are known before the parent packs them:

```
layoutContainer(c):
  items = c.children in order (each already laid out → size)
  n = items.length; cols = hints.columns ?? (options.columns === 'auto' ? ceil(sqrt(n)) : options.columns)
  rows = ceil(n / cols)
  colW[j] = max width of items in column j; rowH[i] = max height in row i
  x = padding.l; for each column j: colX[j] = x; x += colW[j] + gap
  y = padding.t (includes title band); for each row i: rowY[i] = y; y += rowH[i] + gap
  place item k at (colX[k % cols], rowY[floor(k / cols)]) — centred in its cell if align=center
  c.size = { w: max(minWidth, sum(colW) + gap*(cols-1) + padding.l + padding.r),
             h: max(minHeight, sum(rowH) + gap*(rows-1) + padding.t + padding.b) }
root: same, with padding = 0
```

All arithmetic is integer/rational → `bitwise`. Edges and labels are left to the host fallbacks (§4). This engine is the reference for "a 60-line engine still gives a complete diagram" (ADR-0002).

`hints.columns` is read from `node.config['layout']` directly (§2's amendment); the root has no such lookup, because `compile()` keeps only `model.root.config.title` from the root's config bag (`packages/core/src/compile.ts`) — a root-level `@layout.columns` never reaches `SemanticGraph` at all, so `grid` cannot honour one no matter how it reads hints. This is `compile()` (DD-03), frozen since Gate 1; out of Stage E's scope to fix, flagged here for whichever stage next touches root-level config plumbing.

F1 (07 §2.1) is cleared here: `pack()`'s `childrenOf()` filters `.hidden` on every level, not just the top, since `children`/`rootChildren` list hidden nodes and only `graph.order` does not.

**`pack()` honours a container's `min` but not its `fixed`/`max`.** This is the algorithm above exactly as written — `c.size` clamps only against `minWidth`/`minHeight` — and it is not a Stage E deviation, but it is easy to misread as a bug: `@size.width`/`@size.height` on a container is silently ignored by `grid`, which always sizes a container from its packed children regardless of what the document asked for. (A leaf does honour all three, via the ordinary `fixed ?? clamp(intrinsic, min, max)` path.) Whether a container should be allowed a fixed/max size at all — and if so, how packing degrades when the children do not fit inside it — is an open question for whichever stage next revisits `grid`, not a defect to route around silently here.

---

## 8. Conformance suite (`@sgl/layout-api/conformance`)

Run against both engines in CI; shipped in `@sgl/plugin-sdk` later (**⟶ B18** — the suite exists in MVP; the SDK packaging is what is deferred).

For each corpus graph (empty, one node, one edge, self-loop, parallel edges, 3-deep nesting, container-to-container edge, boundary-crossing edge, disconnected components, 1 000 nodes, extreme aspect):

1. Result passes `validateResult`.
2. Run twice; results byte-identical after quantization (`bitwise`/`quantized` engines).
3. No two sibling leaf frames overlap (containers may enclose).
4. Completes within the engine's timeout on the 1 000-node graph.
5. Engines claiming `labelPlacement: true` return a `LabelPlacement` for every label.

---

## 9. Diagnostics

| Code | Severity | Message template |
|---|---|---|
| `SGL4001` | error | Layout engine `{id}` did not finish within {ms} ms and was stopped. Showing the previous layout. |
| `SGL4002` | error | Layout engine `{id}` returned invalid geometry ({detail}). Showing the previous layout. |
| `SGL4003` | warning | `{node}` extends outside its container after layout. |
| `SGL4010` | warning | `@layout.{key}` is not an option of engine `{id}`; ignored. |
| `SGL4011` | error | Layout engine `{id}` failed: {message}. |

---

## 10. Tests

- Host: timeout → terminate/respawn → `SGL4001`; abort within 250 ms; abort escalation; single in-flight guarantee; measure-miss round trip.
- Fallbacks: each of §4.1–4.6 against fixture geometry, goldens.
- Validation: one fixture per row of §5's table.
- Quantization: values on both sides of a 1/128 boundary.
- `elk` mapping: input goldens (the `ElkNode` JSON we send) and output goldens; the hierarchy-crossing corpus case.
- `grid`: goldens; bitwise double-run across Chrome and Firefox in Playwright.
- Conformance suite on both engines.
