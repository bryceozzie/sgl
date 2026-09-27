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
> `SGL4010`-on-unknown-hint-key validation this section describes was **not
> implemented** until Stage K's fix round 1 (item 23, human decision 2026-09-23),
> and is now, without a JSON-Schema validator: `layoutConfigDiagnostics(ast,
> engineSchemas)` (`layout-api/src/layout-config.ts`) warns, at the key, for
> (a) a container-level `@layout.engine` naming another engine than the
> effective one (per-container engines are B8/B9; until then this warns and the
> whole document is laid out by one engine), and (b) any `@layout.{key}` —
> root, container, or `@direction` sugar — that the effective engine declares
> in neither `optionsSchema` nor `hintsSchema` (key names only; values are not
> validated). It reads the AST (only the AST keeps a span per `@layout`
> sub-key; `compile()` drops the root's bag). The app's pipeline runs it with
> the effective engine's descriptor, beside `buildLayoutInput`; so does
> `render-svg/test/pipeline.ts`. Fixtures: `corpus/layout/*.sgl`.

> **Amended by `feat/b5-pin` (DD-12 N6, N20, N22).** Three additions, all optional
> and so additive: `apiVersion` stays 1.
> - **`EngineCapabilities.pins?: boolean`.** It says whether the engine places a node
>   where its `@pin` says. Absent means `false`. `layoutConfigDiagnostics` takes it as
>   `EngineSchemas.pins`. Under an engine without it, a node's `@pin` is `SGL4021`
>   (§9): once per node, at its first pin key, and ignored. Neither `grid` nor `elk`
>   declares it. The pin itself reaches every engine unchanged in
>   `GraphNode.config.pin`: the frame's top-left, relative to the top-left of the
>   parent's content box (DD-12 H2; DD-02 §7).
> - **`LayoutResult.notes?: readonly EngineNote[]`**, where an `EngineNote` is
>   `{ code, span, params? }`. This is how an engine reports a problem in the
>   document; the host rebuilds each note as a diagnostic (§3, step 3).
>   `LayoutResult.diagnostics` stays in the type, and the host ignores it: a
>   message string from a worker is untrusted text.
> - **Bare engine names.** The app's `documentEngineOverride` maps a root
>   `@layout.engine` of `x` to `sgl.x` when `x` itself is not registered and `sgl.x`
>   is. Any other value passes through, so an unknown name is still `SGL4011`, as an
>   unknown id is. `layered` is not an alias (DD-12 H7).

**`LayoutInput` construction** (`buildLayoutInput(styled, labelSizes, scope?)`, `sizing.ts`):

Both nodes and edges carry their own `hidden` flag (DD-03 §2, §6) — a node's already excludes it from `graph.order`, and an edge's is already "effectively hidden" (its own `@hidden`, or either endpoint's node, computed once in `compile()`). Filtering either kind of element for `LayoutInput` is therefore a single flag test — `!edge.hidden` for edges alongside the node loop below — not a node filter plus a separate "does this edge touch a hidden node" walk:

```
for each node in graph.order (already excludes hidden):
  g        = styles[node].geometry
  label    = labelId ? labelSizes[labelId] : { w: 0, h: 0 }
  contentInset = g.padding (t r b l) + contentInsets(node.shape, label.w, label.h)   // DD-07 §4; one copy, in @sgl/core (A18, DD-11 T4)
  intrinsic = { w: label.w + contentInset.l + contentInset.r,  h: label.h + contentInset.t + contentInset.b }
  min      = { w: g.minWidth, h: g.minHeight }; max = { w: g.maxWidth, h: g.maxHeight }   // there is no @size.maxHeight key (DD-02 §7): max.h is never set
  fixed    = { w: g.width, h: g.height }
  padding  = contentInset; if container: titleHeight = label.h + g.titleGap; padding.top += titleHeight
  sizing   = { intrinsic, min, max, fixed, aspectRatio: g.aspectRatio, contentInset, padding }
```

**Wrapped labels (A18, DD-11 T35, T39–T41).** Nothing here changes: a label that wraps is measured narrower and taller, and `labelSizes` carries that size like any other. The wrap width is chosen so the rule above keeps `intrinsic.w ≤ maxWidth`: a node title with a finite positive `@size.maxWidth` or `@size.width` (the smaller) wraps at `labelMaxWidth(shape, width, padding)` (`@sgl/core`, beside `contentInsets`): the width inside the padding, over √2 for an ellipse and over 2 for a diamond; a hexagon's label is held by the breaker to `L + min(L, H)` within that width, its insets being `min(L, H)/2` a side (DD-11 T35, fix round 1). The one exception is a single unit wider than that, which overflows as an unwrapped label does. `elk` and `grid` need no change (a container's title band is `label.h + titleGap`, so a two-line title pushes its children down), and label placement is unchanged (§4.1). `render-svg/test/wrap-pipeline.test.ts` checks, under both engines, that the measured label, `labelSizes`, the node's frame and the label's placement agree for every shape. Containers do not wrap their titles: `@size` keys apply to nodes only (DD-04's registry).

`contentInset` and `padding` are both kept on `NodeSizing`, not just the post-title-band one: §4.1 needs the *pre*-band inset to place a container's own title (which sits *in* the band), while `grid` (§7) needs the *post*-band one to know where a container's children start. They are equal for a leaf.

**DEVIATION** from `buildLayoutInput(styled, table)`'s original signature: `table` was meant to be the runKey-keyed `MeasureTable`, with this function computing `hashRuns(...)` itself to look a label up. `hashRuns` and the `StyledRun`/`TextStyle` types it needs live in `@sgl/text` since A18 (`run-key.ts`; `@sgl/measure` before), and `layout-api` may not depend on `@sgl/text` or `@sgl/measure` any more than on `@sgl/theme` (`eslint.config.js` enforces this on `src/**`, not just `test/**`). `buildLayoutInput` therefore takes the already-resolved `LabelId -> Size` table; the runKey lookup is the caller's job (Stage G's pipeline harness, eventually — Stage E's own tests do it inline).

Circles and other `aspectRatio`-locked shapes get `max(w,h)` applied by the engine or the host post-pass (§4.4), not here — engines that lay out containers need the *unconstrained* intrinsic to pack children.

`ResolvedThemeMetrics` passed in `ctx.metrics`: `{ spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {…}, arrowSize }` — the small set of theme-derived numbers an engine may want for defaults. Engines must not read `StyledGraph`; they get `LayoutInput` only.

---

## 3. Worker host

One long-lived `Worker` (`layout.worker.ts`), respawned on termination. Engines are registered into an `EngineRegistry` at worker startup (Stage H registered `grid`; Stage K registers `elk` too). `elk`'s engine object is imported statically; elkjs itself is loaded by a dynamic `import()` inside `elkEngine.layout()` on the first elk request (§6, decision K1), so a worker that only ever runs `grid` never fetches it.

**Implemented by Stage H** as two modules in `@sgl/layout-api`, split on the Worker boundary itself (not merely documented as a mental split):

- `worker-runtime.ts` — everything that runs *inside* the worker: receive `'layout'`, look up the engine in the registry, run it with `ctx.signal`, then, **only if the engine's raw output passes `validate.ts`'s `describeShapeError` shape check** (fix round 2, item 2 — see below), **apply §4's host fallbacks** (`routeStraight` unconditionally — it only fills an edge the engine left out, so it is a no-op once one is already routed; `placeLabels` only when `capabilities.labelPlacement` is `false`, since it *replaces* `result.labels` outright), post `'result'`/`'error'` (`SGL4011` on a throw — sync or async — **and also on an unregistered engine id**, `{message}` reading "not registered in this worker"), answer `ctx.measure.layoutRunsAsync` via the `'measure'`/`'measure-reply'` RPC, honour `'abort'` by aborting that request's `AbortController`. This is the only place in the pipeline with both the engine's `capabilities` and its `LayoutInput`/`LayoutResult` at hand — `host.ts` never sees either — which is why the fallbacks run here and not there (found missing entirely in fix round 1, item 3: with no fallback applied, `grid` — `edgeRouting: 'straight'`, no edges of its own — could never pass `validateResult` through the real worker/host protocol). The shape check was a second, closely related gap fix round 2 found: `routeStraight`/`placeLabels` assume exactly the same shape `validateResult` does, so once the fallbacks ran unconditionally, an engine resolving something other than a `LayoutResult` made `routeStraight` throw *inside the worker's own `try`/`catch`* — a validation-shaped failure (`SGL4002`) surfaced instead as a worker-side `SGL4011` carrying a raw `TypeError` message. `describeShapeError` is exported from `validate.ts` and reused here rather than duplicated; a malformed `raw` is posted through as `'result'` unchanged, so `host.ts`'s own `validateResult` is what rejects it. Deliberately `Worker`-free — it takes an `EngineRegistry` and a small `{ post(message) }` port, so a Node test drives it with a fake port and no real `Worker` (`worker-runtime.test.ts`).
- `host.ts`'s `createWorkerHost` — the main-thread half, below.

`apps/web/src/layout.worker.ts` is the thin, real entry that constructs the registry, registers `elkEngine` and `gridEngine` (Stage K), and wires `worker-runtime.ts` to the actual worker global scope. It has to live in `apps/web` rather than `@sgl/layout-api`, because `@sgl/layout-api` may not import `@sgl/layout-std` (DD-00 §2 rule 3) but the entry needs `gridEngine` to register it. The browser test project (DD-09 §3.1) uses its own test-fixture worker entry (`packages/layout-api/test/browser/fixture.worker.ts`) registering small synthetic engines instead, so the Stage H gate's four conditions (timeout, abort, malformed output, a measure miss) can each be forced on demand against a real `Worker`, rather than depending on `grid`'s own timing or geometry.

**`createWorkerHost` takes a factory, not an instance** (`createWorkerHost(spawn: () => Worker, options?)`) — the signature this section originally sketched, `createWorkerHost(worker, timeoutMs)`, cannot respawn after `terminate()`, because a terminated `Worker` stays terminated. `spawn()` runs once up front and again on every respawn (a timeout, or an unanswered abort). `options` (decision D1) carries: the default timeout (`DEFAULT_TIMEOUT_MS = 10 000`), per-engine overrides merged on top of a baked-in default (`DEFAULT_ENGINE_TIMEOUT_MS = { 'sgl.grid': 2 000 }`, this section's own "grid 2 000 ms" made concrete), and `measure` — the main-thread callback that answers a `'measure'` RPC. `measure` is optional: a host whose registered engines never call `ctx.measure.layoutRunsAsync` never needs it, and an unconfigured miss degrades to an empty `TextLayout`-shaped value rather than hanging the request forever.

**`ctx.measure` needed a member `contract.ts` didn't have.** `MeasurerView` (§2's structural view of `@sgl/measure`'s `Measurer`) originally carried only the synchronous `layoutRuns`. But the RPC this section's protocol defines has nothing to call it from apiVersion 1's contract: a genuine table miss can only be served by round-tripping to the main thread, which is inherently async, and `layoutRuns`'s frozen signature returns a value, not a `Promise`. Architecture §6's full `Measurer` interface already anticipates exactly this split (`layoutRuns` / `layoutRunsAsync`); the reduced view in `contract.ts` had simply dropped the async half. Stage H restores it as `MeasurerView.layoutRunsAsync(runs, box): Promise<unknown>` — the design cannot express this section's own RPC without it. Inside the worker runtime, the synchronous `layoutRuns` now throws (a worker has no synchronous path to the host at all, so a call to it is a programming error in the caller, not a runtime condition — DD-00 §3's "throwing is reserved for a violated invariant"); every engine-created label goes through `layoutRunsAsync`, which is by construction always a miss (a label already in the pre-measured table doesn't need `ctx.measure` at all — it is already sized in `LayoutInput.labelSizes`). One further, narrower deviation: `layoutRunsAsync` always performs the RPC rather than first checking the `table` field the protocol ships in the `'layout'` message — computing that table's key (`hashRuns`/`labelRunKey`) lives in `@sgl/measure`, which `layout-api` may not import (DD-00 §2 rule 2), so the worker runtime has no way to look it up locally. `table` remains on the message for a future stage to wire a local check through if that import boundary changes.

**Seed.** `LayoutHost.run()`'s frozen signature has no per-call seed parameter, so `ctx.random` is seeded from one fixed constant the host supplies (`SEED = 1` in `host.ts`) on every request. A per-document seed is a future widening of `run()`, not something Stage H's implementation can add unilaterally (execution plan §2.1, **F10**).

**Every message is bound to the worker instance that can answer it** (fix round 1, item 1). Each spawned worker's `'message'` listener closes over that specific worker instance; if `worker` (the host's mutable "current worker" reference) no longer points at it — because a timeout or an unanswered abort respawned a fresh one — every message from it is discarded, not just a stale `'result'`/`'error'`. This closes a gap `'result'`/`'error'` alone didn't have (their `id`s are host-assigned and never reused, so a stale one could never coincide with a live request) but `'measure'` did: a worker's own `req` counter is worker-side state that restarts at 0 on every respawn, so an un-gated `'measure'` from an already-replaced worker could resolve an unrelated `layoutRunsAsync` call in the new generation with the wrong data. A second, narrower check catches the same failure mode one generation earlier, before any respawn happens at all: a superseded-but-not-yet-respawned request's engine (one that, like `elk`, doesn't notice `ctx.signal` right away) can still post a `'measure'` for a request the host no longer considers current — `onMessage`'s `'measure'` branch additionally requires `message.id === current?.id` before invoking the `measure` callback at all.

**`run()` after `dispose()` rejects immediately** (fix round 1, item 6) — calling it is a programming error (§1's "throwing is reserved for a violated invariant"), not a runtime condition, so there is no post, no timer and no spawn; previously it posted to a terminated worker, which never replies, so the request hung until timeout and then spawned an orphan worker nothing would ever use.

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

**`'result'`'s `ms` is the one sanctioned exception to DD-00 §3's determinism ban on `performance.now`** (`eslint.config.js` bans it alongside `Math.random`/`Date.now` precisely so an exception needs an inline `eslint-disable-next-line`, not a remembered convention): it is telemetry only, purely for the host to display, and is never read back into anything an engine or the renderer produces. `worker-runtime.ts`'s `now()` is the one call site.

### Lifecycle per request

```
1. host assigns id, starts timer (default 10 000 ms; grid 2 000 ms) — the clock starts at
   run(), before 'layout' is posted, so it also covers a respawned worker's cold boot and
   its engine's module import, not just the engine's own layout() call
2. posts 'layout'
3. on 'result'  → clear timer → validate (§5) → quantize → resolve { value, diagnostics }
                  (§5's own warnings — e.g. SGL4003 — pass through on a success, not just [])
                  (then the engine's own `notes` (DD-12 N20, `feat/b5-pin`), on a success
                   only, each kept only if its code is a LAYOUT_CATALOGUE row that is not
                   an error and its span is two finite numbers; its params are kept only
                   if they are strings or finite numbers; the message is rebuilt with
                   layoutDiagnostic(), never the engine's. `engineNotes()` in host.ts)
                  (or resolve { value: null, diagnostics } if §5 rejects it — SGL4002)
   on 'error'   → clear timer → resolve { value: null, diagnostics: [diagnostic] }  (SGL4011)
   on timer     → worker.terminate(); respawn; resolve { value: null, diagnostics: [SGL4001] }
4. abort(): post 'abort'; reject *immediately* with AbortError (the caller stops waiting
   without needing the worker's cooperation); separately, if no 'result'/'error' for that
   id arrives within 250 ms → terminate + respawn, so a stuck worker doesn't serve stale
   engines forever. A late reply for an already-aborted id is discarded, not resolved.
5. every respawn re-posts the current request's 'layout' to the new worker, if there is
   one (F21): it was posted to the worker being terminated. It keeps its timer (step 1).
```

**Errors as values, except abort.** §1's "a stage never throws" rule says `run()` should resolve `{ value: null, diagnostics }` for everything the caller might need to *display* — timeout, malformed output, an engine throw. Abort is different in kind: it is the host's own bookkeeping reacting to the caller's **own** cancellation (a superseding `run()` call, since "a single in-flight request at a time" below, or the caller's own `AbortSignal` firing), not a condition about the input or the engine. The caller already knows it asked for this, so there is nothing to report as a diagnostic — and DD-08 §3's "the application never queues more than one" means every call site is expected to see this on *every* superseded request, which is exactly the shape `catch`-an-`AbortError` already has for `fetch()` and every other abortable web API. Resolving it instead would force every call site to distinguish "cancelled because I asked" from "the document is broken" by inspecting diagnostics rather than by a `catch`. Kept as the one path that rejects; implemented in `host.ts`'s `makeAbortError()`.

Engines receive `ctx.signal`; `elk` cannot be interrupted mid-run (it is synchronous GWT code), so abort on `elk` is effectively the 250 ms terminate path. This is acceptable: respawn is ~30 ms and the next layout request is already queued. **Corrected by Stage K's fix round 1 (item 7):** that premise holds for a worker whose engines are already loaded, not for a *respawned* one — a fresh worker re-imports `elk`'s ~1.44 MB chunk and re-creates the `ELK` instance (hundreds of ms, and more on a slow device) before its first elk request. So `elkEngine.layout()` checks `ctx.signal.aborted` once elkjs has loaded and before calling ELK, and rejects with an `AbortError`: a request aborted while elkjs was loading answers `'error'` promptly, the host has no reason to terminate the worker, and the loaded instance is kept. An abort that arrives *during* ELK's synchronous run still takes the 250 ms path. **Corrected again by F21:** "the next layout request is already queued" was true, but on the worker being terminated — the superseding request is posted before the escalation fires, to the same worker — so a respawn used to drop it, and the caller waited out the whole timeout for an SGL4001 and no layout. Step 5 above re-posts it. Under CPU load the check after the import does not always save the worker either: the import itself (fetch, parse, `new ELK()`) can outlast 250 ms, as can ELK's run on the boot example, so an edit made during either still respawns the worker, and the new one imports elkjs again before laying out.

A single in-flight request at a time; a new request aborts the previous one (the same `beginAbort` path — immediate `AbortError`, 250 ms escalation — as an external `AbortSignal`). The application never queues more than one (DD-08 §3).

**Isolation level:** same-origin Worker. Sufficient for bundled engines. **⟶ B17:** the `LayoutHost` interface gets a second implementation that hosts the Worker inside a null-origin iframe; the protocol is identical.

---

## 4. Host fallbacks (`layout-api/fallbacks.ts`)

**One sequence (Stage K).** `applyHostFallbacks(input, raw, capabilities, metrics)` is the whole post-engine sequence, in order: `finishEngineRoutes` (§4.4 and §4.5 for the routes the *engine* returned — see below), then `routeStraight` (the edges it left out), then `placeLabels` only for `labelPlacement: false`. `worker-runtime.ts` and the conformance harness (§8) both call it, so what the suite checks is what a real request gets. The order is load-bearing: `finishEngineRoutes` runs before `routeStraight`, so it only ever sees engine routes, and a route the fallback made (already reserved) is never reserved twice. `grid` returns no edges, so for `grid` the sequence is exactly Stage E's `routeStraight -> placeLabels` and its output is unchanged.

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

**Engine routes (Stage K, `finishEngineRoutes`).** §6.2 says the host applies this to `elk`'s routes too, so the contract is now explicit for every engine: a route an engine returns ends *on* the node (or port) boundary, and the host pulls a directed end back by `arrowSize` along the final segment, moving `end` and the route's last point together (and `start` for `both`). A missing `startNormal`/`endNormal` is taken from the end segment's own direction. An engine must therefore not reserve the arrowhead itself. The reserve is clamped so an end segment shorter than `arrowSize` is never reversed or zeroed: at least 1 px of it is kept, in its own direction, and a single segment reserved at both ends shares that budget (fix round 1, item 6).

### 4.5 Self-loops

If an engine returns a self-loop route of fewer than two segments (or none), replace it with a loop: exit the node's top-right at 45°, three `C` segments forming a teardrop of radius `max(24, node.h/2)`, re-enter at the right. Label at the loop's apex.

**Engine self-loops (Stage K).** `finishEngineRoutes` also applies this to a self-loop an engine *did* route, when the route has fewer than two segments or is under `MIN_SELF_LOOP_HEIGHT` (16 px) tall — §6.2's rule for ELK, whose unlabelled loops are a 10 px box. Because the host now owns that route, it owns its label too: an engine's label for a replaced loop is re-placed at the apex, as `placeLabels` would. The teardrop reaches outside the engine's `bounds`; `quantize`'s host-computed `bounds` (§5) takes it and its label in, like everything else drawn. A loop the engine drew at least 16 px tall is kept (and reserved like any engine route), with its label.

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
| Every `LabelPlacement.align`/`.baseline`/`.occlusion` is one of its declared enum values | `SGL4002` |
| Container `contentFrame` inside its `frame` | `SGL4003` warning |
| Child frames inside parent contentFrame (± 0.5 px) | `SGL4003` warning; not corrected — some engines overflow deliberately |

**DEVIATION:** the "contentFrame reset to frame inset by padding" correction this table originally specified for the first `SGL4003` row is **not implemented**. `validateResult`'s signature — inherited unchanged from the stub Stage E started from — returns `readonly Diagnostic[]` only; it has no way to hand back a corrected `LayoutResult`. Both `SGL4003` rows are therefore warnings with no correction, which is what the table's own second row already said for the sibling case. A future stage wiring this into a real pipeline, with a code path that can return a new `LayoutResult`, can add the correction then. `engineId` is a third parameter Stage E added, needed only to fill in `SGL4002`'s `{id}` placeholder in the message text — it plays no part in what is checked.

`SGL4002` rejects the whole result; the application keeps the previous `LayoutResult` (FR-E4 at the layout stage).

**Added by Stage H's fix round 1, item 2, filling a gap the original table's checks all assumed away:** `result`'s static type is the frozen `LayoutResult`, but that is a compile-time guarantee only — a third-party engine writes directly against `contract.ts`, and Stage H sends the value across a worker boundary as JSON, which erases the TypeScript union entirely. A buggy `layout()` can resolve `undefined`, `null`, a number, or `{}` at least as easily as a malformed `LayoutResult`, and every check this section describes assumes it can already dereference `.nodes`/`.edges`/`.labels`/`.bounds`. Found in review: an unguarded access threw a `TypeError` from inside `host.ts`'s message listener, *after* the request's timer had already been cleared, so `run()` never settled — a hang, not a diagnostic. `validateResult` now checks the outer shape first (`result` itself, then `.nodes`/`.edges` are objects, `.labels` is an array, `.bounds` is an object) and returns one `SGL4002` with a `{detail}` naming what was wrong, before touching anything else. That check (`describeShapeError`) is exported and reused by `worker-runtime.ts` (fix round 2, item 2, §3 above) — `routeStraight`/`placeLabels` make exactly the same assumptions this function does, and round 1's guard here was reachable only through a fake `Worker` that skips the fallbacks entirely, never through the real protocol.

**Added by Stage F's review round, filling a gap this table did not name:** `align`/`baseline`/`occlusion` are enumerated fields on `LabelPlacement` (§0's `contract.ts`), but the enum is a compile-time guarantee only — `@sgl/render-svg` reads all three from an engine's output, which is untrusted at runtime, and Stage H sends `LayoutResult` across a worker boundary as JSON, which erases the TypeScript union entirely. A hostile or buggy engine returning `align: 'middle"><script>alert(1)</script>'` reached the renderer unescaped before this row existed (found by review, fixed in `render-svg` alongside this check — see DD-07 §8). This is exactly Stage E task 3's charter, "a buggy engine must never corrupt the renderer," extended to a field this table had not yet covered.

