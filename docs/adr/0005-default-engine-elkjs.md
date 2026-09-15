# ADR-0005 — elkjs is the default layout engine

**Status:** Accepted · **Date:** 2026-09-14 · **Resolves:** Design review finding 1

## Context

Phase 1 originally scheduled an in-house `layered` engine: Sugiyama with compound (nested container) support and orthogonal routing. Compound hierarchical layout is research-grade work — ELK's layered algorithm represents well over a decade of professional effort — and the honest estimate put it at more than half of a 6–9 month phase 1.

The architecture already treats engines as plugins behind a narrow interface. That interface has never been exercised by an engine its authors did not write.

## Options

**A. Write `layered` in-house for v1.** Full control; smallest bundle; months of critical path; and the plugin interface is validated only by engines shaped to fit it.

**B. dagre.** Small (~tens of kB), deterministic, well known. But compound support is nominal, there are no ports and no orthogonal routing. It is the reason Mermaid layouts look the way they do.

**C. elkjs.** Compound graphs (`hierarchyHandling: INCLUDE_CHILDREN`), ports, orthogonal/polyline/spline routing, node-label and edge-label placement including compound-node titles, deterministic layered algorithm (`randomSeed` defaults to 1), pure JS, runs in a Worker. Large: on the order of several hundred kB minified — to be measured, but certainly over the 180 kB core budget on its own.

## Decision

**Option C. elkjs is the default engine for the MVP and v1.0.** The in-house `layered` moves to the roadmap as a future replacement, not a v1 deliverable.

Implementation notes:
- Use `elk.bundled.js` (synchronous) *inside* our layout worker — not elkjs's own worker build, which would nest a worker inside a worker.
- Pin `org.eclipse.elk.randomSeed: 1`; declare `determinism: 'quantized'` (ELK uses floating-point coordinate assignment and some trigonometry in spline routing).
- Expose `edgeRouting` as an engine option, default `ORTHOGONAL`, with `POLYLINE` as the escape hatch for hierarchy-crossing artefacts.
- Lazy-load the engine chunk. The core budget (NFR 4.1) covers parser, IR, renderer and `grid`; engines load on first use.
- Map ELK's label positions into `LayoutResult.labels` so B2 (engines place titles) holds for the default engine, not just in-house ones.

## Consequences

- Removes the largest single item from the critical path — the MVP estimate drops from 5–6 months to 6–8 weeks.
- The plugin interface is validated in week one by a mature engine nobody here wrote. If elkjs does not fit behind `LayoutEngine` cleanly, that is the most valuable finding possible and it arrives early.
- "Custom engines are pluggable" is more credible when the default engine arrived through the plugin interface.
- The core bundle budget now explicitly excludes engines. First render of a layered diagram costs one lazy chunk fetch; the PWA precaches it.
- A dependency too large to fork. Accepted: the interface makes replacing it a configuration change, and the in-house `layered` remains the long-term answer if elkjs stalls.
- Anything elkjs cannot express (a layout hint it does not support) surfaces as an honest engine-capability gap rather than a missing feature of ours — which is what the `hintsSchema` is for.
