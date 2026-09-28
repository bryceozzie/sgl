# DD-14 — Per-container layout engines

**Feature:** B8 (per-container engine selection); requirement FR-Y9. **Packages:** `@sgl/layout-api`
(the plan, the composer, the diagnostics, the conformance suite), `@sgl/layout-elk` (fixed boundary
ports), `@sgl/layout-std` (none required), `apps/web` (the plan, the request, the build, the help).
**Inputs:** `LayoutInput` (DD-06 §2), the resolved `DocumentModel` and AST, the registered engines'
descriptors. **Outputs:** one `LayoutResult`, as today.

**Status: decided (2026-09-28). Designed 2026-09-27 from `main` at `9f47545`; the human accepted
every recommendation on 2026-09-28 (⚑1–⚑8, §13). No code is changed by this document**: §11's
branches implement it. **Branch 1, `feat/b8-compose`, is built (§11.1).** The documents it amends were updated on this branch (§14). It assumes `fix/root-layout-options` (`5dfc16f`, DD-12 H6) is merged first: B8 reuses its
`rootLayoutOptions` seam and its `EngineSchemas.accepts`.

**Why now.** Human decision F29 (2026-09-27): keep spec §9's worked example, which puts
`@layout: { engine: grid, columns: 2 }` on the `payments` container, and build B8 sooner. Today that
key is `SGL4010` (twice under `elk`: `engine`, and `columns`, which `elk` does not declare), and the
whole document is laid out by the root's engine.

The decisions are numbered **C1–C49**. Each has a recommendation and a one-line reason in italics.
Decisions marked **⚑** went to the human; §13 gives each one's options. **All eight were accepted as
recommended (human decision 2026-09-28).** Where this document changes another document, the change
is listed in §12 and made by the branch that implements it. The exceptions are §14's changes,
made on this branch: the factual fixes, and the decided ADR-0002 amendment and spec text.

---

## 1. Summary

| Part | Recommendation |
|---|---|
| Meaning | A container whose `@layout` names an `engine` is a **boundary**. That engine lays out the container and everything inside it, down to the next boundary. The parent's engine sees the container as one box of fixed size. Every node is placed by exactly one engine |
| Options | A boundary's `@layout` works as the root's does: its other keys are that engine's options (C6) |
| Who runs it | The **host**, in the worker, in **one request**: bottom-up over the boundaries, then one translation pass (C23). Not `ctx.sublayout` |
| Edges across a boundary | The parent's engine sees the edge, lifted to the box. An engine that routes (`elk`) routes it to a **fixed port on the box's side**, and the host adds a short straight **leg** inside the box. Under an engine that leaves routing to the host (`grid`, `fixed`, `radial`), the host draws the whole edge straight, as today (C13–C22) |
| Contract | No new capability. `LayoutInput.scope`, in the contract since v1, becomes load-bearing and gets a conformance check. One optional field, `LayoutInput.portPositions`. `apiVersion` stays 1 |
| Failure | A sub-layout that fails is laid out by its parent's engine instead, with a warning (`SGL4013`). The root's failure is what it is today |
| Boot cost | ~0.5–0.7 kB gz, with the composer in a lazy worker chunk (~1.7–2.1 kB) |
| Diagnostics | `SGL4010` stops firing for a container's `engine`. New: `SGL4012` (unknown engine on a container), `SGL4013` (a sub-layout failed) |

**No new dependency.** The renderer, the paint-only path, the theme and measurement are unchanged.

---

## 2. What is true today (found while designing this)

1. **Every engine already honours `LayoutInput.scope`.** `grid` and `fixed` start their post-order
   pack at `input.scope` and give the scope node a frame at `(0, 0)` (`grid.ts`, `fixed.ts`).
   `elk`'s `toElkGraph` sends the scope node as ELK's only top node and keeps only the edges with
   both ends inside it (`mapping.ts`, `subtreeOf`). Nothing calls them with a scope: the app always
   sends `null`. So the inner half of B8 exists in the engines and is untested.
2. **`ctx.sublayout` rejects.** `worker-runtime.ts` gives every engine a `sublayout` that returns a
   rejected promise ("reserved, not implemented"), and `worker-runtime.test.ts` checks that.
3. **A container's `@layout.engine` is warned about and ignored.** `layoutConfigDiagnostics` emits
   `SGL4010` with `{key: 'engine'}` when a container names another engine. A container naming the
   *same* engine (`engine: "sgl.elk"` under `elk`) gets no warning and has no effect.
   `corpus/layout/nested-engine.sgl` pins the first case.
4. **An option key on a plain container is accepted and does nothing.** At a container,
   `layoutConfigDiagnostics` checks a key against the engine's options *and* hints. But `elk` reads
   only `portConstraints` and `priority` from a node, and `grid` only `columns`. So a container's
   `@direction` (sugar for `@layout.direction`) under `elk`, or its `gap` under `grid`, is silently
   ignored: `direction` is an `elk` option, so there is no `SGL4010` (§15 item 2).
5. **The host sizes nothing and moves everything.** `quantize` re-origins the whole result
   (DD-06 §5). A container's size is whatever its engine returned. There is no host code that
   sizes a container from its children.
6. **`routeStraight` routes an edge between any two frames, at any depth.** It works on absolute
   frames and clips at each shape (DD-06 §4.2). Under `grid`, an edge from inside a container to
   outside it is already one straight line across the container's frame.
7. **`@pin`'s frame of reference already fits.** A pin is relative to the parent's content box
   (DD-12 H2), so a `fixed` box anywhere in a diagram keeps its pins' meaning.
8. **The spec's example is in the corpus.** `corpus/checkout.sgl` is spec §9 exactly, with the
   `payments` grid. The render harness lays it out under `grid` (DD-12 §13, `harnessEngine`); the
   `elk` goldens take it through `elkEngine` directly, with the full input.
9. **Budget.** Core is **179.19 kB of 182** on `main`, **179.50** with `fix/root-layout-options`.
   DD-12 plans ~1.3 kB more for `tree` and `radial`, and DD-13 ~0.4 kB for the Help button. That
   leaves about **0.8 kB** for everything else in Stage L. *(Since 2026-09-28 the limit is
   **184 kB**, human decision, ⚑7; `main` `90689df`.)*

---

## 3. Semantics

### 3.1 A boundary

