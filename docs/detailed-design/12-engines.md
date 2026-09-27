# DD-12 — The remaining engines: `fixed`, `tree`, `radial` (and `force`)

**Feature:** B5 (built-in `tree`, `radial`, `force`, `fixed` engines), Must. **Packages:**
`@sgl/layout-std` (the engines), `@sgl/layout-api` (engine diagnostics, one optional capability),
`@sgl/core` (the `@pin` registry row), `apps/web` (registration, pickers, options forms, the build).
**Inputs:** `LayoutInput` (DD-06 §2). **Outputs:** `LayoutResult`.

**Status: design only (2026-09-27), from `main` at `755bfd0`. No code is changed by this document.**
The decisions are numbered **N1–N52**. Each has a recommendation and a one-line reason in italics.
Decisions marked **⚑** go to the human before implementation starts; §15 gives each one's options.
Where this document changes a rule in DD-02, DD-06, DD-08, the language spec or an ADR, the change is
listed in §14 and made by the branch that implements it, not here. The one exception is §16's list of
factual fixes, made in this branch.

**Order (07 §5, Stage L):** `fixed` first, then `tree` and `radial`; `force` last, and it is the first
thing to cut. This document recommends cutting it (§10).

---

## 1. Summary

| Engine | Recommendation | Where it runs | Boot cost (estimate, gz) |
|---|---|---|---|
| `fixed` | In-house. Pins are relative to the parent's content box; unpinned nodes are packed below the pinned ones, with a warning; straight edges; ports on the frame | `@sgl/layout-std`, statically in the layout worker | ~1.9 kB |
| `tree` | In-house Buchheim–Walker (linear-time Reingold–Tilford), over a BFS spanning forest; elbow edges | `@sgl/layout-std`, a lazy `std-trees` chunk inside the worker | ~0.7 kB |
| `radial` | In-house wedge layout over the same spanning forest, with its own polynomial `sin`/`cos`, so it is `bitwise` | the same lazy chunk | ~0.6 kB |
| `force` | **Cut from v1.0** (move out of B5's Must, to Could beside B21) | — | 0 |

The core bundle is **175.99 of 182 kB** (measured on this branch: `pnpm build && pnpm size`), so
6.01 kB are left. The three engines together cost about **3.2 kB** of it (§11). Putting `tree` and
`radial` statically in the worker would cost about 3.5 kB more, which is over the headroom.

**No new dependency.** elkjs's `mrtree` and `radial` were tried and rejected (§9).

---

## 2. What is true today (found while designing this)

These facts shape the design. Each is also in §17 where it contradicts a document.

1. **`@pin` does nothing and says so.** `CONFIG_REGISTRY` (`packages/core/src/config-registry.ts`)
   has no `pin` row, so `@pin: { x: 10, y: 20 }` on a node is `SGL2010` ("Unknown configuration key
   … kept but has no effect in this version"). No engine reads `config.pin`: `grid` and `elk` ignore
   it. Language spec §4 says it is an "absolute position auto-layout must respect". B11 (pinning that
   auto-layout respects) is a **Should**, so this is not a Must gap for Gate 4. But the spec row
   promises more than any engine does (§17 item 2).
2. **An engine cannot report a problem in the document.** `LayoutResult.diagnostics` is in the
   contract (`contract.ts`), but `host.ts` returns only `validateResult`'s diagnostics and drops the
   engine's own. `ctx.log` is dropped too (`host.ts`, the `'log'` case). `fixed` needs to warn about
   unpinned nodes, so this needs a small change (§5).
3. **A document can name an engine only by its full id.** `documentEngineOverride`
   (`apps/web/src/state/overrides.ts`) passes `@layout.engine` through unchanged. So `engine: grid`
   (language spec §9) and `engine: "layered"` (spec §4 and §9, `corpus/checkout.sgl`) reach the
   worker as `grid` and `layered`. The worker registers neither, and answers `SGL4011` ("not
   registered in this worker"), with no layout. `layoutConfigDiagnostics`' `namesEngine` does accept
   `elk` for `sgl.elk`, so the two disagree. Users will type `engine: fixed`; §6 fixes this.
4. **The root's `@layout` options never reach an engine.** The pipeline sends only the Options ▾ bag
   (`optionsForEngine(engine, engineOptions)`). `corpus/checkout.sgl` says `@layout: { engine:
   "layered", direction: right }`. Under `elk` it is laid out `DOWN`: the elk input golden
   `checkout.sgl.json` has `"elk.direction": "DOWN"`. SGL4010 does not warn, because `direction` is
   an option `elk` declares. DD-06 §7 records only the `grid` `columns` case. This matters to `tree`,
   whose main option is `direction` (N40).
5. **The layout worker counts toward the core budget.** `.size-limit.js` counts every emitted JS/CSS
   file except the named lazy chunks, and the worker (`layout.worker-*.js`, 8.54 kB gz) is one of
   them. Engine code in the worker is therefore boot cost, as descriptors on the main thread are.
6. **The host moves the diagram.** `quantize` (DD-06 §5, F14) translates every result so that its
   content box, grown by the 16 px margin, starts at `(0, 0)`. A coordinate an engine returns is
   therefore relative to the rest of the diagram, never to the canvas. Pins are, too (N3).

---

## 3. `@pin`: the key

- **N1. `@pin: { x, y }` gives the top-left of the node's frame.** *It is the frame's own origin, the
  `NodeLayout.frame` convention, and what SVG, Excalidraw and draw.io use. A centre would keep a node
  centred when its label grows, but it makes E15's write-back and the "is it at x" check harder.*
  ⚑ (with N2, §15 ⚑2).
- **N2. ⚑ A pin is relative to the top-left of its parent's content box. At the root, it is
  relative to the diagram's origin.** The spec says "absolute" (§15 ⚑2 has both options). Relative is
  recommended for four reasons:
  - *Moving a container is one edit.* E15 (drag to pin) writes one `@pin`, not one per descendant.
  - *Imported subtrees keep their shape.* A9 grafts a library under `as:`. With absolute pins, a
    pinned library lands wherever its author drew it and overlaps the importer's nodes.
  - *B8/B9 need it.* Once a `fixed` container can sit inside an `elk` diagram (per-container
    engines), `ctx.sublayout` returns geometry for that scope. Only relative pins can be honoured
    there.
  - *The root is relative already.* The host re-origins every result (§2 item 6), so an "absolute"
    pin at the root means "relative to the other root pins" in any case.
- **N3. Pins survive the host's translation as offsets.** A diagram whose pins all start at `(500,
  500)` renders exactly as one starting at `(0, 0)`. E15 (Could) will need the translation to write a
  dragged position back. `quantize` computes it (`x0`, `y0`) and discards it. E15 should add it to
  `LayoutResult` (an optional `origin`); B5 does not need it.
- **N4. `@pin` gets a registry row: `{ key: 'pin', scope: ['node'], type: 'object' }`, with a
  sub-key check like `SIZE_KEYS`.** `x` and `y` are both required, each a number in `[−100 000,
  100 000]`. Otherwise the whole `@pin` is dropped with `SGL2011` ("`@pin` expects `{ x, y }` numbers
  within ±100 000"). Any other sub-key is `SGL2010` and kept. On an edge, a class or the root it is
  `SGL2012`. *All three codes already exist. The bound keeps `frame + padding` finite (a pin of
  `1e308` would make `SGL4002` reject the whole result) and keeps PNG export's 16 384 px cap
  meaningful. A class-level pin would put every member at the same place, so classes are
  excluded.* Variables work (`@pin: $origin`), because resolution runs first.
- **N5. A container may be pinned (N12).** The registry's `node` scope already covers containers.
  `@size` on a container stays `SGL2012`, so a container's size is always derived (N12).
- **N6. ⚑ Under an engine that does not honour pins, a `@pin` is a warning at the key: proposed
  `SGL4021` "`@pin` is not honoured by engine `{id}`; ignored."** It is computed on the main thread
  by `layoutConfigDiagnostics`, beside SGL4010, from the AST (so it has the key's span). The engine
  says whether it honours pins through a new optional capability, **`pins?: boolean`** (absent means
  `false`). *An optional field is additive, so `apiVersion` stays 1. The engine switch already writes
  `@layout.engine` into the document, so a pinned document switched to `elk` says `elk` and the
  warning is true. Without it, the pins look broken.* Nodes grafted by `@imports` have no AST in the
  document and are not checked: they cannot be edited from it anyway. §15 ⚑4.

**Proposed spec text (for the human; not applied).** Language spec §4, the `@pin` row:

> `@pin` | node | `{ x, y }`, in px: where the top-left of the node's frame goes, relative to the
> top-left of its parent container's content box (the root's: the diagram's origin). The `fixed`
> engine places the node there; other engines ignore it with a warning (`SGL40xx`). Both numbers
> are required, each within ±100 000.

---

## 4. `fixed`

### 4.1 Algorithm

- **N7. `fixed` is post-order over containers, like `grid` (DD-06 §7).** Each container's children
  are placed in the container's content coordinates. The container's size then follows from them. A
  pre-order pass makes frames absolute.

```
layoutContainer(c):                      // c = null for the root
  kids    = visible children of c, in declaration order
  pinned  = kids with a valid @pin;  loose = the rest
  for k in pinned:  rel[k] = (pin.x, pin.y);  size[k] = sizeOf(k)       // container: recursive
  // N9: the loose ones, packed as grid packs them, below the pinned ones
  top     = pinned empty ? 0 : max over pinned (rel.y + size.h) + gap
  left    = pinned empty ? 0 : min over pinned rel.x
  pack(loose, columns = ceil(sqrt(n)), gap, align = start) at (left, top)
  // N12: the content box runs from (0,0) to the far edge of every child
  contentW = max(0, max over kids (rel.x + size.w));  contentH likewise
  c.size   = { w: max(min.w, titleMinW, padding.l + contentW + padding.r),
               h: max(min.h,            padding.t + contentH + padding.b) }
sizeOf(leaf) = fixed ?? clamp(intrinsic, min, max)        // the rule grid and elk use
```

- **N8. A leaf is sized exactly as `grid` and `elk` size it.** `@pin` places a node and never sizes
  it. `@size` sizes it.

### 4.2 Nodes without a pin

- **N9. ⚑ An unpinned node is placed, not refused, and gets a warning: proposed `SGL4020`
  "`{node}` has no `@pin`; `fixed` placed it below the pinned nodes."** Its span is the node's.
  Loose siblings are packed as `grid` packs them (⌈√n⌉ columns, the `gap` option, aligned to the
  start), starting one `gap` below the lowest pinned sibling. With no pinned siblings, they start at
  the content origin. *A diagram that is half pinned still draws, and every loose node is flagged at
  its own line.* Architecture §4.5 says `fixed` "errors on unpinned nodes"; §15 ⚑1 weighs that option.
  - **(a) An error.** The whole result is refused, and the previous layout stays. Adding one node
    to a pinned diagram then shows nothing new until it has a pin: a bad loop for the escape hatch
    people ask for.
  - **(b) Placement plus a warning. Recommended.** Deterministic, cheap (it reuses `grid`'s packing,
    N10), and it cannot overlap a pinned sibling, because it starts below them all.
  - **(c) Delegate the loose nodes to another engine.** `ctx.sublayout` is reserved and not
    implemented (B9). Delegating to `elk` would load a 435 kB gz chunk to place a few boxes, and
    `elk` cannot keep pinned nodes where they are.
- **N10. `grid`'s packing is factored into a shared helper, `packCells(sizes, cols, gap, align)`
  (`layout-std/src/pack.ts`), used by both engines.** *The same arithmetic, written once. `grid`'s
  output must not change, and its goldens prove it.*
- **N11. Severity: warning, one per loose node.** Switching a 40-node document to `fixed` therefore
  shows 40 warnings. *That is the true state of the document, and each squiggle points at a line to
  fix. An `info` would hide it from the status chip's count.* The orchestrator may lower it to `info`
  if review finds it noisy. The code number is the human's to approve (⚑5).

### 4.3 Containers

- **N12. A container's frame comes from its pin (or from packing, if it has none). Its size always
  comes from its children.** The content box runs from the content origin `(0, 0)` to the far edge of
  every child, plus padding (the title band included). Its minimum width is the title's width plus
  `contentInset.l + r`, the rule `elk` uses (DD-06 §6.1 note 2).
  - A child pinned at a negative offset lies outside its parent's content box. `validateResult`
    already reports that as `SGL4003` ("extends outside its container"). No new code is needed.
  - A container whose children are all hidden is a leaf (as in `elk`).
  - *`@size` on a container is `SGL2012` (spec §4), so a derived size is the only kind possible.*
- **N13. The root has no padding and no title band.** Pins at the root are relative to `(0, 0)`, and
  the host re-origins the result (N3).

### 4.4 Edges, ports and labels

- **N14. Edges are straight, by the host's fallback (`edgeRouting: 'straight'`, DD-06 §4.2–4.5).**
  *No code: `routeStraight` already clips to the shape, reserves the arrowhead and draws self-loops as
  teardrops.*
  - **An in-house orthogonal router** (L- and Z-shapes, no obstacle avoidance) would cost about
    0.4 kB gz. Edges would still cross pinned nodes. Deferred: an `edgeRouting` option can add it
    later without breaking a document.
  - **elk's router is not available.** elkjs's `org.eclipse.elk.fixed` algorithm keeps positions
    but routes nothing. Tried on this branch: the edge came back with no sections. elkjs has no
    standalone router (libavoid is not in it). Routing through `layered` would move the nodes.
  - Waypoints (`@layout.via: [[x, y], …]` on an edge) are a natural later addition. They are not
    proposed here.
- **N15. `fixed` places ports: `ports: true`.** A node's ports on one side are spread evenly along
  that side of the frame, in declaration order, at `(i + 1) / (k + 1)` of its length, with the side's
  outward normal. The helper (`placePorts(frame, ports)`) is ~0.15 kB. *This makes F6's port circles
  reachable under a second engine, and `routeStraight` already starts at a port's point when one is
  placed. `grid` could adopt the same helper (F6's remaining half); that changes `ports.sgl`'s `grid`
  goldens, so it is left to a follow-up.*
- **N16. Labels are the host's: `labelPlacement: false` (DD-06 §4.1).** Node titles are centred in
  the content box, container titles top-left, edge labels at the route's midpoint on a plate.

### 4.5 Determinism, capabilities, options

- **N17. `determinism: 'bitwise'`.** Only copies, additions, `max`/`min`, and the division by 2 in
  packing are used. No `ctx.random`, no trigonometry. The double-run test compares raw output as well
  as quantized output (DD-06 §8 check 2).
- **N18. Capabilities:** `{ containers: true, edgeRouting: 'straight', ports: true, labelPlacement:
  false, incremental: false, determinism: 'bitwise', pins: true }`.
- **N19. Options: `{ gap: number (24) }`. No hints.** `gap` is the loose-node packing gap, the same
  field and range as `grid`'s. The F11 form (DD-08 §10) gets one field, "Gap", 0–200 px, using
  `GAP_MAX`. The id is `sgl.fixed`, the name `Fixed`, and the host timeout 2 000 ms
  (`DEFAULT_ENGINE_TIMEOUT_MS`, like `grid`).

```ts
optionsSchema: { type: 'object', additionalProperties: false,
                 properties: { gap: { type: 'number', minimum: 0, default: 24 } } }
hintsSchema:   { type: 'object', properties: {} }
```

### 4.6 Diagnostics

| Code (proposed, **not allocated**) | Severity | Message | Emitted by |
|---|---|---|---|
| `SGL4020` | warning | `{node}` has no `@pin`; `fixed` placed it below the pinned nodes. | `fixed`, in `LayoutResult.diagnostics` (§5) |
| `SGL4021` | warning | `@pin` is not honoured by engine `{id}`; ignored. | `layoutConfigDiagnostics`, main thread (N6) |

Existing codes cover the rest: `SGL2010`/`SGL2011`/`SGL2012` for a malformed or misplaced `@pin`
(N4), and `SGL4003` for a child pinned outside its container (N12). Pinned nodes may overlap. They
get no diagnostic, because an author can overlap them on purpose. Both rows go in
`LAYOUT_CATALOGUE` (the worker bundles only those), each with a corpus fixture that emits it (07 §1).

---

## 5. Engine diagnostics reach the document

- **N20. The host returns an engine's own `LayoutResult.diagnostics` with its validation
  diagnostics, after checking them.** In `host.ts`'s `'result'` case, one is kept only if:
  - its `code` is a `LAYOUT_CATALOGUE` code;
  - its `severity` is the catalogue's for that code, and not `error` (an engine that fails throws,
    which is `SGL4011`);
  - its `span` has finite numeric fields.

  Anything else is dropped. The message is rebuilt from the catalogue. *Built-in engines are
  trusted, but B17's will not be, and a message string from a worker is untrusted text. Rebuilding
  it from the code and the parameters would need the parameters, which `Diagnostic` does not carry.
  So:* engines send `{ code, span, params }` through a new optional field,
  `LayoutResult.notes?: readonly { code; span; params }[]`, and the host builds each diagnostic with
  `layoutDiagnostic()`. `diagnostics` stays in the type for compatibility, and the host ignores it.
  ~0.1 kB on the main thread.
- **N21. `ctx.log` stays dropped.** It is a developer channel with no span or code. It is not how a
  document problem is reported.
- The pipeline already re-runs a layout when a diagnostic's spans have moved (`pipeline.ts`,
  `spansKey`), so a warning's squiggle follows edits without new code.

---

## 6. Naming an engine in a document

- **N22. `@layout.engine` accepts a bare name for any registered `sgl.*` engine: `elk`, `grid`,
  `fixed`, `tree`, `radial`.** `documentEngineOverride` maps `x` to `sgl.x` when `sgl.x` is
  registered, using the same rule as `namesEngine`. Engine ▾ keeps writing the full id. *The spec's
  examples use bare names, and users will type `engine: fixed`. Today that draws nothing (§2 item 3).*
  This is a bug fix against the spec, so it is the orchestrator's call.
- **N23. ⚑ `layered` is not an alias for `elk`; the spec's two examples change to `elk`.**
  Architecture §4.5 reserves `layered` for the future in-house Sugiyama engine. An alias now would
  silently re-lay out every such document when that engine lands. Until the spec changes, the spec's
  own worked example draws nothing. §15 ⚑7.

---

## 7. Shared by `tree` and `radial`: the spanning forest

- **N24. Each container is laid out on its own, post-order, as `grid` does.** A container is one node
  in its parent's layout, sized from its own layout plus padding. *Nested trees are the useful form of
  "compound support" (Architecture §4.5), and it keeps both engines linear.*
- **N25. The edges of one level are lifted.** For container `c`, every visible, non-self-loop edge
  whose endpoints lie under two *different* children of `c` becomes an arc between those two
  children. Duplicates collapse, keeping the first in `graph.edges` order. An edge between two
  descendants of the same child is handled one level down. `payments.api -> psp` therefore makes
  `payments` the parent of `psp` at the root level.
- **N26. Direction is `from → to`, for every edge.** `directed: 'none'` and `'both'` count as
  written. `elk` does the same (DD-06 §6.1).
- **N27. The forest is a BFS from the roots, in order.** The roots are, in declaration order:
  1. children with a `@layout.root: true` hint;
  2. then children with no incoming lifted arc;
  3. then, while a child is unreached (it lies in a cycle), the first unreached one in declaration
     order.

  BFS visits each node's successors in the order `@order` ascending, then declaration order. A node's
  tree parent is whoever reaches it first. *BFS gives every node its least depth, so cycles and DAGs
  are broken the same way on every run, with no randomness. Arcs that are not tree arcs (back, cross
  and second-parent arcs) are still drawn, by the host.* No diagnostic: a graph that is not a tree is
  valid input.
- **N28. Every traversal uses an explicit stack, never recursion.** *`n2000` includes 2 000-long
  paths. A worker's stack is smaller than the main thread's, and a stack overflow would be `SGL4011`.*
- **N29. `@order` is honoured among tree siblings.** Language spec §4 calls it a "sort hint within a
  container". `grid` and `elk` ignore it today. Honouring it in `grid` is out of scope.

---

## 8. `tree`

### 8.1 Algorithm

- **N30. Buchheim, Jünger and Leipert (2002): Walker's algorithm in linear time, with node sizes that
  vary.** For each tree in the forest:
  - **First walk (post-order).** Give each node a preliminary breadth coordinate. Place the node
    over its children's midpoint, and push each subtree away from its left siblings' contours
    (`apportion`, with threads and `ancestor` pointers) until adjacent contours are at least
    `sep(a, b) = (s(a) + s(b)) / 2 + nodeSpacing` apart. Here `s` is a node's breadth extent: its
    width for `down`/`up`, its height for `left`/`right`.
  - **Execute the shifts**, spreading them evenly over the siblings between.
  - **Second walk (pre-order).** Sum the modifiers.

  A forest is laid out as the children of a virtual root whose own position is discarded, so the
  trees sit side by side, `nodeSpacing` apart. *The tidy-tree result users expect from org charts:
  parents centred over their children, identical subtrees drawn identically, and linear time.*
- **N31. Levels are bands.** Level `k`'s depth offset is `Σ_{j<k} (T_j + rankSpacing)`, where `T_j`
  is the largest depth extent at level `j`. Each node is centred in its band. *Rank-aligned levels
  read better than packed ones for hierarchies.*
- **N32. `direction` is applied last, as an axis swap or flip.**
  - `down`: `x = b`, `y = d`.
  - `up`: `y = D − d − t`.
  - `right`: `x = d`, `y = b`.
  - `left`: `x = D − d − t`.

  Then the content box is re-based so that it starts at `(0, 0)`. Here `b` is the breadth coordinate,
  `d` the depth, `t` the node's depth extent and `D` the total depth.
- **N33. `bitwise`.** Buchheim divides a shift by a count of siblings. IEEE division is correctly
  rounded, and ECMAScript specifies it exactly, as it does `+ - *`. No trigonometry or
  `ctx.random` is used.

### 8.2 Edges, labels, ports

- **N34. Tree arcs get elbow routes; every other edge is left to the host.** An edge gets an elbow
  only if it is a tree arc *and* its endpoints are the two nodes of the arc itself, not descendants
  lifted to them (N25). For `down`, the route runs:
  1. from the parent's boundary, straight down its centre line;
  2. to the middle of the gap between the two levels;
  3. across to the child's centre line;
  4. down to the child's boundary.

  Both ends are found with `anchorPoint` (`layout-api`, DD-07 §4) along the centre line, so they lie
  on the shape. A zero-length segment is dropped. `finishEngineRoutes` reserves the arrowhead as for
  `elk`. Other edges get straight routes from `routeStraight`. *Org-chart elbows are the look the
  engine is for. Declaring `edgeRouting: 'orthogonal'` while leaving some edges unrouted is already
  allowed: `routeStraight` fills only what an engine left out (DD-06 §3).* The option `edgeRouting:
  straight` turns elbows off.
- **N35. Labels are the host's (`labelPlacement: false`).** An edge label goes at the elbow's
  arc-length midpoint, which is on its horizontal run.
- **N36. No ports (`ports: false`).** Elbows attach at the centre line.

### 8.3 Options

- **N37. The id is `sgl.tree` and the name `Tree`.** The options are:
  - `direction`: `down` `up` `left` `right` (default `down`);
  - `nodeSpacing`: number (default 40);
  - `rankSpacing`: number (default 70);
  - `edgeRouting`: `orthogonal` `straight` (default `orthogonal`).

  The hints are `direction` (a container's own, which `@direction` sugar sets) and `root: boolean`.
  The F11 form has Direction, Node spacing and Rank spacing (0–500, `SPACING_MAX`), and Edges.
  *These are `elk`'s field names and defaults, so switching engines keeps the document's feel.* Host
  timeout: 5 000 ms, which covers loading the lazy chunk on a slow device.
- **N38. A container's `@direction` applies to its own subtree.** *`grid` honours a container's
  `columns` the same way. Mixed directions are a common org-chart request.*
- **N39. Capabilities:** `{ containers: true, edgeRouting: 'orthogonal', ports: false,
  labelPlacement: false, incremental: false, determinism: 'bitwise' }`.
- **N40. ⚑ The root's `@layout` options should reach the engine.** Today they never do (§2 item 4), so
  `@layout: { engine: tree, direction: right }` would lay out downwards, with no warning. The
  proposal is that each root `@layout` key the effective engine declares in `optionsSchema` overrides
  the Options ▾ bag for that request. *DD-08 §10 already says the document's `@layout.engine`
  overrides the picker, and the document is the source of truth.* It changes the live layout of
  every existing document that sets a root `@layout` option: `checkout.sgl` would go right under
  `elk`. Engine goldens do not change, because they pass options explicitly. §15 ⚑6.

---

## 9. `radial`

### 9.1 Algorithm

- **N41. A wedge layout (Eades 1992) over the same spanning forest (§7).**
  - Each tree's root is at the centre.
  - Each node gets an angular wedge, in turns (fractions of a circle), in proportion to its
    weight, where `weight(v) = Σ over the leaves under v of (diag(leaf) + nodeSpacing)` and `diag`
    is the frame's diagonal.
  - The root's wedge is `[0, 1)`. Children split their parent's wedge in BFS order (N27).
  - A node sits at the middle of its wedge, on ring `k` = its depth. Angle 0 is 12 o'clock, and
    angles run clockwise: `x = R·sin 2πα`, `y = −R·cos 2πα`, with the frame centred there.
- **N42. The ring radius is the smallest that fits.**
  `R_0 = 0`, and for `k ≥ 1`:
  `R_k = max( R_{k−1} + (E_{k−1} + E_k)/2 + rankSpacing,  max over v on ring k of (diag(v) + nodeSpacing) / (2·sin(π·min(θ_v, ½))) )`,
  where `E_k` is the largest diagonal on ring `k` and `θ_v` is `v`'s wedge width. *The second term
  keeps each node's bounding circle inside its own wedge, so nodes on one ring cannot overlap, and
  nodes on different rings are a ring gap apart.* Eades' further limit (children's wedges no wider
  than `2·arccos(R_k / R_{k+1})`, against crossings between subtrees) is left out of v1.
- **N43. The components of a forest are separate discs, packed in a row.** They go left to right, in
  their roots' declaration order, top-aligned, `nodeSpacing` apart. An isolated node is a disc of
  its own. *elk's `radial` stacks every extra component at one point (§9.3).*
- **N44. ⚑ `radial` uses its own `sinTurn`/`cosTurn`, so it is `bitwise`.** They reduce to one
  octant by exact symmetries (turns are exact binary fractions for the octant boundaries), then
  evaluate a fixed degree-13 polynomial by Horner's rule. That uses only `+` and `*`, which
  ECMAScript specifies exactly; JavaScript never fuses a multiply-add. Error is ~1e−15, and the cost
  is ~0.2 kB, in the lazy chunk. `Math.sqrt` (for `diag`) is exact by the same argument (ADR-0004).
  *ADR-0004 files `radial` under `quantized` because `Math.sin` is implementation-approximated, and
  quantization cannot absorb a last-bit difference that straddles a 1/128 rounding boundary. Owning
  the polynomial removes the question, and the cross-browser golden test (DD-09) can include
  `radial` with no caveat.* It amends ADR-0004's table, which is the human's (§15 ⚑8).
- **N45. Containers are nested discs.** Each container's children form a radial layout inside its
  content box, and the container is one node on its parent's rings.

### 9.2 Edges, labels, options

- **N46. Edges are straight, by the host.** Radial spokes are straight lines, so no code is needed.
  Labels are the host's, and there are no ports.
- **N47. The id is `sgl.radial` and the name `Radial`.** The options are `nodeSpacing` (40) and
  `rankSpacing` (70, the ring gap), and the hint is `root: boolean`. The F11 form has Node spacing
  and Ring spacing (0–500). Capabilities: `{ containers: true, edgeRouting: 'straight', ports:
  false, labelPlacement: false, incremental: false, determinism: 'bitwise' }`. Host timeout:
  5 000 ms.

### 9.3 elkjs's `mrtree` and `radial`, weighed

elkjs 0.11.1's bundle contains both `org.eclipse.elk.mrtree` and `org.eclipse.elk.radial`, so a thin
descriptor ("`elk` with another `elk.algorithm`") is possible. It would reuse `mapping.ts` with one
option changed, and cost ~0.3 kB of boot per engine. It was run on this branch (a 7-node tree, the
same tree with two extra edges, a forest, and a container). The results:

| | `mrtree` | `radial` |
|---|---|---|
| A tree | tidy, parents centred | correct |
| Cycles | tolerated | **throws** "The given graph is not a tree!", which would be `SGL4011`; the in-house spanning forest (§7) would be needed in front of it anyway |
| A forest | the second tree is stacked *below* the first | **every extra component is placed at the same point**, so they overlap, which fails DD-06 §8 check 3 |
| A container | laid out inside; an edge across the boundary comes back unrouted (the host fills it) | a disconnected container overlaps its sibling |
| Determinism | `quantized` | `quantized` (trigonometry) |
| First use | loads the 435 kB gz `elk` chunk (1.44 MB to parse; F15's cold-start cost) | the same |

- **N48. In-house, both.** *The in-house code is ~3.5 kB gz, outside the core budget (§11). It is
  `bitwise` rather than `quantized`, it never loads 1.44 MB to draw a small tree, and it handles the
  forests and cycles that elk's `radial` refuses or overlaps. The part elk would save (Buchheim) is
  the smaller part. The spanning forest, forest packing and nesting would be needed in front of elk
  anyway.*

---

## 10. `force`

- **N49. ⚑ Cut `force` from v1.0: move it out of B5's Must, to Could, together with B21 (edge
  bundling, which the backlog scopes to it).** The reasons:
  - **It is the only engine that is `best-effort`** (ADR-0004), so it cannot join the
    cross-environment golden test. It needs F10's per-document seed, which is undecided.
  - **It needs a snapshot to be useful.** ADR-0004's answer, `@layout.snapshot` baking the result
    into `@pin`s, needs E15-style source write-back, which does not exist.
  - **It has little room.** A seeded Barnes–Hut is 3–5 kB gz even lazy, it is the slowest engine
    on n2000, and the backlog calls it "the least used of the six".
  - **Others cover its cases.** `fixed`, `tree`, `radial`, `grid` and `elk` cover the cases people
    draw. For hub-and-spoke networks, `radial` covers most of them.

  Dropping a Must is the human's decision (§15 ⚑3). If `force` is kept, it goes last, in the same
  lazy chunk, and F10 must be decided first.
- **N50. F10's owner moves to `force`.** None of `fixed`, `tree` or `radial` reads `ctx.random`.

---

## 11. Where each engine lives, and the boot budget

- **N51. All three are in `@sgl/layout-std`.** `src/descriptor.ts` (the `/descriptor` entry) grows to
  hold the `fixed`, `tree` and `radial` descriptors. The new sources are `fixed.ts`, `pack.ts`
  (N10), `ports.ts` (N15), `forest.ts` (§7), `tree.ts`, `radial.ts` and `trig.ts`. `layout.worker.ts`
  registers `fixedEngine`, `treeEngine` and `radialEngine`, and `REGISTERED_ENGINES` lists their
  descriptors.
- **N52. ⚑ `tree` and `radial` load lazily inside the worker, as elkjs does.** Their engine objects
  are a descriptor plus a `layout()` that runs `await import('./trees.js')`. This makes a `std-trees`
  chunk, which needs:
  - a `manualChunks` rule in the worker build;
  - a `!std-trees-*.js` exclusion in `.size-limit.js`;
  - a `check-core-chunks.mjs` signature check (not reachable from the entry or statically from
    the worker; the worker must reference it);
  - an offline e2e case (it is precached, like every emitted chunk).

  `fixed` is static in the worker. *It is small, it is the escape hatch, and it should work on the
  first request with no fetch.* The budget is the human's (§15 ⚑9).

Estimates, gzipped and marginal. Each is from the measured size of the same kind of code on this
branch: `grid`'s descriptor 0.38 kB and its layout code 1.2 kB standalone; the `elk` descriptor
0.81 kB; one catalogue row ~0.08 kB, counted twice because it is in the page and in the worker.

| Item | Page (boot) | Worker (boot) | Lazy `std-trees` |
|---|---|---|---|
| `@pin` registry row, pin sub-key check | 0.10 | — | — |
| N20 engine notes in `host.ts`; N6 `SGL4021` in `layoutConfigDiagnostics`; N22 bare names | 0.25 | — | — |
| Two catalogue rows (`SGL4020`, `SGL4021`) | 0.10 | 0.10 | — |
| `fixed`: descriptor, F11 defaults and normalisation | 0.35 | 0.20 | — |
| `fixed`: layout, `pack.ts` shared with `grid`, ports | — | 0.80 | — |
| `tree`: descriptor, F11 rules; worker stub | 0.40 | 0.30 | ~2.2 |
| `radial`: descriptor, F11 rules; worker stub | 0.35 | 0.25 | ~1.3 (with `trig.ts`) |
| **Total** | **~1.55** | **~1.65** | **~3.5** |

So the total is **~3.2 kB of 6.01**, leaving ~2.8 kB. Everything static would be ~6.7 kB, which is
over. Each branch measures its real cost and stops if it exceeds its line by more than 50%. The F11
form fields go in the existing lazy `engine-options-form` chunk and are not counted. If bytes run
short, the first lever is to split each descriptor into what the worker needs (id, capabilities) and
what only the page needs (schemas). That saves ~0.15 kB per engine in the worker.

---

## 12. Tests

For each engine, in its own branch:

1. **Goldens.** `packages/layout-std/test/__goldens__/{fixed,tree,radial}/` over the clean corpus,
   `grid`'s set, plus new fixtures:
   - `corpus/layout/pin-*.sgl`: fully pinned, half pinned, nested relative pins, a negative child
     pin (`SGL4003`), a malformed pin (`SGL2011`), a pin on an edge (`SGL2012`), and `@pin` under
     `elk` (`SGL4021`);
   - `corpus/layout/tree-*.sgl`: a forest, a cycle, a diamond DAG, `@order`, mixed `@direction`,
     `@layout.root`.

   `grid`'s existing goldens must stay byte-identical after N10.
2. **Conformance (DD-06 §8).** Add each engine to `layout-std/test/conformance.test.ts`: every corpus
   document plus the in-memory 1 000-node graph, checks 1–6. For `fixed` the corpus has no pins, so
   check 3 (no sibling overlap) exercises the loose-node packing. That is a property worth holding:
   N9's packing never overlaps a pinned sibling. It is also unit-tested with pinned overlaps, which
   are exempt by design (§17 item 9).
3. **Double-run determinism.** In Node over the whole corpus, raw and quantized (`bitwise`). Through
   a real worker in Chromium, against a Node-computed expected result, as
   `grid.browser.test.ts` does (`bench/generate-grid-fixture.js` extended to `fixed`, `tree` and
   `radial`). For `radial`, a table test pins `sinTurn`/`cosTurn` against `Math.sin`/`Math.cos`
   within 1e−14, and exact values for the octant points.
4. **Engine-specific units.**
   - `tree`: the tidy-tree invariants on random-shaped fixtures (siblings' subtrees at least
     `nodeSpacing` apart, parent centred over its children, identical subtrees drawn identically),
     a 2 000-node path and a 2 000-node star (no stack overflow, linear time), every direction,
     elbow ends on each shape's outline.
   - `radial`: no overlap on a ring, monotone radii, disjoint discs for a forest.
   - `fixed`: relative pins under nesting, a container's derived size, `SGL4020` per loose node,
     ports spread on each side.
5. **MVP criterion-1 style engine switch.** Parametrise `e2e/criteria.spec.ts`'s criterion 1 over
   `sgl.grid`, `sgl.fixed`, `sgl.tree` and `sgl.radial`. Switching from `elk` keeps identity and
   paint and changes geometry. For `fixed`, use `corpus/layout/forty-three-pinned.sgl`: the same
   document with pins generated once from its `grid` layout by a committed script. That way the
   test's "no diagnostics" assertion holds.
6. **E2E.**
   - Engine ▾ lists each engine with a `bitwise` badge.
   - Each Options ▾ form edits, persists and resets on a switch (`engine-options.spec.ts`).
   - `@layout.engine: fixed` in the document selects it (N22).
   - An unpinned node shows `SGL4020` at its line, and the squiggle follows an edit above it.
   - Offline: `tree` works with the network off (the lazy chunk is precached).
   - `pnpm size` and `check-core-chunks.mjs` are green.
7. **Host (N20).** An engine note with an unknown code, an `error` severity or a malformed span is
   dropped. A valid one reaches `run()`'s diagnostics with the catalogue's message. This goes in the
   Node host test and in `host-runtime.integration.test.ts`.

---

## 13. Implementation plan

Each branch is from `main`, has its own T1+T2 gate, is reviewed, and merges `--no-ff` before the next
begins.

1. **`feat/b5-pin`** (small; after ⚑2, ⚑4, ⚑5).
   - `@pin` gets its registry row and sub-key check (N4).
   - Engine notes reach the document (N20); the capability `pins?` (N6); `SGL4021` in
     `layoutConfigDiagnostics`.
   - Bare engine names in `documentEngineOverride` (N22).
   - The `corpus/layout/pin-*.sgl` fixtures.
   - Spec §4 text, if approved; DD-02 §7 and DD-06 §2, §5 and §9.
   - No engine yet: under `elk` and `grid` the only visible change is `SGL2010` becoming `SGL4021`.
2. **`feat/b5-fixed`**.
   - `pack.ts` (N10), with `grid`'s goldens unchanged, as its own first commit.
   - `fixed.ts`, `ports.ts` and `SGL4020`.
   - Registration; the F11 rules and form.
   - Goldens, conformance, the browser double run, the criterion-1 case with the pinned fixture, and
     e2e.
   - DD-06 gets a §7a.
3. **`fix/root-layout-options`** (small; only if ⚑6 is yes). Root `@layout` options reach the
   engine (N40). A pipeline test and an e2e case (`checkout.sgl` goes right under `elk`). Best merged
   before `tree`, whose main option is `direction`.
4. **`feat/b5-tree`**.
   - `forest.ts` (§7) and `tree.ts`.
   - The lazy `std-trees` chunk infrastructure (N52): the worker's `manualChunks`, `.size-limit.js`,
     `check-core-chunks.mjs`, and the offline e2e.
   - Options and form, goldens, conformance, units and e2e.
5. **`feat/b5-radial`**. `trig.ts`, `radial.ts` into the same chunk. Options and form, goldens,
   conformance, the cross-browser `bitwise` test, and e2e.
6. **`docs/b5-force`** (only if ⚑3 is cut). The backlog row splits: B5 becomes `fixed`, `tree` and
   `radial`, and a new Could row takes `force` with B21. 07 §2.1 F10's owner changes (N50).

---

## 14. Changes to other documents (made by the implementing branches)

- **Language spec** (if approved): the §4 `@pin` row (§3); §9 and the §4 root example, `layered` →
  `elk` (N23).
- **Architecture §4.5**:
  - `fixed`: "Honours `@pin` and `@size` exactly; places unpinned nodes below, with a warning".
  - `radial`: "Concentric rings by depth, wedges by subtree weight".
  - `force`: marked cut, if ⚑3 is cut.
- **ADR-0004** (if ⚑8 is approved): `radial` moves to "Yes" in the table and to `bitwise` in the
  classes, with the reason.
- **DD-02 §7**: the `pin` row.
- **DD-06**:
  - §2: capability `pins?`;
  - §5: engine notes;
  - §7a–§7c: the three engines;
  - §8: the new engines in the suite;
  - §9: `SGL4020`, `SGL4021`.
- **DD-08 §10**: the new forms; bare engine names; root options, if ⚑6 is yes.
- **DD-10 §2** and `.size-limit.js`'s comment: the `std-trees` chunk.
- **04**: the B5 row, if ⚑3 is cut.
- **07**:
  - §2 and §5 Stage L rows;
  - §2.1 F6 (reachable under `fixed` too);
  - §2.1 F10 (the owner).

---

## 15. ⚑ Decisions for the human

**⚑1 (N9): what `fixed` does with a node that has no `@pin`.**

| Option | For | Against |
|---|---|---|
| (a) An error (as Architecture §4.5 says); the previous layout stays | Strict; nothing is ever placed by accident | A new node shows nothing until it is pinned, and a half-pinned diagram is blank |
| **(b) Pack loose nodes below the pinned ones, with a warning each (`SGL4020`). Recommended** | Always draws; each loose node is flagged at its line; cheap (reuses `grid`); cannot overlap a pinned node | 40 warnings on an unpinned 40-node document |
| (c) Delegate loose nodes to another engine | Nicer placement | `sublayout` is not built; `elk` costs a 435 kB chunk and cannot keep pinned nodes still |

**⚑2 (N1, N2): what a pin's coordinates mean.**

| Option | For | Against |
|---|---|---|
| **(a) Top-left of the frame, relative to the parent's content box (root: the diagram origin). Recommended; a spec change** | A container moves with one edit (E15); imported subtrees keep their shape (A9); works inside a future per-container engine (B8/B9) | Contradicts the spec's word "absolute"; nested pins must be added up to find a position |
| (b) Top-left, absolute in diagram space (the spec as written) | What the spec says; one number per node, with no sums | Moving a container means rewriting every descendant; a pinned import lands on the importer's nodes; cannot work under B8 |
| (c) Either, but pin the *centre* | A node stays centred when its label changes | Unlike SVG, Excalidraw and draw.io; E15's write-back needs the size |

**⚑3 (N49): `force`.** (a) **Cut from v1.0: B5 becomes `fixed`, `tree` and `radial`; `force` goes
to Could with B21. Recommended.** (b) Keep it as a Must, last, lazy, `best-effort`, after F10 is
decided. This is dropping part of a Must, so it is the human's.

**⚑4 (N6): a `@pin` under an engine that ignores it.** (a) **A warning at the key (`SGL4021`), with
an optional capability `pins?: boolean` added to the contract (additive, `apiVersion` 1).
Recommended.** (b) Silently ignored. (c) Honour pins in `elk` and `grid` now: B11, a Should; for
`elk` it needs interactive layering and is not small. Not in B5.

**⚑5: new diagnostic codes.** Two warnings, numbers proposed only:
- `SGL4020` "`{node}` has no `@pin`; `fixed` placed it below the pinned nodes."
- `SGL4021` "`@pin` is not honoured by engine `{id}`; ignored."

Recommended: allocate both. **No new dependency** is needed by any option recommended here.

**⚑6 (N40): should the root's `@layout` options reach the engine?** (a) **Yes: a root option the
engine declares overrides Options ▾ for that request. Recommended; it is what spec §4 and DD-08 §10
imply.** It changes the live layout of documents that already set one (`checkout.sgl`'s `direction:
right` starts to apply). (b) No: document it, and warn (a new code) that root options are ignored.

**⚑7 (N23): `engine: "layered"`.** (a) **Change the spec's two examples (§4, §9) and
`corpus/checkout.sgl` to `elk`, and keep `layered` for the future in-house engine. Recommended.**
(b) Make `layered` an alias of `elk`. Existing documents work, but they re-lay out silently if an
in-house `layered` ever ships. Either way, bare names (`grid`, `fixed`) are accepted (N22, a bug
fix).

**⚑8 (N44): `radial`'s determinism class.** (a) **`bitwise`, using its own polynomial `sin`/`cos`,
~0.2 kB lazy; amends ADR-0004's table. Recommended.** (b) `quantized`, using `Math.sin`/`Math.cos`,
as ADR-0004 predicts.

**⚑9 (N52): the budget.** (a) **`tree` and `radial` in a lazy `std-trees` chunk inside the worker;
`fixed` static. ~3.2 kB of the 6.01 kB left. Recommended.** (b) All static: ~6.7 kB, which needs
the limit raised to about 183 kB. (c) `fixed` lazy too: ~0.8 kB less at boot, one more chunk to
precache and test offline.

---

## 16. Factual fixes made in other documents on this branch

1. **07 §2.1 F10** said "`elk` is unbuilt". It has been built since Stage K, and it pins its own seed
   (`elk.randomSeed: '1'`) rather than reading `ctx.random`. Corrected, with a pointer to N50. The
   owner column is left as it is until ⚑3.
2. **DD-00 §1**: the DD-11 row said branch 3 (render) was "to come". A18 merged on 2026-09-27. It
   now says all three branches are implemented. A DD-12 row is added.

---

## 17. Contradictions found while designing this

1. **Architecture §4.5 says `fixed` "errors on unpinned nodes".** This document recommends placement
   plus a warning (⚑1). 06 §3 and 07 §5 estimate `fixed` at "about a day". With `@pin` validation,
   engine notes and the F11 form, it is closer to two or three.
2. **Language spec §4 says `@pin` is an "absolute position auto-layout must respect".** No engine
   honours it, and the resolver says so (`SGL2010`, no registry row). B11 (auto-layout respects
   pins) is a Should. The row is both over-promising and, per ⚑2, the wrong frame of reference.
3. **The `LayoutResult.diagnostics` field is in the contract, but `host.ts` drops it** (and every
   `ctx.log`). DD-06 §3 and §5 never say an engine's diagnostics are discarded, so the contract
   implies a channel that does not exist (§5).
4. **Engine names.** Spec §4 and §9 and `corpus/checkout.sgl` write `engine: "layered"` and
   `engine: grid`. The app accepts only `sgl.*` ids at the root, so both draw nothing (`SGL4011`).
   `layoutConfigDiagnostics` accepts `elk` for a container. Architecture §4.5 names engines `elk`,
   `grid`, and so on (§6).
5. **The root's `@layout` options are ignored.** Spec §4 shows `direction` and `spacing` in the root
   block, and DD-08 §10 says the document overrides the pickers, but only `engine` is read.
   `checkout.sgl` is laid out `DOWN` under `elk` although it says `right`. DD-06 §7 notes only the
   `grid` `columns` case (⚑6).
6. **Architecture §4.5 describes `force` as "seeded Barnes–Hut n-body, then snap-to-grid for
   determinism".** ADR-0004 says that is not enough ("early divergence is amplified"), and classes
   it `best-effort`. A snap does not make `force` deterministic.
7. **ADR-0004 files `radial` as not reproducible bit for bit**, because it uses trigonometry. That
   holds for `Math.sin` only; an in-house polynomial is `bitwise` (⚑8). ADR-0004 also says
   quantization "absorbs last-bit divergence". It absorbs almost all of it, but a value within one
   ulp of a 1/128 boundary can still round two ways. That is rare, and elk's Node-equals-Chromium
   golden shows it has not happened on the corpus, but it is not a guarantee.
8. **07 §2.1 F10's owner** is "B5 `radial`/`force`, the first seed-consuming engines". `radial`
   needs no seed (N50). Left for ⚑3.
9. **DD-06 §8 check 3 (no two sibling frames overlap)** assumes an engine that chooses positions.
   Under `fixed`, pinned nodes may overlap on purpose. The suite stays as it is, because the corpus
   has no pins. `fixed`'s own tests cover pinned overlap, and the SDK's future conformance guide
   (B18) should say that an engine honouring author positions is exempt for those nodes.
10. **Architecture §4.5 says `grid` packs "with spans"** and `tree` has "compound support". `span`
    is a v1.x hint `grid` does not read (DD-06 §7). The compound support in §7 here is nested
    trees, not trees that cross container boundaries.