**Quantization** (ADR-0004): every `x y w h`, every path point, every label frame → `Math.round(v * 64) / 64`. Applied to the validated result; the `LayoutResult` the renderer sees is always quantized.

**Bounds (F14, Stage L re-baseline).** `bounds` is recomputed by the host from the quantized result plus `canvas.margin` (`CANVAS_MARGIN`, 16 px), so engines may leave it approximate — whatever an engine returns is discarded. `quantize` (`validate.ts`) does it as its last step, so it holds for every engine and for every caller of `quantize` (`host.ts`, the conformance harness, the goldens):

1. **Extent** (`contentExtent`, `bounds.ts`): the box around every node `frame`, `contentFrame` and port point, every label `frame` (rotated about its centre when it has a `rotation`, as DD-07 §5 draws it), and every edge's `start`, `end` and route — a `C`/`Q` segment by its own extrema, not its control polygon, so the margin round a self-loop teardrop (§4.5) is the same 16 px as round a frame; an `A` segment (no shipped engine emits one) conservatively by its chord grown by its larger radius. Markers and strokes are **not** measured: the extent is the geometry's, not the ink's, and the 16 px margin absorbs the ink (see the limit below).
2. **Margin**: the extent grown by 16 on every side, rounded **outward** to the 1/64 grid.
3. **Origin**: every coordinate (frames, content frames, ports, routes, label frames) is translated so that box starts at `(0, 0)`; `bounds` is `{ x: 0, y: 0, w, h }`. The translation is a whole number of grid steps, so the result stays on the grid and a second `quantize` is a no-op. Keeping the origin at zero is what lets the application's overlay and hit-testing (DD-08 §6) keep placing `NodeLayout.frame` directly in the rendered `<svg>`'s coordinates.