- **C1. A container is a *boundary* when its resolved `@layout.engine` names a registered engine**
  (by id or bare name, DD-12 N22's rule) and it has at least one visible child. Its engine lays out
  the container itself (its frame, content frame and title) and every node inside it, except the
  inside of a nested boundary. To its parent's engine it is one box of fixed size. *One sentence to
  teach, and the scope a container already is in the contract.*
- **C2. ⚑ Naming the same engine as the parent's still makes a boundary.** `@layout: { engine: elk,
  direction: right }` inside a `down` `elk` document lays that container out rightwards on its own.
  *Predictable: the key always means one thing, whatever surrounds it. It is also the only way to
  give an `elk` container its own direction (§3.4). The cost is that an edge crossing that
  container is drawn by §4, not by one ELK run.* §13 ⚑1. **Human decision 2026-09-28: accepted.**
- **C3. Every node is placed by exactly one engine: the engine of its innermost enclosing boundary,
  or the root's.** A boundary container is *placed* by its parent's engine and *sized* by its own.
  *This is the rule the diagnostics (C11), the pins (C10) and the help all follow.*
- **C4. A boundary's size is fixed before its parent is laid out.** The parent cannot stretch it:
  `grid` centres it in its cell, `elk` treats it as a leaf of that size. *`@size` on a container is
  already `SGL2012` (spec §4), so no author expects to set it; a parent that resized a box would
  need a second pass of the inner engine.*

### 3.2 Nesting composes

- **C5. Nesting is any depth and any mix.** A `grid` inside an `elk` container inside a `fixed`
  document:
  1. `grid` lays out the innermost box, with `scope` = that box;
  2. `elk` lays out the middle container, seeing the `grid` box as a leaf of its size;
  3. `fixed` lays out the root, seeing the `elk` box as a leaf, at its pin if it has one;
  4. the host translates each box's contents by the box's position in its parent.

  No node is laid out twice. *Post-order is the order every in-house engine already uses inside
  itself (DD-06 §7, DD-12 N7).*

### 3.3 Options at a boundary

- **C6. ⚑ A boundary's `@layout` works exactly as the root's does.** Its other keys are options of
  *its* engine, taken by the same code as the root's (`rootLayoutOptions`, DD-12 H6): a key the
  engine does not declare in `optionsSchema` is `SGL4010`; a value the engine's form would not keep
  is `SGL2011` at the key; `@direction` sets `direction`. An option the boundary does not set comes
  from the **nearest enclosing boundary, or the root, laid out by the same engine**, or else from
  the engine's defaults. *"A container that names an engine is the root of its own small document"
  is the easiest rule to teach, and inheriting within one engine keeps a document's feel: a
  `direction: right` container inside an `elk` document keeps the toolbar's spacing.* §13 ⚑2.
  **Human decision 2026-09-28: accepted.**
- **C7. The toolbar's Options ▾ apply to the root's engine only** (C44). A boundary using the root's
  engine inherits them through C6.
- **C8. The plan is built on the main thread.** `layoutPlan(ast, model, root, engines)`
  (`@sgl/layout-api`, beside `rootLayoutOptions`) returns `{ scopes, diagnostics }`. `scopes` is
  `readonly { node, engine, options }[]`, in `graph.order` (pre-order), with each engine a full id
  and each options bag complete. *It needs the descriptors and the F11 normalisers
  (`acceptsOption`), which live on the page, exactly as the root's options do.*

### 3.4 `@direction` and other keys on a container that is not a boundary

- **C9. ⚑ On a container that names no engine, `@layout` keys are hints for the engine around it,
  checked against that engine's `hintsSchema` only.** Today they are checked against options and
  hints, so option-only keys pass and do nothing (§2 item 4). With this change, a plain container's
  `@direction` under `elk`, or its `gap` under `grid`, is `SGL4010`. The help says: "to change the
  direction inside a container, give it an engine: `@layout: { engine: elk, direction: right }`".
  `tree`'s `direction` hint (DD-12 N37, N38) is unaffected: it is a hint. *A key that does nothing
  should say so; the alternative, an implicit boundary, would change edges without the author
  asking.* §13 ⚑3. **Human decision 2026-09-28: accepted.**

### 3.5 `@pin` inside a boundary

- **C10. A pin is honoured when the engine that places that node honours pins (C3).** A node inside
  a `fixed` box in an `elk` document goes where its pin says, relative to the box's content box
  (H2). The box's own pin is judged by the *parent's* engine. `SGL4021` follows the same rule.
  *Relative pins were chosen for exactly this (DD-12 N2).*

### 3.6 Diagnostics on the main thread

- **C11. `layoutConfigDiagnostics` becomes scope-aware.** It walks the AST as today, with a stack of
  effective engines taken from the plan (by node path; the walk already keys nodes by path):
  - a container's `engine` key is no longer `SGL4010`;
  - a boundary's keys are checked as the root's (C6);
  - a plain container's keys are checked against the hints of the engine around it (C9);
  - `@pin` is checked against the engine that places the node (C10).

  *The plan comes from the resolved model, so `engine: $e` works; the spans come from the AST, as
  today.*
- **C12. An engine name that is not registered, on a container, is `SGL4012` (warning) at the key:
  "Layout engine `{name}` is not available; `{node}` is laid out by `{id}`."** The container is
  then not a boundary. *The root's unknown engine stays `SGL4011` with no layout, because the root
  has nothing to fall back to; a container has its parent.* §13 ⚑6. **Human decision 2026-09-28: accepted.**

### 3.7 Edge cases

- A **hidden** boundary hides its subtree; it is not a scope. A container whose children are all
  hidden is a leaf (DD-06 §6.1), so it is not a boundary, and its `engine` key has no effect and no
  warning.
- **Imported subtrees** (A9) keep their containers' `@layout.engine`: the plan reads the resolved
  model, which holds grafted nodes. They get no `SGL4010`/`SGL4012`, because they have no AST in
  the document (as DD-12 N6 does for pins).
- **An imported document's own root `@layout`** is not carried onto its `as:` container. That would
  be a language change and is not proposed here.

### 3.8 Spec text (approved: human decision 2026-09-28, ⚑8; applied to spec §4 on this branch)

Spec §4, the `@layout.*` row, **Notes** column:

> Engine hints and options. At the root, `engine` picks the document's engine (below). On a
> container, `engine` gives the container an engine of its own (below); without it, the keys are
> hints for the engine around it.

After §4's root `@layout` paragraph, a new paragraph:

> **A container's own engine.** A container whose `@layout` names an `engine` is laid out by that
> engine, with everything inside it, as if it were the root of a document of its own: its other
> `@layout` keys are that engine's options, checked as the root's are, and `@direction` sets its
> `direction`. An option it does not set is taken from the nearest enclosing container, or the root,
> laid out by the same engine, or else is the engine's default. The engine around it places it as
> one box of the size its own engine gave it. A `@pin` is honoured when the engine that places that
> node honours pins. An engine name that is not available is `SGL4012`, and the container is laid
> out by the engine around it. On a container that names no engine, the `@layout` keys (and
> `@direction`) are hints for the engine around it; a key that is not one of its hints is `SGL4010`.

---

## 4. Edges that cross a boundary

The hard part. In spec §9, `storefront.bff -> payments.api` enters the `grid` box from the `elk`
root, and `payments.api -> psp` leaves it.

### 4.1 Options

| | Who routes | Quality | Determinism | Size (worker, gz) |
|---|---|---|---|---|
| **(a) Host, end to end, straight.** The parent never sees the edge; after composition, `routeStraight` draws it from node to node | the host | Under `grid`/`fixed` parents: what `grid` draws today. Under `elk`: the edge plays no part in ranking, so `psp` may land left of `payments`, and the line crosses whatever is between | `bitwise` arithmetic | ~0 (existing code) |
| **(b) Lift to the box, fixed boundary ports, host legs.** The parent's engine gets the edge with its inner end replaced by the box, at a port the host placed on the box's side; the host joins the port to the real end with a short straight leg | the parent's engine outside; the host inside | Ranking accounts for the edge; the outside route is the parent's style (orthogonal under `elk`); the leg is short and axis-aligned when the port is fixed | `bitwise` arithmetic, plus the parent's class | ~0.5 (ports, legs) + ~0.1 in `elk`'s mapping |
| **(c) ELK's own hierarchy for `elk` in `elk`**: one ELK run, `elk.hierarchyHandling: SEPARATE_CHILDREN` on the boundary | ELK | Good where it works; `elk` in `elk` only | `quantized` | ~0.1 |
| **(d) A host router across levels**, orthogonal with obstacle avoidance | the host | Potentially the best | depends on the router | several kB; research |

(c) fails on evidence already in the repository: `SEPARATE_CHILDREN` on containers made ELK throw on
10 corpus documents (DD-06 §6.2), and ELK does not route hierarchy-crossing edges outside
`INCLUDE_CHILDREN`. It covers one pair of engines out of the nine. (d) is a project of its own.

- **C13. ⚑ Recommended: (b), with (a) where the parent's engine leaves routing to the host.**
  §13 ⚑4. **Human decision 2026-09-28: accepted.** *The parent must know about the edge, or its placement ignores the diagram's main flow:
  that is (a)'s real failure under `elk`. Under a straight-routing parent, (a) is already the
  best-looking answer (one straight line, no kink) and costs nothing.* **Fallback:** if branch 3's
  spike finds ELK does not honour fixed port positions on a leaf inside an `INCLUDE_CHILDREN`
  graph, keep the lift and the leg but give the port only a side (`FIXED_SIDE`, the mapping's
  existing path): the leg is then a short diagonal. If quality or bytes still fail review, ship (a)
  everywhere, which branch 2 already is.

### 4.2 Lifting

- **C14. Each edge is routed in its lowest common scope.** For edge `e`, walk up from each endpoint
  to the boundaries that contain it; the innermost boundary (or the root) that contains both is
  `e`'s **routing scope** `S`. In `S`'s view, each endpoint is replaced by its **representative**:
  itself if `S`'s engine places it (C3), else the outermost boundary below `S` that contains it.
  An edge whose two ends lie directly in `S`'s layer is not lifted and is exactly today's edge.
  *This is DD-12 N25's lifting, done once by the host for every engine.*
- **C15. Under a parent whose engine leaves an edge unrouted, the host draws it end to end.** The
  lifted edge is in the parent's view (so `tree`'s forest sees it, N25), but when the parent's
  engine returns no route for it, the per-scope `routeStraight` skips it. After composition, one
  `routeStraight` over the full graph draws it from the real source to the real target, clipped at
  both shapes, with its arrowhead reserved. *Byte-identical to today's `grid` drawing of a nested
  edge.*

### 4.3 Boundary ports and legs

- **C16. For a lifted end under an engine that routes and declares `ports: true`, the host places
  a port on the box's frame before the parent runs.** The rule, for a lifted end whose real
  endpoint `v` lies inside box `B`:
  1. **Preferred side.** If the edge names a port of `v` (`api[out]`), that port's side. Otherwise
     the flow side of the parent's `direction` (for `down`, south for an edge leaving `B` and north
     for one entering it; likewise for the other three).
  2. **Point.** `v`'s centre projected onto that side, clamped to at least 8 px from either corner.
  3. **Leg.** The perpendicular segment from the point to `v`'s shape (`anchorPoint`, or `v`'s
     port point).
  4. **Blocked** if the leg crosses (frames shrunk 0.5 px) any frame inside `B` that is not an
     ancestor of `v`, or `B`'s title text box. Then try the other sides, nearest to `v` first
     (ties: north, east, south, west); the first clear one wins. If none is clear, the preferred
     side.
  5. **Spread.** Ports on one side closer than 8 px are spread 8 px apart, in `graph.edges` order.

  *The leg is short and axis-aligned, and it never crosses a sibling or the title unless every side
  would. It needs only `+ − × ÷` and comparisons: `bitwise`.* In spec §9 under `direction: right`,
  `bff -> api` enters `payments` on its west side level with `api`; `api -> psp` would leave east,
  but that leg crosses `ledger`, so it leaves west too, and `elk` routes round the box.
- **C17. The port reaches the engine through `LayoutInput.portPositions?`**:
  `Readonly<Record<NodeId, Readonly<Record<string, { side; offset }>>>>`, `offset` in px from the
  side's start. Optional and additive (C34). The box also gets a `PortSpec` for it in its view, with
  an id no document can write (a prefix outside SGL's key syntax, pinned by a test). `elk` maps a
  node with positioned ports to `elk.portConstraints: FIXED_POS` and the port's `x`/`y`
  (~0.1 kB). `fixed` could honour it in `placePorts`, but never needs to: its routing is the host's
  (C15). *A side alone lets ELK slide the port along the side, which makes the leg diagonal.*
- **C18. Under an engine that routes but has no ports (`tree`'s elbows), there is no port.** The
  leg starts where the parent's route ends on the box's frame and runs straight to `v`'s shape.
- **C19. The composed route is the parent's route plus the leg**, joined at the port point (and
  for an edge lifted at both ends, a leg at each end). `start`/`end` and their normals are taken
  from the joined route's ends. One `EdgeLayout` per edge, as today.
- **C20. Arrowheads are reserved only at real ends.** In the parent's view, a lifted end is given no
  arrowhead (`directed` is rewritten: `forward` lifted at its head becomes `none`, `both` becomes
  `forward` or `backward`), so `finishEngineRoutes` does not pull back the route at the box; the leg
  gets the reserve (DD-06 §4.4). The ranking still reads `from → to` (DD-06 §6.1: `none` is passed
  as directed).
- **C21. Labels.** The routing scope's engine places a lifted edge's label (`elk` on its outside
  route; the host's `placeLabels` for a `labelPlacement: false` parent). An edge drawn end to end
  (C15) is labelled after composition by `placeLabels` restricted to those edges (it takes an
  optional edge filter).
- **C22. A box's own `@ports` belong to its parent's engine.** Edges from outside to `payments[in]`
  reach the port the parent placed. In the box's own view the scope node has no ports; an edge from
  inside the box to one of the box's own ports is joined like a crossing edge (its inner route ends
  on the box's frame, and a leg runs to the port point). *One placement per port; rare, and one
  fixture covers it.*

---

## 5. The host pipeline

### 5.1 One request, composed in the worker

- **C23. The whole composition runs in the worker, in one request.** `'layout'` gains an optional
  `plan` (C8's `scopes`). `worker-runtime.ts` passes a request with a non-empty plan to
  `composeLayout` (`@sgl/layout-api/compose`), which:
  1. builds the boundary tree from the plan (visible scopes with visible children);
  2. for each boundary in post-order (reverse `graph.order`), builds its **view** (C24), places
     boundary ports on its inner boxes (C16), runs its engine with `scope` = the boundary and the
     plan's options, applies `applyHostFallbacks` to the view, checks the result with
     `describeShapeError` and `validateResult` against the view, and stores it translated so that
     the boundary's frame starts at `(0, 0)`;
  3. runs the root's engine on the root's view, the same way;
  4. translates each box's stored result by the box's frame origin in its parent, pre-order, and
     merges nodes, edges, labels and notes;
  5. joins the lifted edges (C19) and routes the end-to-end ones (C15);
  6. returns one raw `LayoutResult`, which `host.ts` validates against the full graph and quantizes
     as today.

  A request with no plan takes today's path unchanged. *Many requests (one per boundary) would
  fight the host's one-request-in-flight rule (DD-06 §3: each `run()` aborts the last), clone the
  input once per boundary, and put the orchestration on the main thread. The worker already has
  every engine and the fallbacks.*
- **C24. A view is a `LayoutInput` for one scope.** Its graph holds the scope node (or the root's
  layer), every node the scope's engine places, and each inner boundary as a **leaf**:
  `children: []`, `labelId: null` (its title is its own engine's, already placed), its author ports
  plus its boundary ports, its `config` (so its `@pin` and hints reach the parent). Its sizing is
  `fixed` = `intrinsic` = the box's size, with `contentInset` and `padding` those of a leaf. Its
  edges are those whose routing scope is this one (C14), lifted. `graph.order` is filtered in
  place, so traversal stays deterministic. *Engines see an ordinary graph; nothing in them changes.*
- **C25. `LayoutHost.run()` gains an optional last parameter, `plan?: LayoutPlan`.** It is the
  app-to-host interface, not the engine contract; B17's iframe host implements the same thing.

### 5.2 Timeouts, abort, failures

- **C26. One clock per request, as today; its length is the longest timeout of any engine in the
  plan** (the root's included): 10 s if `elk` is anywhere, else 2 s (5 s for `tree`/`radial`,
  DD-12 N37). A timeout terminates the worker and gives `SGL4001` and the previous layout, as today.
- **C27. The composer checks `ctx.signal` between scopes.** A superseded request with many boxes
  then stops at the next boundary instead of running every ELK call; the 250 ms escalation
  (DD-06 §3) still covers a single long ELK run.
- **C28. A boundary whose engine fails is laid out by its parent's engine instead.** "Fails" means
  it throws (including a lazy chunk that will not load), returns a shape `describeShapeError`
  refuses, or returns a result `validateResult` rejects (`SGL4002`) against its view. The boundary
  is dissolved: its layer joins its parent's view, and its own inner boundaries stay boundaries. The
  composer adds one note, **`SGL4013`** (warning) at the container's `@layout` `engine` key (as
  `SGL4012`'s is; the plan carries the key's span, and the container's span is used only when there
  is no key; orchestrator decision, `feat/b8-compose` fix round 1): "Layout engine `{id}`
  failed for `{node}` ({detail}); it is laid out by `{parent}` instead." `detail` goes through
  `workerText`. `{parent}` is the engine that really lays the box out: its nearest enclosing
  boundary that did not fail too, or the root's. A box its parent's engine places at another size
  than its own engine gave it (more than 1/64 px off) fails the same way, with the detail "resized
  by its parent's engine", and the parent is run again without it: a box is never drawn at a size
  its parent did not place (fix round 1). A failure of the root's engine is today's `SGL4011`/`SGL4002`, and the previous
  layout stays. *Degrade to what the document would do without the key: the diagram still draws,
  and the squiggle says why.* §13 ⚑6. **Human decision 2026-09-28: accepted.**
- **C29. Notes from every scope are merged in scope order**, then `engineNotes` applies the one
  `MAX_ENGINE_NOTES` cap and `SGL4022` to the whole request (DD-06 §3). A sub-result's `SGL4003`
  from its view's validation is dropped; the full validation in `host.ts` reports it once.

### 5.3 Determinism

- **C30. A composed layout is as reproducible as its least reproducible engine** (ADR-0004's order:
  `bitwise`, `quantized`, `best-effort`). The render cache and the cross-environment test use that
  class. No v1.0 engine is `best-effort` (DD-12 H3).
- **C31. A `quantized` sub-result is snapped to the 1/64 grid before its size reaches its parent**;
  a `bitwise` one is composed raw. *Snapping makes the parent's input identical on every platform,
  so a `bitwise` parent over an `elk` box stays reproducible, and translating grid values by a grid
  offset is exact. Composing `bitwise` results raw keeps the sums in today's order, so a `grid` box
  in a `grid` document gives today's bytes.* The one caveat is ADR-0004's amendment item 2 (a value
  within one ulp of a 1/128 boundary), now once per box.
- Every traversal is iterative (DD-12 N28) and ordered by `graph.order`. The composer reads no
  clock and no `ctx.random`.

### 5.4 Caching per subtree, and F23

- **C32. A per-subtree cache in the worker, in its own branch, after measuring.** Key: engine id,
  the options' JSON and the view's JSON, spans included only when the stored result has notes
  (spans only matter to notes, as the pipeline's skip already reasons, DD-08 §3). Value: the stored
  sub-result. Keep what the last two requests used (the A9 import cache's rule). *On a keystroke
  outside an `elk` box in a `grid` document, the box is not laid out again. A `grid` box costs
  about a millisecond, so the cache pays only for `elk` boxes; it is not worth its bytes until a
  bench shows it.* **F23** is the main-thread cost of compiling many imported nodes on every
  keystroke. This cache is its layout-side counterpart and does not fix it; the two meet if F23's
  remedy keeps a graft across keystrokes, because an unchanged graft gives an unchanged view.

---

## 6. The engine contract

- **C33. ⚑ Per-container engines are composed by the host. `ctx.sublayout` stays reserved.**
  ADR-0002 §3 and Architecture §4.2/§4.4 make an engine delegate a container through
  `ctx.sublayout`. Host composition is better for B8: every engine gets nesting with no code (a
  60-line engine included, ADR-0002's point), and determinism, failure, timeouts and caching live
  in one place. `ctx.sublayout` stays in the type, still rejecting, for engine-initiated delegation
  (B9, still Could), which B8 no longer needs. ADR-0002 is amended. §13 ⚑5. **Human decision 2026-09-28: accepted.**
  The amendment is ADR-0002's "Amendment 2026-09-28" section.
- **C34. No new capability. `apiVersion` stays 1.** A `nested?` capability was considered and is
  not needed: the inner role only needs `scope`, which is in the contract since v1 ("`null` = the
  whole document"), and the outer role sees ordinary leaves. The one addition,
  `LayoutInput.portPositions?`, is optional and a hint: an engine that ignores it still draws, and
  the composer joins the leg from wherever the port landed.
- **C35. Conformance gains check 7, "honours `scope`".** For each corpus container, run with
  `scope` = that container on its view: the result places exactly the view's nodes, the scope's
  frame included. An engine that fails it degrades (C28) wherever a document names it on a
  container. B18's guide says so. *This is what makes a third-party engine safe to name on a
  container.*
- **C36. The protocol change is internal** (`'layout'.plan`, optional), and so is C25's.
- **C37. `EngineCapabilities.containers` stays unread.** Every engine declares `true`. It could
  later mean "may be named only on leaf layers", but nothing needs that now (§15 item 4).

---

## 7. Interactions

- **C38. `elk`'s `INCLUDE_CHILDREN` is unchanged inside one scope.** An `elk` scope's plain
  containers are still one ELK run with hierarchy-crossing edges. Only a boundary splits a run. An
  `elk` box in an `elk` document is a second ELK call with its own direction (C2), and an edge into
  it goes through §4. ELK is reported not to honour a per-container `elk.direction` under
  `INCLUDE_CHILDREN`; branch 3's spike records whether that is so. Either way C2 does not depend on
  it.
- **C39. F16's title detour needs nothing new.** In the parent's view a box is a leaf with no
  title, so ELK never routes through the box's title; the port rule (C16 step 4) keeps legs out of
  it. Inside an `elk` box, `avoidTitle` works on that run's own edges, as today. `titleCrossings`
  runs on the composed result, so a leg through a title would be counted. **Branch 1's known state:**
  with crossing edges straight end to end (§11.1 deviation 1), such an edge can cross a sibling's
  frame or a box's title (in the goldens, `storefront.bff -> payments.api` crosses
  `payments.ledger`, and `client -> rack.top` crosses `rack`'s title); branch 3's ports and legs
  fix it.
- **C40. Conformance** (DD-06 §8). `runHostSequence` takes an optional plan, so the suite runs what
  a request runs. Checks 1–6 run on the composed result: check 3 compares siblings as today (a box
  is a node with a frame), check 6 checks that each lifted edge ends at its real endpoint. Check 7
  is C35. The K4 hierarchy-crossing count includes legs.
- **C41. The renderer is unchanged.** `LayoutResult` has the same shape and every node its frame;
  nesting and z-order come from the graph, as today. Export, accessibility and the canvas's
  hit-testing read the same fields.
- **C42. The paint-only path is unchanged.** A theme pick does not lay out (DD-08 §10).
- **C43. The pipeline's skip key includes the plan** (DD-08 §3's `optionsKey` beside it), so a
  change to a container's engine or options lays out again, and nothing else does.
- **C44. Engine ▾ and the F11 form stay root-only.** A container's engine and options are edited in
  the text, which is the source of truth; the help documents them. Engine ▾ keeps its badge for the
  root engine. *A per-container picker needs a selection model the app does not have.* Orchestrator
  call; reversible.
- **C45. The help changes in the implementing branch (DD-13 P21).** `key/layout.md` loses "A
  container cannot change the engine" and gains a container section with a proved example (spec
  §9's `payments`, and a `fixed` box in an `elk` document). `key/direction.md` says C9. The
  `SGL4010` entry changes its wording; `SGL4012` and `SGL4013` get entries (HD4: an example for
  `SGL4012`; `SGL4013` joins the codes no document can cause). The help's example harness runs
  plans because it runs the app's pipeline (P18). `help-drift.test.ts` fails until this is done.
- **C46. The render-svg harness honours container engines** it registers (`grid`, `fixed`), so
  `layout/nested-engine.sgl` (a box naming `sgl.elk`) needs `elk` in the harness or a new header.
  Recommended: the fixture becomes `layout/engine-unknown.sgl`'s sibling with `engine: grid`, and
  the `SGL4010` coverage moves to `layout/unknown-key.sgl`, which already emits it.

---

## 8. Size and performance

### 8.1 Boot cost

Estimates, gzipped and marginal, from the measured sizes of like code (`fixed` in the worker
1.00 kB; `rootLayoutOptions` 0.31 kB; one catalogue row ~0.08 kB on the page).

| Item | Page (boot) | Worker (boot) | Lazy `compose` chunk (worker) |
|---|---|---|---|
| `layoutPlan`; scope-aware `layoutConfigDiagnostics` | 0.30 | — | — |
| Two catalogue rows (`SGL4012`, `SGL4013`) | 0.16 | — | — |
| `run(plan)`, the plan's timeout, the skip key | 0.05 | — | — |
| The worker's check and dynamic import of `compose` | — | 0.08 | — |
| `elk`'s `FIXED_POS` ports | — | 0.10 | — |
| Views, lifting, post-order runs, degrade, translate and merge | — | — | 1.2–1.6 |
| Boundary ports, legs, arrow and label rules | — | — | 0.5 |
| **Total** | **~0.5** | **~0.2** | **~1.7–2.1** |

- **C47. ⚑ The composer is a lazy chunk inside the worker, `compose-*.js`**, loaded on the first
  request with a plan, like `std-trees` (DD-12 N52): a `manualChunks` rule, a `.size-limit.js`
  exclusion, a `check-core-chunks.mjs` check (not reachable from the entry, nor statically from
  the worker), an offline e2e case. Boot cost **~0.5–0.7 kB**. All static would be ~2.3–2.8 kB,
  which does not fit. Stage L's forecast with it: 179.50 (after `fix/root-layout-options`) + ~1.3
  (`tree`, `radial`) + ~0.4 (Help button) + ~0.65 (B8) ≈ **181.85 kB**, now **of 184**. §13 ⚑7.
  **Human decision 2026-09-28: accepted.** The composer is lazy, and the core limit is raised to **184 kB** (hard
  ceiling 300 kB unchanged; committed on `main` at `90689df`). The branch measures its real cost
  and stops if it exceeds its line by more than 50% (DD-12 §11's rule).

### 8.2 Time

Measured so far (DD-06 §8, 07 §2.1 F15, Node): `elk` 1 000 nodes ≈ 0.84 s, n2000 ≈ 1.9 s warm /
3.8 s cold; `grid` 1 000 nodes ≈ 13 ms. The budget is < 3 s for the whole pipeline at 2 000 nodes
(DD-09 §2). `n2000` is 200 containers of 10, chained. Estimates, to be measured by branch 2's bench:

| Document (2 000 nodes) | What runs | Estimate |
|---|---|---|
| `elk` root, every container `engine: grid` | 200 `grid` runs (~0.1 ms each); one ELK run over 200 boxes and 199 edges | **~0.2–0.4 s**: several times faster than `elk` alone. Mixed engines are a remedy for F15 as much as a cost |
| `grid` root, every container `engine: elk` | 200 ELK runs of 10 nodes; ELK's per-call overhead is unmeasured, assumed 2–5 ms warm | **~0.4–1.0 s** warm, plus elkjs's cold load once |
| `elk` root, every container `engine: elk` | 201 ELK runs | **~0.6–1.3 s** |
| No boundary | today's path, no composer loaded | unchanged |

- **C48. The composer's own cost is linear**: views, lifting (O(edges × depth)) and translation are a
  few ms at 2 000 nodes, off the keystroke path (the layout effect runs from the debounce timer).
- **C49. No cap on the number of boundaries.** The request's timeout already bounds the author's own
  CPU (DD-09 §1), and C27 stops a superseded request between scopes. The bench gains
  `scaleDocument(n, { boxes: 'grid' | 'elk' })` variants; if 200 ELK boxes miss the budget, the
  answer is C32's cache, not a cap.

---

## 9. Diagnostics

| Code | Severity | Message | Emitted by |
|---|---|---|---|
| `SGL4010` | warning | unchanged | no longer for a container's `engine`; a boundary's keys as the root's (C6); a plain container's keys against hints only (C9) |
| `SGL4012` | warning | Layout engine `{name}` is not available; `{node}` is laid out by `{id}`. | `layoutPlan`, main thread, at the key (C12). Fixture: `corpus/layout/engine-unknown.sgl` |
| `SGL4013` | warning | Layout engine `{id}` failed for `{node}` ({detail}); it is laid out by `{parent}` instead. | the composer, as a note (C28). No document can cause it with the built-in engines; it joins `SGL4001`/`SGL4002`/`SGL4011` in `NOT_YET_REACHABLE`, and a stub-engine test covers it. **Implemented by branch 1** (§11.1) |
| `SGL4021` | warning | unchanged | judged by the engine that places the node (C10) |

---

## 10. Tests

1. **Units** (`layout-api/test/compose.test.ts`, Node): a view (a box is a leaf of its size, no
   title, its ports and config); lifting (routing scope, representatives, `directed` rewrite); the
   port rule (each side, blocked legs, the title, spreading, a named inner port); leg joining and
   the arrow reserve at real ends only; translation exactness; degrade on a throw, a bad shape and
   an `SGL4002`, with `SGL4013`; notes merged and capped; abort between scopes; a hidden boundary;
   a box's own ports (C22); a self-loop on a box; an edge between two boxes; an edge from inside a
   box to the box itself.
2. **Goldens** (`layout-api/test/__goldens__/composed/`, through `runHostSequence` with a plan):
   new fixtures `corpus/layout/engine-*.sgl`: `grid-in-elk` (spec §9 is `checkout.sgl`),
   `elk-in-grid`, `fixed-in-elk` (pins honoured inside, `SGL4021` on the box under `elk`),
   `three-levels` (`grid` in `elk` in `fixed`), `same-engine` (an `elk` box with `direction: right`
   in a `down` document), `crossing` (in, out, box to box, ports), `options-inherit` (C6),
   `direction-hint` (C9's `SGL4010`), `unknown` (`SGL4012`). **The engine goldens do not change**:
   they call the engines directly with the full input. The render goldens should not change either
   (C31: a `grid` box in a `grid` document composes to today's bytes); branch 2 proves it.
3. **Conformance** (C35, C40): check 7 for `grid`, `fixed` and `elk` over every corpus container;
   checks 1–6 over the `engine-*` fixtures and a 1 000-node mixed graph.
4. **Determinism**: a double run, raw and quantized, of every `engine-*` fixture in Node; a real
   Chromium worker equals Node for `grid-in-elk` and `elk-in-grid` (the `grid.browser.test.ts`
   pattern); a `bitwise`-only plan (`grid` in `fixed`) compared raw.
5. **Pipeline** (`apps/web/test/pipeline.test.ts`): the plan reaches `run()`; the skip key changes
   with a container's engine or option and not otherwise; the timeout is the plan's longest;
   `SGL4012` and C9's `SGL4010` at their keys; `SGL4013` from a stub engine through the real host.
6. **E2E**: spec §9 (`checkout.sgl`) under `elk` shows **no diagnostics**, and `payments`' three
   nodes are in a two-column grid (the frames' x and y); `bff -> payments.api` and
   `payments.api -> psp` end on `api`'s outline; a `fixed` box in an `elk` document keeps its pins;
   removing `engine: grid` restores today's picture; offline, a document with a plan renders (the
   lazy `compose` chunk is precached); `pnpm size` and `check-core-chunks.mjs` are green.
7. **Help** (P17–P19): the new prose and examples pass `help-drift` and `help-examples`.
8. **Bench**: the three §8.2 variants in the Gate 4 bench, reported with F15's browser measurement.

---

## 11. Implementation plan

Each branch is from `main`, has its own gate, is reviewed, and merges `--no-ff` before the next
begins. Prerequisite: `fix/root-layout-options` is on `main`. B8 does not depend on `tree` or
`radial`, and they do not depend on it; F29 puts B8 first.

1. **`feat/b8-compose`** (`@sgl/layout-api` only; no app change, nothing user-visible, no boot
   cost). `compose.ts` as its own entry (`@sgl/layout-api/compose`): views, lifting, the post-order
   runs, translate and merge, degrade with `SGL4013` (its row lands here, with its stub-engine
   test), notes; crossing edges end to end only (C15, option (a) everywhere). `runHostSequence`
   takes a plan; conformance check 7. Units, composed goldens, determinism, conformance. ~3 days.
2. **`feat/b8-wire`** (the user-visible branch). `layoutPlan` and scope-aware
   `layoutConfigDiagnostics` (C6, C9–C12) with `SGL4012` and its fixture; `'layout'.plan`,
   `run(plan)`, the plan's timeout, the skip key; the lazy `compose` chunk (manualChunks,
   `.size-limit.js`, `check-core-chunks.mjs`, offline case); the render-svg harness and the
   `engine-*` fixtures; `nested-engine.sgl` (C46); the help (C45); the §8.2 bench variants; e2e
   including spec §9 with no diagnostics. DD-06, DD-08, 07. **Also the code comments and the
   corpus header that still say per-container engines are "B8/B9" or unimplemented** (§15 item 6;
   left for the code branches, not changed on this design branch): `corpus/layout/nested-engine.sgl`'s
   header (with C46), `packages/layout-api/src/layout-config.ts`'s module comment (lines 10–11),
   `packages/layout-api/test/layout-config.test.ts`'s header comment (line 7), and
   `apps/web/src/state/pipeline.ts`'s comment at the `layoutConfigDiagnostics` call (line 562). The
   help's `key/layout.md` and `key/direction.md` (C45). After this branch, B8 works and F29 is
   cleared, with straight crossing edges. ~3–4 days.
3. **`feat/b8-ports`**. First commit: a spike recording what ELK does with `FIXED_POS` ports on a
   leaf under `INCLUDE_CHILDREN`, and with a per-container `elk.direction` (C38). Then
   `LayoutInput.portPositions`, `elk`'s mapping, the port rule, legs, the arrow and label rules
   (C16–C22). The composed `grid-in-elk` and `crossing` goldens change here, and only they. If the
   spike fails, C13's fallback. ~2–3 days.
4. **`perf/b8-cache`** (only if branch 2's bench shows `elk` boxes cost what C49 fears). C32's
   cache, with a keystroke bench. ~1–2 days.

ADR-0002's amendment (C33) and the Architecture §4.2/§4.4 notes were made on this design branch
once the human approved them (§14), and so was spec §4's text (§3.8).

### 11.1 Branch 1 as built (`feat/b8-compose`, from `main` at `44f50d0`)

**What exists.** `packages/layout-api/src/compose.ts`, its own entry `@sgl/layout-api/compose`
(`package.json` exports, `tsdown.config.ts`); nothing in `apps/web` imports it.

- `composeLayout(root, input, options, plan, engines, ctx)`: C23 steps 1–6 for one request. `root`
  is the document's engine and `options` its bag; `engines` looks an id up (the worker's
  registry); `ctx` is the request's, its `options` replaced per scope and its `signal` checked
  before every scope (C27). It returns one raw `LayoutResult`; the caller validates and quantizes.
- `layoutView(input, scope, boxes)`: C24's view. The types `LayoutScope` `{ node, engine, options }`
  and `LayoutPlan` (C8) are here too, for branch 2's `layoutPlan` and protocol.
- `SGL4013` is a `LAYOUT_CATALOGUE` row (warning, C28's template), in `NOT_YET_REACHABLE`
  (`core/test/diagnostics-coverage.test.ts`) and `corpus/README.md`'s "Not yet covered".
- Conformance (`conformance.ts`): `runHostSequence(…, compose?)` takes `{ plan, engines }` (C40);
  `ConformanceCase.plan` and `ConformanceOptions.engines` run a case as a request with that plan,
  with check 3's pin exemption asking the engine that placed the node (C10); **check 7** (C35),
  `scopeProblem`, runs on every container of every case without a plan, by default
  (`ConformanceOptions.scopes: false` turns it off). `grid`, `fixed` and `elk` pass it over the
  corpus and the 1 000-node graph.
- Tests: `layout-api/test/compose.test.ts` (34 units after fix round 1, stub engines: the views, the edge rules,
  translation and snapping, crossing edges, notes, degrade on a throw, a bad shape, `SGL4002` and
  an unregistered id with `SGL4013`, a nested box surviving its parent's failure, the root's
  failure, abort between scopes, hidden boxes, the plan in `runHostSequence` and
  `runConformance`, check 7 failing three ways); `layout-elk/test/compose.test.ts` (six composed
  goldens, double runs, checks 1–6, the 1 000-node mixed graph, and C31 over the corpus). No
  existing golden changed. Boot: **+33 B**, the catalogue row alone (179 604 → 179 637 B); the
  composer is on no boot path.

**Deviations.**

1. **Crossing edges are in no view** (C13's option (a) as written: "the parent never sees the
   edge"), rather than C15's lifted edge in the parent's view with its route discarded. Under an
   `elk` parent a crossing edge therefore plays no part in ranking yet (in `checkout.sgl`, `psp`
   lands above `payments`); branch 3's lift and ports change that, and its goldens with it. An edge
   into a box's own port from inside the box (C22) is drawn end to end too, to the point its parent
   placed, until branch 3's leg. A straight crossing edge can also cut through a sibling's frame or
   a box's title: `storefront.bff -> payments.api` crosses `payments.ledger` in the `grid-in-elk`
   golden, and `client -> rack.top` crosses `rack`'s title in `fixed-in-elk`. That is branch 1's
   known state (C39), fixed by branch 3's ports.
2. **The goldens are in `layout-elk/test/__goldens__/composed/`**, not `layout-api`'s:
   `@sgl/layout-api` may not depend on the engines, and `layout-elk`'s tests already have all
   three. The fixtures are inline in the test, not `corpus/layout/engine-*.sgl`: until branch 2,
   the corpus harnesses lay a document out with one engine and would warn `SGL4010` on each.
   The plan is built in the test from each container's `@layout.engine` (C8 without C6's
   inheritance, which is `layoutPlan`'s).
3. **`tree` is not on `main`** (`feat/b5-tree` is unmerged), so there is no `tree`-in-`grid`
   golden and no check 7 for `tree`. Whichever of the two branches merges second adds both: the
   conformance suite runs check 7 by default, so `tree`'s existing suite will run it.
4. **C31 holds for every coordinate, not every byte.** A `grid` box in a `grid` document composes
   to `grid`'s own quantized result except in `startNormal`/`endNormal`, which `quantize` does not
   touch: an edge inside a box is routed in the box's coordinates, so its unit normal can differ
   in the last bits (4e-16 in `wildcards.sgl`). `layout-elk/test/compose.test.ts` checks both. The
   render goldens (branch 2) should not see it; if they do, round the normals in `quantize`.
5. **One canonical order** (not in the design): the composed result lists nodes in `graph.order`,
   edges in `graph.edges` order and labels by id (`placeLabels`' own order), whichever scope
   placed them, so C31's comparison holds and a result never depends on the plan's shape.
6. **Small choices C24/C28 left open.** A box's leaf `contentInset` and `padding` are both its own
   `contentInset`. A self-loop on a box is its parent's edge (the box's outside); an edge from
   inside a box to the box itself is the box's. Hidden edges go in a view that holds both ends, as
   today, and are never drawn end to end. `SGL4013`'s `{detail}` is the thrown message, the shape
   check's text, "returned invalid geometry" (a view `validateResult` rejects; its own detail is
   not kept), or "not registered in this worker"; a dissolved box's own notes are dropped. An
   engine's own `AbortError` after the signal fired propagates rather than degrading the box.
7. **A box is sized from its frame only** (fix round 1, item 4; orchestrator decision: keep it).
   Content its engine puts outside the box's frame, such as a `fixed` child pinned at a negative
   offset, stays outside it and can overlap the box's siblings in the parent. This is what `fixed`
   alone does, where the author gets `SGL4003`; the composed result gets the same `SGL4003` from
   the host's validation (`layout-elk/test/compose.test.ts`).

**Fix round 1** (orchestrator review; no blocker). `{parent}` is resolved after every box has run,
from the boundaries still standing (it named a boundary that later failed itself); `SGL4013` is at
the `engine` key (`LayoutScope.span`); a box its parent resized is dissolved and the parent run
again; `ctx.signal` is also checked after the root's engine; check 7 is stronger (DD-06 §8): inner
containers are boxes of an odd fixed size that must be kept, and a second run on the whole graph
with `scope` set tells a scoped layout from one that ignores `scope`. New unit tests pin a
crossing edge to a box's own port, the `assigned` rule and the label order.

---

## 12. Changes to other documents (made by the implementing branches)

- **Language spec** §4, **ADR-0002**, **Architecture** §4.2/§4.4 and **04**'s B8/B9 rows: done on
  this branch after the human's decisions (§14).
- **DD-06**: §2 (the plan, `portPositions`, `scope` is load-bearing), §3 (`plan` in the protocol,
  the timeout, the lazy chunk), §4 (the composed sequence), §6.1 (`FIXED_POS`), §8 (check 7, plans),
  §9 (`SGL4010`'s scope, `SGL4012`, `SGL4013`).
- **DD-08**: §3 (the skip key), §10 (pickers root-only, C44).
- **DD-09** §2: the mixed-engine bench rows. **DD-10** §2: the `compose` chunk.
- **DD-13**: §13's note that B8 merged second and wrote the help (P21).
- **07**: §2's paragraphs, §2.1 F29 cleared by branch 2, the Stage L row.

---

## 13. ⚑ Decisions for the human (all accepted, 2026-09-28)

**⚑1 (C2): does a container that names the same engine as its parent get its own layout?**
**Human decision 2026-09-28: accepted.** (a): a container naming an engine always gets its own layout, even the same
engine as its parent's.

| Option | For | Against |
|---|---|---|
| **(a) Yes, always a boundary. Recommended** | The key means one thing everywhere; the only way to give an `elk` container its own direction | An `elk` box in an `elk` document is a second ELK run, and edges into it are drawn by §4, not ELK's own hierarchy |
| (b) Only when the engine differs; the same engine means hints | Crossing edges stay in one ELK run | A container cannot change `elk`'s direction; the same text means different things depending on the root |

**⚑2 (C6): where does a boundary's options come from?** **Human decision 2026-09-28: accepted.** (a): boundary
options work as root options do; an unset one inherits from the nearest enclosing container or root
using the same engine, otherwise the engine's default.

| Option | For | Against |
|---|---|---|
| **(a) Its own keys, as the root's; unset ones from the nearest enclosing scope using the same engine, else the engine's defaults. Recommended** | One rule shared with the root; a same-engine box keeps the document's feel | Moving a box into another box can change its spacing |
| (b) Its own keys; unset ones always the engine's defaults | Each box is self-contained | `engine: elk, direction: right` loses the toolbar's spacing |

**⚑3 (C9): keys on a container that names no engine (including `@direction`).** (a) **Hints for
the engine around it, checked against its hints only; an option-only key such as `@direction`
under `elk` becomes `SGL4010`, and the help says to name an engine. Recommended.** (b) An implicit
boundary with the inherited engine when a key needs one: no warning, but the edges change without
the author asking. (c) As today: accepted, no effect, no warning. **Human decision 2026-09-28: accepted.** (a): the
keys are hints to the surrounding engine, checked against its hints only; an ignored key is
`SGL4010`.

**⚑4 (C13): edges across a boundary.** (a) The host draws them straight, end to end, and the
parent never sees them. (b) **The parent's engine sees the edge lifted to the box and routes it to
a fixed port on the box; the host adds a short straight leg inside; under a parent whose engine
does not route (`grid`, `fixed`, `radial`), (a). Recommended, with (a) as the fallback.**
(c) ELK's own hierarchy, for `elk` in `elk` only; it throws on 10 corpus documents today.
(d) A host router across levels; several kB and research. **Human decision 2026-09-28: accepted.** (b), with (a) as the
fallback: under `elk` a fixed port on the box's side plus a host-drawn straight leg inside; under
`grid` and `fixed`, straight; the fallback is straight everywhere.

**⚑5 (C33): amend ADR-0002.** (a) **Per-container engines are composed by the host;
`ctx.sublayout` stays reserved for engine-initiated delegation (B9, Could). Recommended.**
(b) Build `ctx.sublayout` and have every engine delegate its boundaries itself: each engine needs
code for it, and a 60-line engine gets no nesting. **Human decision 2026-09-28: accepted.** (a): ADR-0002 is amended
(its "Amendment 2026-09-28" section); `ctx.sublayout` stays reserved for B9.

**⚑6 (C12, C28): two new warnings.** `SGL4012` "Layout engine `{name}` is not available; `{node}`
is laid out by `{id}`." and `SGL4013` "Layout engine `{id}` failed for `{node}` ({detail}); it is
laid out by `{parent}` instead." **Recommended: allocate both, and degrade a failed or unknown
container engine to its parent's engine.** The alternative is to fail the whole layout as the
root does (`SGL4011`), which blanks a diagram for one box's failure. **Human decision 2026-09-28: accepted.** `SGL4012`
and `SGL4013` are approved, and an unknown or failed container engine degrades to its parent's.

**⚑7 (C47): the budget.** (a) **The composer in a lazy worker chunk: ~0.5–0.7 kB at boot. Stage
L's forecast is then ~181.85 of 182 kB. Recommended.** (b) All static: ~2.3–2.8 kB, which needs the
limit raised to about 184 kB. Either way, the remaining Stage L work (the Help drawer, F-rows) has
almost no room left; a decision on the limit for the rest of Stage L may be wanted now.
**Human decision 2026-09-28: accepted.** (a), and more: the composer lives in a lazy chunk in the worker, **and** the core
bundle limit is raised to **184 kB** for the rest of Stage L (committed on `main` at `90689df`;
DD-09 §2).

**⚑8 (§3.8): the spec text.** Spec §2 and §9 already promise a container's own engine; §4 does not
say what it means. **Recommended: add §3.8's row text and paragraph, in branch 2.** **Human decision 2026-09-28: accepted.**
§3.8's text is approved, and was applied to spec §4 on this branch (§14).

---

## 14. Factual fixes made in other documents on this branch

1. **DD-00 §1**: the DD-12 row said "Design only"; `fixed` and `@pin` are implemented (branches 1
   and 2). The DD-13 row said "Design only"; help branches 1 and 2 are implemented. Both corrected;
   a DD-14 row is added.
2. **07 §2**: a paragraph for this design branch, then one for the decisions; §2.1 F29's owner
   points here and at `feat/b8-compose` and `feat/b8-wire`.

After the human's decisions (2026-09-28), also on this branch:

3. **Spec §4**: §3.8's approved row text and paragraph (⚑8). §9's worked example is unchanged: the
   human kept it on purpose, and B8 makes it render with no diagnostics.
4. **ADR-0002**: an "Amendment 2026-09-28" section (⚑5, C33). **Architecture** §4.2 (the
   `sublayout` comment, and the `pin` comment, §15 item 5), §4.4 (the RPC arrow), §4.5's `layered`
   note and §12's phase-1 obligation. **04**: the B8 row (Should, F29), the B9 row, the triage
   note's §3 and §8, and the outcome's amendments (§15 items 1 and 3). **DD-12** N2's third reason
   (§15 item 1).
5. **DD-06** §2's amendment note and §9's `SGL4010` row, **DD-08** §3's example-document note and
   **07** §2's Stage K item 23: "until B8/B9" (§15 item 6). The code comments and the corpus header
   are left for branch 2 (§11).

---

## 15. Contradictions found while designing this

1. **ADR-0002 §3, Architecture §4.2 and §4.4, and 04's triage note (§3, "Keep the sublayout seam")
   say per-container engines work through `ctx.sublayout`**, and 04's B9 row calls it "the
   mechanism B8 needs". This design composes in the host and leaves `ctx.sublayout` reserved (⚑5).
   DD-12 N2's third reason ("`ctx.sublayout` returns geometry for that scope") names the same
   mechanism; its conclusion, that relative pins work in a box, holds either way. **Resolved on this
   branch** (⚑5 accepted; §14 item 4).
2. **A container's option keys are accepted and ignored with no warning.** `layoutConfigDiagnostics`
   checks a container's keys against options *and* hints (DD-06 §2's amendment says "a
   container's `@layout` keys are hints, so the hint schema counts too", and counts options as
   well), but `elk` reads only `portConstraints` and `priority` from a node, and `grid` only
   `columns`. Spec §4 says `@direction` on a container is sugar for `@layout.direction`; under
   `elk` it does nothing and says nothing (⚑3). **Resolved by ⚑3's decision**; the code is branch 2's
   (C9, C11).
3. **01 FR-Y9 is a Should; 04's B8 row is a Could** (04's triage demoted it, S→C), and F29
   now prioritises it in Stage L. The MoSCoW is the human's; this document does not change it.
   **Resolved:** the human's "build B8 sooner" (F29, 2026-09-27) makes B8 at least a Should; 04's
   row now says **Should** (human decision 2026-09-27, F29), agreeing with FR-Y9.
4. **`EngineCapabilities.containers` is declared by every engine and read by nothing.** The
   contract implies the host acts on `containers: false`; it does not (C37).
5. **Architecture §4.2's `GraphNode` sketch says of `pin`: "engines MUST honour".** DD-12 H4 made
   it a capability, and an engine without it warns (`SGL4021`). DD-06 §2 already records that the
   sketch is not the shipped type; the sentence is still misleading. **Fixed on this branch.**
6. **07 §2 (Stage K fix round 1, item 23) and DD-06 §9's `SGL4010` row say "until B8/B9"**, and
   `corpus/layout/nested-engine.sgl`'s header says the same. After B8 a container's engine works
   and B9 is not involved. **The two documents are fixed on this branch; the corpus header, and the
   code comments that say the same, are branch 2's** (§11, C46).
7. **The help's `key/layout.md` example "A container cannot change the engine"** (expecting
   `SGL4010` twice) becomes false with B8; branch 2 rewrites it (C45, P21).
