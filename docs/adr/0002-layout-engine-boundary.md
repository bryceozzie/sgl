# ADR-0002 — Where the layout engine boundary sits

**Status:** Proposed · **Date:** 2026-09-14

## Context

Layout engines are the headline extension point: they must control node positions, container bounds, edge routes, and label/title placement. The question is what crosses the boundary, and how much an engine author has to implement before anything works.

Two failure modes to avoid:

- **Boundary too low** (engine emits SVG): every engine re-implements theming, escaping, accessibility, and export. Themes stop working across engines. This is effectively what Graphviz does, and why Graphviz output cannot be re-themed.
- **Boundary too high** (engine emits only node coordinates): the platform owns edge routing and label placement, so an engine cannot express an orthogonal bus layout or a rotated container title. This is roughly Mermaid's position and the source of its most common complaint.

## Decision

The engine consumes a **frozen semantic graph plus pre-computed measurements** and returns **pure geometry**: node frames, container content frames, edge routes as path segments, arrowhead normals, and explicit label placements. No colours, no SVG, no DOM.

Three supporting decisions make this workable:

**1. Capability negotiation.** An engine declares what it does. `labelPlacement: false` means the host runs its default label placer over the engine's output; `edgeRouting: 'straight'` means the host draws straight lines clipped to shape boundaries. A minimal viable engine implements node positioning only — perhaps 60 lines — and still produces a complete, themed, accessible diagram. Sophistication is opt-in.

**2. Measurement is injected, not performed.** The engine is handed a measurement table covering every label in the graph and a `Measurer` for anything it creates. It never touches a canvas or the DOM, which is what allows it to run in a sandbox and in a Cloudflare Worker.

**3. Sublayout delegation.** `ctx.sublayout(engineId, scope)` lets an engine hand a container's interior to a different engine. This is what makes per-container `@layout.engine` work, and it means a specialist engine (a rack layout, a floorplan) can be dropped into one corner of an otherwise conventional diagram.

## Consequences

- Themes and engines compose freely: every engine works with every theme, and neither author has to know about the other.
- Server-side and client-side render share the entire path, satisfying the determinism requirement.
- Engines are sandboxable, because geometry is plain structured-cloneable data.
- The host must validate returned geometry. A third-party engine returning `NaN` or referencing an unknown node must produce a clean diagnostic, not a corrupted render.
- Anything requiring appearance-aware layout (e.g. "shrink the font until it fits") needs an explicit metric contract in `ResolvedThemeMetrics` rather than direct theme access. Accepted cost.
- `LayoutResult` is the compatibility surface. It is versioned via `apiVersion`, and additions must be optional fields.