**Limit: ink the extent does not measure (fix round 1 of the re-baseline, item 10).** `quantize` sees only the `LayoutResult`, not the styles, so it bounds geometry, not ink: a stroke reaches `strokeWidth / 2` past the path or frame it strokes, and an arrowhead's base reaches `0.375 · arrowSize` to either side of the (reserved) path end, `0.375 · arrowSize + max(1, arrowSize / 6) / 2` for the stroked `open` head. The margin covers that while **`strokeWidth ≤ 32` and `arrowSize ≤ 42` (`≤ 34` for `open`)** — the built-in themes use 1–1.5 and 8. Past it, ink at the outermost element can be clipped by up to the excess. Measuring the ink instead was considered and not done: node frames touch the margin in every corpus document, so adding even the built-ins' `0.75` px of stroke would move every layout and SVG golden again, outside this re-baseline's approved scope. A theme-validation warning for values past the limit needs a diagnostic code the catalogue does not have (`SGL5004` means "wrong type; ignored"), so it is left for a catalogue decision, not added here.

A result that draws nothing gets `{ x: 0, y: 0, w: 0, h: 0 }`. Before F14, `host.ts` passed an engine's `bounds` through: `elk`'s margin was ELK's own 12 px root padding, `grid`'s was 0, and `grid`'s self-loop teardrops were clipped at the canvas's top edge; the only growth was `finishEngineRoutes` taking in a teardrop it swapped in for an engine's loop, which the general recomputation replaced. Tests: `layout-api/test/validate.test.ts` (the rule), `render-svg/test/bounds.test.ts` (the corpus under both engines, curves sampled along their length, and `parallel-selfloop.sgl`'s teardrops under `grid`).

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

Loads `elkjs/lib/elk.bundled.js` (synchronous, single-thread) inside the layout worker — never `elk-worker.js`, nor `elk-api.js` with a worker URL (06 §4 pitfall 7).

**Implemented (Stage K), `packages/layout-elk/src/`:**

- **`descriptor.ts`** — id, name, capabilities, `optionsSchema`, `hintsSchema`, option defaults and `normalizeElkOptions`, as their own entry point `@sgl/layout-elk/descriptor`. The main thread's Engine ▾ and options form import it; importing the full engine object on the main thread would make the bundler emit a second, never-loaded copy of elkjs for its dynamic import, which the PWA precache would then carry too.
- **`load-elk.ts`** (**K1**) — `elk.bundled.js` is loaded by a dynamic `import()` on the first `layout()` call and the `ELK` instance cached; a failed load is not cached. elkjs becomes its own lazy chunk, excluded from the core budget.
- **`load-elk.ts`** (**K11, a scoped `document` stub**) — elkjs 0.11.1's `elk.bundled.js` (line 6430, its inlined `elk-worker.min.js`) takes its *worker* branch when `typeof document === 'undefined'` and `self` exists: it installs itself as `self.onmessage` on the worker it is loaded into and never exports its in-thread FakeWorker, so `new ELK()` fails ("_Worker is not a constructor"). Inside our layout worker that is exactly the case. So, only when `document` is absent and only for the duration of the dynamic import (and the construction), `globalThis.document = {}` is set and then deleted in a `finally`; a failed import leaves nothing behind; on a page's main thread nothing changes; the cached promise serialises loading, so two loads never race the stub. No DOM API is defined — the stub only hides the *absence* of one from elkjs for one import. `pnpm patch` (a patched copy of a 1.4 MB generated file to maintain) and revisiting ADR-0005 (reopening pitfall 7) were rejected (orchestrator decision). `elk.browser.test.ts`'s worker entry has no shim of its own, so an elkjs upgrade that changes this fails it.
- **`mapping.ts`** — §6.1 (`toElkGraph`) and §6.2 (`fromElkGraph`) as pure functions, no elkjs import; `index.ts` joins them around the ELK call. ELK is handed a deep copy (it writes its results and GWT bookkeeping into the object it is given).

### 6.1 Input mapping

```
root ElkNode:
  id: 'root'
  layoutOptions:
    'elk.algorithm':                 'layered'
    'elk.direction':                 DOWN|UP|LEFT|RIGHT
    'elk.hierarchyHandling':         'INCLUDE_CHILDREN'
    'elk.randomSeed':                '1'          // ADR-0005 spells it org.eclipse.elk.randomSeed; same option
    'elk.edgeRouting':               options.edgeRouting
    'elk.spacing.nodeNode':          nodeSpacing
    'elk.layered.spacing.nodeNodeBetweenLayers': rankSpacing
    'elk.spacing.edgeLabel':         metrics.spacing.edgeLabel
    'elk.layered.nodePlacement.strategy': options.nodePlacement
    'elk.nodeLabels.padding':        '[top=0,left=0,bottom=0,right=0]'   // Stage K
  children: map(visible rootChildren, toElkNode)
  edges:    map(all edges, toElkEdge)          // ALL edges live on root — valid under INCLUDE_CHILDREN

toElkNode(n):
  id: n.id
  width/height:  sizing.fixed ?? clamp(sizing.intrinsic, min, max)      // leaves
                 (omitted for containers — ELK sizes them from children + padding)
  labels: leaf ? [{ text: labelId,                           // Stage K: never '' (ELK ignores it)
             width: label.w + box.l + box.r, height: label.h + box.t + box.b,   // the label box, below
             layoutOptions: { 'elk.nodeLabels.placement': '[H_CENTER, V_CENTER, INSIDE]' } }]
          : []                                               // containers: title not sent (note 2)
  ports: map(n.ports, p => ({ id: n.id + '#' + p.id, width: 0, height: 0,          // Stage K: portSize unseen
                              layoutOptions: { 'elk.port.side': NORTH|SOUTH|EAST|WEST } }))
  layoutOptions (a valid portConstraints hint — ELK's PortConstraints enum — or else any node with ports):
                              { 'elk.portConstraints': hint ?? 'FIXED_SIDE' }    // unknown hint values skipped
  layoutOptions (containers): { ...the four per-level options of the root (spacings, nodeLabels.padding),
                                'elk.padding': `[top=${padding.t},left=${l},bottom=${b},right=${r}]`,
                                // min width = max(min.w, title.w + contentInset.l + r); swapped (h,w) for DOWN/UP:
                                'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${min.w},${min.h})` }
  children: map(visible n.children, toElkNode)      // a container whose children are all hidden is a leaf

toElkEdge(e):
  id: e.id
  sources: [ e.from.port ? e.from.node + '#' + e.from.port : e.from.node ]
  targets: [ likewise ]
  labels: e.labelId ? [{ text: labelId, width, height, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] : []
  layoutOptions: { 'elk.layered.priority.direction': hints.priority }   // when present
```

`directed: 'none'` and `'both'` are still passed as directed edges (ELK is layered; direction drives rank). Arrowheads are the renderer's concern.

**What running elkjs 0.11.1 changed (Stage K).** This pseudocode is amended in place above; each change was found by running ELK, and each is pinned by `packages/layout-elk/test/mapping.test.ts` or `elk.test.ts`:

1. **Label text.** A label whose `text` is empty is ignored — ELK neither places it nor reserves room for it. Labels are sent with their `LabelId` as text (ELK never measures text).
2. **Container title placement.** `[H_LEFT, V_TOP, INSIDE]` on a container makes ELK reserve a *left column* as wide as the title as well as the top band, pushing every child right by the title's width. *(Observation unchanged; conclusion replaced by Stage K fix round 1, item 1.)* Container titles are **top-left**, as §4.1 specifies and `grid` places them: the title is **not sent to ELK at all**; `elk.padding.top` is the whole `NodeSizing.padding.top` (the title band counted once), the title's width plus `contentInset.l + r` is a minimum container width (so a long title cannot overflow), and `fromElkGraph` places the title at ELK's container frame inset by `contentInset`, align `start`, baseline `top`. The reviewer's `[H_LEFT, V_TOP, INSIDE, V_PRIORITY]` produces byte-identical layouts (pinned by `elk.test.ts`), but only because `V_PRIORITY` is not a member of ELK's `NodeLabelPlacement`: ELK rejects the whole value and then neither places nor reserves anything for that label. Not sending the title does the same without depending on a parse failure. So "labels come from ELK" holds for leaf titles and edge labels; a container title comes from ELK's container frame. The Stage K first-cut `[H_CENTER, V_TOP, INSIDE]` (centred titles) is gone.
3. **Title band and padding.** ELK adds a title band of its own for a title it is given (a child starts at `elk.padding.top + label height`). It is given none (note 2), so `elk.padding.top` is all of `padding.top`.
4. **`elk.nodeLabels.padding` is read from a node's parent**, not the node, and defaults to 5 px on every side. It is zeroed on the root and on every container, so the label boxes below are the only insets in play.
5. **Spacing options are per level.** Under `INCLUDE_CHILDREN`, `elk.spacing.nodeNode`, `…nodeNodeBetweenLayers` and `elk.spacing.edgeLabel` set on the root do not reach a container's children; they are repeated on every container.
6. **`elk.nodeSize.minimum` is not transposed** for `DOWN`/`UP`: ELK applies the pair as (height, width) there, so it is sent swapped for those directions. (No document can set a container minimum today — `minWidth`/`minHeight` apply to leaves only in the style registry — but the mapping honours one.)
7. **`portSize` is unseen.** It is a style (`geometry.portSize`), and engines never see `StyledGraph`; ports are sent zero-sized, so a port's point is on the node boundary and the renderer draws its circle there.
8. **Label boxes.** §4.1 centres a leaf's title in its *content box* (frame inset by `contentInset`); ELK centres a label in the *frame*. They differ only where insets are asymmetric (a cylinder's cap, a package's tab), so ELK is given the label grown by the asymmetric part of the insets, on the side that needs it. The `LabelPlacement` frame is that box exactly as ELK placed it; `align`/`baseline` (`start`/`end`, `top`/`bottom`) put the text at its inner edge.
9. **Seed.** `elk.randomSeed: '1'` (K2). Two runs are identical after quantization in Node and in a Chromium worker, and ELK's quantized output in Chromium equals Node's golden byte for byte (`elk.browser.test.ts`).

### 6.2 Output mapping

ELK coordinates are **relative to the parent node**. Walk the tree accumulating offsets. **Edges (sections and labels) are relative to the node ELK names in the edge's output `container` field** — the lowest common ancestor of the endpoints ELK moves the edge to — *not* always the root they were declared on (corrected by Stage K; the earlier text said "here root, so absolute"). `fromElkGraph` offsets each edge by that node's absolute origin:

```
NodeLayout.frame        = { x: abs.x, y: abs.y, w: node.width, h: node.height }
NodeLayout.contentFrame = frame inset by sizing.padding (containers)
NodeLayout.ports[p]     = { point: abs(port.x + port.width/2, port.y + port.height/2), normal: bySide }
EdgeLayout              = every section, in order: start = sections[0].startPoint, route = each section's
                          bendPoints and endPoint as L segments (a section's startPoint is dropped when it
                          repeats the previous point). Stage K fix round 1 (item 9): the code concatenates
                          all sections, which this line used to describe as sections[0] alone; a simple
                          edge has exactly one section, so the two agree on every corpus document
                          startNormal/endNormal from the first/last segment direction; clip: 'none' (ELK already stops at the boundary)
LabelPlacement (leaf)   = frame at abs(node) + label.x/y, size from label (the label box, §6.1 note 8); align/baseline from the box
LabelPlacement (cont.)  = frame at frame + (contentInset.l, contentInset.t), size = measured title, align start, baseline top (§6.1 note 2)
(a coordinate or size ELK left out — x, y, width, height, of a node, port or label — maps to NaN, never 0, so
 validateResult rejects the result with SGL4002; fix round 1, item 5)
LabelPlacement (edge)   = frame at abs(container) + label.x/y, align 'middle', baseline 'top', occlusion 'plate'
bounds                  = { 0, 0, root.width, root.height }   (advisory: the host replaces it, §5)
(an edge ELK returns without a section is left out, so routeStraight fills it; an id ELK returns that was never sent throws → SGL4011)
```

**Routes round a container's title (F16, `avoidTitle` in `mapping.ts`; fix round 1).** ELK is not given a container's title (§6.1 note 2), so it may run an edge into (or out of) the container straight through it: the title sits in the band `elk.padding.top` reserves, and to ELK that band is empty padding. After every route is mapped, `fromElkGraph` takes each container with a title, outer containers first, and each *run*: a vertical segment (within 1e-6 px) of a route that passes from above the title's text box to below it, where the container is an ancestor of the run's far end (the target, or the source for a run going up, e.g. under `direction: up`). A route through the title of a container that holds neither end is a K4 crossing and is left alone.
- **Shapes.** Every detour turns right in the strip above the title and passes the title `TITLE_GAP` (4 px) to its right. Then: (a) **turn back** to its own x in the gap below the title, when what is left of the run below the gap is long enough: any length before another bend, or `arrowSize` + 4 px before the route's end (so a deep end, and a port, keep their last segment and arrowhead); otherwise, for a run that ends on its node (not a port) at the band's bottom, (b) **end on the node's top** at the new x, when that x is at least `0.375 × arrowSize` (half the arrowhead) inside the node's right corner, or (c) **enter the node's side**: down to the node's middle at `x = max(new x, node right + arrowSize + 4)` and into its right side, so the last segment is at least `arrowSize` + 4 px long and the arrowhead is clear of the title. (a) and (b) stay in the band, where there is no node; (c) is the only shape that leaves it, into the container's first layer, and is not made if it would meet another child of the container. A port end is never moved.
- **Stacking.** The runs through one title are sorted right to left. The `m` rightmost are stacked, nested: the rightmost furthest right, turning highest and turning back lowest, each `max(4, 0.75 × arrowSize + 1)` px from the next, so their arrowheads never touch. A detour is not made if any of its new segments meets (touching counts) another route, or another detour already planned; then the whole stack is tried again with one run fewer. The runs left alone are therefore all left of every detour, which never crosses them: a detour never adds a crossing (`elk.test.ts` checks every corpus document against the undetoured mapping).
- **Left alone.** A band too thin to hold a detour leaves the route as ELK drew it: no room above the title (`padding: 0` puts the title at the container's top edge), or for a turn-back, none below it (`titleGap: 0`); a run whose far end is a port that it cannot turn back before; a run whose detour would meet another route. In the corpus that leaves four, all in `wildcards`: ELK runs three more edges into `lane2` 0.4–20 px right of its title, and one into `fan2` 0.8 px right of its title, so no detour to the right can miss them.
- **Routing modes.** The engine asks for the detours (`fromElkGraph`'s `arrowSize`) under ORTHOGONAL and POLYLINE, whose points are vertices; not under SPLINES, whose points are control points, where an orthogonal jog would bend the curve. Only vertical runs are detoured; horizontal runs through a title (`direction: left`/`right`) are out of scope.

The added coordinates are on the 1/64 px grid; only those runs change, and the routes stay orthogonal. Source-level fixes were tried first and do not work (07 §2): sending the title as a container label with `[H_LEFT, V_TOP, INSIDE]` or `[H_LEFT, V_TOP, INSIDE, H_PRIORITY]` removes every crossing only because ELK then reserves a left column as wide as the title and moves every child right of it (18 corpus documents' node frames change); `[H_CENTER, V_TOP, INSIDE]` leaves all 13; `elk.hierarchyHandling: SEPARATE_CHILDREN` on containers makes ELK throw on 10 documents. ELK's layered router does not treat a node label, or padding, as an obstacle for an edge entering its own ancestor.

Then the host applies §4.4 (arrow reserve) and §4.5 (self-loops — ELK routes them but with a tight box; the host's teardrop is used when ELK's loop is under 16 px tall). **Implemented (Stage K)** as `finishEngineRoutes` inside `applyHostFallbacks` (§4), in the worker runtime like every engine's fallbacks — not in the adapter. Labels are never touched by the host for `elk` (`labelPlacement: true` skips `placeLabels`), except a replaced self-loop's own label (§4.5).

### 6.3 Known ELK behaviours to test around (06 §4 pitfall 8)

- Hierarchy-crossing edges with `ORTHOGONAL` occasionally route through a sibling container. The corpus includes this case; the mitigation is the `edgeRouting` option, and the test asserts no route segment intersects an unrelated container's frame — a *warning* in CI, not a failure, until the rate is known. **Stage K (K4):** `hierarchyCrossings` (`@sgl/layout-api/conformance`) counts, per document, the (edge, container) pairs where a route passes through the frame of a container enclosing neither endpoint (the frame shrunk by 0.5 px, curves sampled). It is logged by `elk.test.ts`, never failed. Measured: **0 on every corpus document** under `ORTHOGONAL`, and 0 for `containers-edges.sgl` under both `ORTHOGONAL` and `POLYLINE`.
- **An edge can cross a container's title** (Stage K, found by inspection; the K4 check does not see it, the container being the endpoint's own ancestor). Fix round 1 (item 2) counts it: `titleCrossings` (`@sgl/layout-api/conformance`) counts route segments through any container's title *text* (its measured size, placed by align/baseline, shrunk 0.5 px), endpoints' ancestors included. Per corpus document, under ORTHOGONAL — with the first-cut centred titles: `checkout` 2, `containers-edges` 1, `forty-three-level` 1, `nesting-3` 2, `wildcards` 1, `n50` 4, `n500` 49, `n2000` 199; with titles top-left (§6.1 note 2): `checkout` 2, `containers-edges` 1, `nesting-3` 1, `wildcards` 4, all others 0. ELK knows nothing of a title it is not given, and none of ELK's own mitigations tried removes the rest: `elk.layered.considerModelOrder.strategy: NODES_AND_EDGES` on containers makes ELK throw on 8 corpus documents; `elk.layered.mergeHierarchyEdges: false` and `elk.spacing.labelNode` change nothing; `FIXED_SIDE` port constraints on containers move the crossings (5 in `wildcard-globs`). They were a pinned, counted warning (`elk.test.ts`) until **F16**: `fromElkGraph` now detours those runs round the title (§6.2), and under ORTHOGONAL `titleCrossings` is **`wildcards` 4, all others 0** (pinned by document and by edge): the four cannot be detoured without meeting another route. The detour applies to vertical runs under ORTHOGONAL and POLYLINE, never under SPLINES.
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

Everything above but `layout()` is `gridDescriptor`, its own entry point `@sgl/layout-std/descriptor` (F20), which `gridEngine` spreads. The main thread imports only the descriptor (Engine ▾, SGL4010's schemas), as it does `@sgl/layout-elk/descriptor` for `elk`; the packing code below is bundled into the layout worker alone (`check-core-chunks.mjs` checks).

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

**Implemented (Stage K), `packages/layout-api/src/conformance.ts`.** `runConformance(engine, cases, { metrics, now, timedCase, options?, timeoutMs? })` runs each case through `runHostSequence` — `engine.layout -> applyHostFallbacks -> quantize(…, 64)`, the real request's sequence in one process — and returns a report with every failure of checks 1–6 as text, plus the K4 crossing counts (§6.3) as warnings. **Check 1 fails on *error* diagnostics only**; a warning such as `SGL4003` is reported in the case's `validation` but passes (fix round 1, item 9). Cases are `LayoutInput`s the caller builds (this package may not import `@sgl/theme`/`@sgl/measure`); the clock is injected (`performance.now` is banned below `apps/web`). Check 2 compares the quantized results (and, for `bitwise` engines, the raw ones too) and skips `best-effort`. Check 4's budget defaults to the host's own timeout for that engine. Check 5 reads the engine's *raw* output, before any fallback. The suites: `layout-elk/test/conformance.test.ts` and `layout-std/test/conformance.test.ts`, each over every corpus document plus a 1 000-node graph built in memory from `bench/scale-document.js` (the same generator as `n50`/`n500`/`n2000`). Both pass. Measured (K10): `elk` 1 000 nodes ≈ 0.84 s in Node (host sequence included) and ≈ 1.07 s round trip in a Chromium worker, against its 10 s timeout; `grid` ≈ 13 ms.

For each corpus graph (empty, one node, one edge, self-loop, parallel edges, 3-deep nesting, container-to-container edge, boundary-crossing edge, disconnected components, 1 000 nodes, extreme aspect):

1. Result passes `validateResult`.
2. Run twice; results byte-identical after quantization (`bitwise`/`quantized` engines).
3. No two sibling frames overlap — leaves and containers alike (fix round 1, item 18: it compared leaf pairs only); a container may enclose its own descendants.
4. Completes within the engine's timeout on the 1 000-node graph.
5. Engines claiming `labelPlacement: true` return a `LabelPlacement` for every label.
6. **Every edge is attached** (fix round 1, item 11): each routed edge's `start` lies within `arrowSize + 1` px of its source's frame (or its port's point, for a port-terminated end), and its `end` likewise of its target's — `arrowSize` because the host pulls a directed end back by exactly that (§4.4). An edge drawn in the wrong coordinate system (a container offset lost or doubled) fails it; nothing else did. `detachedEdges`; `grid` and `elk` pass it over the corpus. `layout-elk/test/elk.test.ts` also checks, per directed edge, that the end sits `arrowSize` ± 0.5 px off its node's frame (the reserve applied exactly once).

---

## 9. Diagnostics

| Code | Severity | Message template |
|---|---|---|
| `SGL4001` | error | Layout engine `{id}` did not finish within {ms} ms and was stopped. Showing the previous layout. |
| `SGL4002` | error | Layout engine `{id}` returned invalid geometry ({detail}). Showing the previous layout. |
| `SGL4003` | warning | `{node}` extends outside its container after layout. |
| `SGL4010` | warning | `@layout.{key}` is not an option of engine `{id}`; ignored. — **implemented** (Stage K fix round 1, item 23): a container-level `@layout.engine` naming another engine (B8/B9), and any `@layout` key the effective engine does not declare (§2) |
| `SGL4011` | error | Layout engine `{id}` failed: {message}. |
| `SGL4021` | warning | `@pin` is not honoured by engine `{id}`; ignored. **Implemented** (`feat/b5-pin`, DD-12 N6, H4, H5): from `layoutConfigDiagnostics`, on the main thread, at the key. It fires once per node whose engine does not declare `capabilities.pins`. Fixture: `corpus/layout/pin-under-elk.sgl` |

An engine may emit a warning or info row of this table through `LayoutResult.notes`
(§2, §3). The host drops an `error` row, because an engine that fails throws.
`SGL4020` (DD-12 N9) is allocated and arrives with `fixed` (`feat/b5-fixed`).

---

## 10. Tests

- Host: timeout → terminate/respawn → `SGL4001`; abort within 250 ms; abort escalation; single in-flight guarantee; measure-miss round trip; a stale message from a superseded/respawned worker is discarded; `run()` after `dispose()` rejects immediately. **Implemented three ways** (Stage H, extended in fix round 1): `packages/layout-api/test/host.test.ts` drives `createWorkerHost` under Node with a fake `Worker` + fake timers; `packages/layout-api/test/browser/host.browser.test.ts` repeats the four gate conditions (timeout, abort, SGL4002, measure-miss) against a **real** `Worker`, in Chromium and Firefox, via `fixture.worker.ts`'s synthetic test engines; `packages/layout-api/test/host-runtime.integration.test.ts` (fix round 1, item 7; extended in round 2, item 2, with an engine resolving `undefined` giving `SGL4002` through the real protocol, not `SGL4011`) wires the real host to the real `createWorkerRuntime` through an in-memory channel with genuinely asynchronous (`queueMicrotask`) delivery, at Node speed, so protocol drift between the two halves is caught by `pnpm test:unit` too, not only by the slower browser project.
- Worker runtime: `packages/layout-api/test/worker-runtime.test.ts` drives `createWorkerRuntime` under Node with a fake port — engine lookup miss, sync/async throw, abort, the measure round trip (including two concurrent requests with out-of-order replies, fix round 1 item 8), seeded `ctx.random`, `ctx.log`, `ctx.sublayout` rejecting, that the host fallbacks are actually applied before `'result'` is posted (fix round 1, item 3), and that they are *skipped* — posting a malformed `raw` result through unchanged, as `'result'` not `'error'` — for an engine whose output fails the shape check (fix round 2, item 2).
- Fallbacks: each of §4.1–4.6 against fixture geometry, goldens. *(Stage E, unchanged by Stage H.)*
- Validation: one fixture per row of §5's table, plus (fix round 1, item 2) `undefined`/`null`/a number/`{}`/`{nodes: null, ...}` each producing one `SGL4002`, not a throw. *(Stage E's fixtures unchanged; the shape-guard cases are new.)*
- Quantization: values on both sides of a 1/128 boundary. *(Stage E, unchanged by Stage H.)*
- `elk` mapping: input goldens (the `ElkNode` JSON we send) and output goldens; the hierarchy-crossing corpus case. **Implemented (Stage K):** `packages/layout-elk/test/mapping.test.ts` (both mappings against the pure functions, the output half placing every label at ELK's own coordinates), `elk.test.ts` (every corpus document validates with no diagnostics; input and output goldens for `CLEAN_DOCS` under `test/__goldens__/{input,result}/`; labels are ELK's end to end and through the real worker runtime; an ELK exception becomes `SGL4011`; K4 counts; every option reaches ELK), and `test/browser/elk.browser.test.ts` (a real Chromium `Worker`: double run, Node ≡ Chromium, labels, repeated requests after load — K11's tripwire — and the 1 000-node time).
- `grid`: goldens; bitwise double-run **in Node, over the whole corpus** (Stage E's own gate, `layout-std/test/grid.test.ts`) **and, since fix round 1, through a real `Worker`, across Chromium, Firefox and Node itself**: `packages/layout-std/test/browser/grid.browser.test.ts` runs the real `gridEngine` through the real `createWorkerHost`, via its own dedicated worker entry (`grid.worker.ts`, deliberately separate from `layout-api`'s synthetic-engine fixture worker) and a Node-precomputed `LayoutInput` (`bench/generate-grid-fixture.js`, off `n50.sgl`, the same "precompute in Node, ship as data" shape `generate-render-fixtures.js` established). Two tests, both running in Chromium and Firefox (the browser project runs every file once per browser instance): a same-browser double-run, and — **fix round 2, item 1**, correcting round 1's overclaim — a comparison against an **expected** `LayoutResult` the same generator script also computes in Node, by running the exact sequence `host.ts`/`worker-runtime.ts` run for a real request (`gridEngine.layout -> routeStraight -> placeLabels -> quantize(…, 64)`). Round 1 asserted only the same-browser double-run, which proves determinism *within* each browser but never compares one browser's output to another's or to Node's — not what "bitwise double-run across Chrome and Firefox" means. The Node-vs-browser comparison is what actually proves it, and it holds: Node's precomputed `expected`, Chromium's own run and Firefox's own run are all byte-identical (`JSON.stringify` equal) for `n50.sgl`. The earlier claim that registering `gridEngine` in a real worker broke it was traced to an unrelated, intermittent Vite dev-server cache issue (§3's operational note), not a defect — clearing it and re-testing worked cleanly, and surfaced a **real** gap on the way: `worker-runtime.ts` was never applying the host fallbacks at all (§3's "every message is bound to the worker instance" paragraph's sibling fix, documented in §3 above), and — found only once the fallbacks ran unconditionally (**fix round 2, item 2**) — never guarded against a malformed `raw` result either: `routeStraight`/`placeLabels` assume the same shape `validateResult` does, so an engine resolving something other than a `LayoutResult` (e.g. `undefined`) made `routeStraight` throw *inside the worker's own try/catch*, turning a validation-shaped failure (`SGL4002`, host-side) into a worker-side `SGL4011` carrying a raw `TypeError` message. Fixed by reusing `validate.ts`'s shape check (`describeShapeError`, exported for exactly this) to skip the fallbacks and post a malformed `raw` through unchanged, so `host.ts`'s own `validateResult` is what rejects it.
- Conformance suite on both engines. **Implemented (Stage K)** — §8.
