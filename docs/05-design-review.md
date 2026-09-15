# SGL — Design Review

**Question:** is the concept durable, sustainable and maintainable?
**Date:** 2026-09-14 · reviewing the design after the feature triage.

---

## Verdict

| | Assessment |
|---|---|
| **Durable** — will the core idea still be right in three years? | **Yes.** The three-way separation of semantic graph, layout and theme is the correct decomposition, and it is precisely what the incumbents got wrong. Nothing in the triage weakened it. |
| **Sustainable** — can a small team keep it alive? | **Conditionally.** The design currently commits to *six* independent compatibility surfaces and an in-house compound layout engine. Both need cutting back. |
| **Maintainable** — will it resist rot? | **Yes, if** the conformance suite and quantized golden tests are built in phase 1 rather than phase 3. They are the mechanisms that keep the plugin API honest, and they are currently scheduled too late. |

**The single biggest threat is not architectural — it is scope.** Specifically, the assumption that a compound Sugiyama layout engine is a v1 deliverable. Finding 1.

---

## What is structurally sound

Stated plainly so the findings below are read in proportion.

- **The separation holds under pressure.** The triage promoted sequence diagrams and elkjs to Should and demoted per-container engines to Could, and none of it required reopening the boundaries. A design that absorbs a 32-item scope change without structural damage is a good design.
- **Capability negotiation is the best idea in the system.** Letting an engine declare `labelPlacement: false` and having the host fill the gap is what makes a plugin ecosystem plausible instead of aspirational. Most plugin systems fail because the minimum viable plugin is too large.
- **Error-tolerant parsing plus last-good-render** is a genuine differentiator that costs almost nothing and is very hard to retrofit.
- **Client-side-first** yields the PWA, the privacy story, and near-zero hosting cost as consequences rather than features.

---

## Finding 1 — The v1 layout engine is the long pole, and it is longer than the plan admits

**Severity: high. This is the finding that decides whether the project ships.**

Phase 1 lists `layered` — a Sugiyama pipeline with cycle breaking, layer assignment, crossing reduction, coordinate assignment, **nested compound containers**, and orthogonal routing with obstacle avoidance (B20, Should).

That last combination is the hard part. Hierarchical layout of *flat* graphs is a well-understood weekend-to-fortnight problem. Hierarchical layout of *compound* graphs — where containers nest arbitrarily and edges cross container boundaries — is a research-grade problem. ELK's layered algorithm represents well over a decade of sustained work by people who do this professionally, and it is still where most of its bug reports land.

Honest estimate for phase 0 + 1 as currently scoped, for one experienced developer: **6–9 months, with `layered` accounting for more than half of it.** Every other phase-1 item — parser, IR, theme cascade, `@sgl/text`, the editor loop — is measured in weeks.

### Recommendation: do not write the default engine for v1

Promote **B15 (elkjs adapter)** from Should to the **default engine**, and reclassify the in-house `layered` as a later replacement.

Why this is the right call rather than a retreat:

- **It removes the long pole entirely.** Months of the critical path, gone.
- **It is the strongest possible validation of the plugin API.** If a mature, complex, externally-authored engine fits behind the `LayoutEngine` interface without contortion, the interface is proven. If it does not fit, that is the most valuable thing you could learn, and you learn it in month one instead of month nine. No in-house engine can tell you this, because an in-house engine will be quietly shaped to fit.
- **Every architectural property survives.** elkjs is pure JS, runs in a Worker, takes injected dimensions rather than measuring text itself, and is deterministic for its non-force algorithms.
- **It changes nothing about the vision.** "Custom layout engines are pluggable" is more credible, not less, when the default one arrived through the plugin interface.

**The cost, stated honestly:** elkjs is large — on the order of several hundred kB minified, which needs measuring but will certainly blow the 180 kB core bundle budget in NFR 4.1. Mitigation: the budget covers the *core* (parser, IR, renderer, `grid`); engines lazy-load. Initial paint stays fast, and the first render of a layered diagram costs one chunk fetch. That is a fair trade for removing half the schedule.

**The residual risk:** a dependency that large is one you cannot easily fork or fix. Accept it as the v1 default, keep the in-house `layered` on the roadmap, and let the plugin interface make the eventual swap a configuration change rather than a rewrite — which is exactly what the architecture was built for.

---

## Finding 2 — The determinism guarantee cannot be met as written

**Severity: high. It is a stated NFR that is provably false for some engines.**

NFR-1 promises byte-identical SVG across browser, CLI and Worker. ADR-0003 correctly handles the text-measurement half. It does not handle the arithmetic half.

`Math.sin`, `Math.cos`, `Math.pow`, `Math.exp` and `Math.atan2` are **implementation-approximated** in ECMAScript — the spec does not require a specific result. V8, SpiderMonkey and JavaScriptCore differ in the final bits. So:

- `radial` (concentric placement) uses trigonometry directly.
- `force` accumulates hundreds of iterations, so a last-bit difference in iteration 1 is amplified, not absorbed.
- Spline edge routing uses trigonometry for tangents and normals.

Basic arithmetic (`+ - * /`, `sqrt`) *is* exactly specified by IEEE 754 and is safe. So `grid`, `tree`, `fixed` and a well-written `layered` are fine; the trigonometric and iterative engines are not.

### Recommendation: scope the guarantee per engine, and quantize output

Two changes, recorded in [ADR-0004](adr/0004-scope-of-determinism.md):

1. **Quantize all geometry at the layout/render boundary.** Round every coordinate to a fixed grid (1/64 px) before serialization. This absorbs last-bit divergence for everything except iterative amplification, and costs one pass.
2. **Add a `determinism` capability to `LayoutEngine`:** `'bitwise' | 'quantized' | 'best-effort'`. The host records it, the render cache keys on it, and `best-effort` engines are excluded from the cross-environment golden test rather than making it flaky.

This turns an unfalsifiable marketing claim into a testable, per-engine property — which is more useful to a user deciding whether to commit diagrams to git.

---

## Finding 3 — The metrics/paint split is enforced by convention, so it will leak

**Severity: medium-high. It will generate a long tail of "why did my diagram move" bugs.**

The split is the right idea and a real differentiator. But the design as written places properties on one side or the other **by author judgement**, and the spec already contradicts itself: `strokeWidth` appears in `metrics.stroke` *and* in `paint.byClass.Critical.strokeWidth`.

It is not an isolated slip, because several properties genuinely affect both:

| Property | Looks like paint | Actually affects geometry |
|---|---|---|
| `strokeWidth` | a border colour's thickness | outer bounds, so container packing |
| `radius` | rounded corners | edge attachment point on a rounded shape |
| `fontSize` in an inline `@style` | text appearance | label size, so node size |
| `padding` set on a class | spacing | container content frame |

Under the current design, a class that bumps `strokeWidth` to 3 takes the paint-only path, skips re-layout, and nodes silently overlap.

### Recommendation: make the split structural, not editorial

Declare the axis in the theme property schema itself:

```ts
interface StyleProperty {
  name: string;
  affects: 'geometry' | 'paint';   // declared once, per property, centrally
}
```

The cascade resolver then computes **two hashes** per element — a geometry hash and a paint hash — by partitioning resolved properties on `affects`. Layout invalidates on geometry-hash change; the renderer alone re-runs on paint-hash change.

This makes the optimisation mechanical rather than a discipline, and — the real win — a newly added property **cannot land on the wrong side by accident**, because it has to declare itself.

---

## Finding 4 — The plugin API has no ageing story

**Severity: medium. Not urgent; becomes unfixable if left.**

`apiVersion: 1` is carrying a great deal of unexamined weight. Unanswered:

- When `apiVersion: 2` arrives, do v1 engines keep working? For how long?
- Who tests third-party v1 engines against a new host?
- `hints: Record<string, unknown>` is untyped. Engine-specific keys like `@layout.rankSep` are magic strings with no validation, no autocomplete and no discoverability — and once people depend on them, they are frozen forever without ever having been designed.

The untyped `hints` bag is the specific thing that kills plugin APIs. It becomes the de facto interface precisely because it is the path of least resistance.

### Recommendations

- **Adapter, not a frozen interface.** The host normalizes older engine versions into the current internal shape. One adapter per retired version, deleted on a published schedule. Cheaper than freezing the interface forever, and honest about the cost.
- **Engines declare a `hintsSchema`** alongside `optionsSchema`. Hints then get validation, editor autocomplete, and generated documentation — and an undeclared hint is a warning rather than silent nothing.
- **Promote B18 (conformance suite) to the phase where the plugin API first ships.** It is currently Should/phase 3. The conformance suite *is* the contract; without it, "apiVersion 1" means whatever the host happens to do this week.

---

## Finding 5 — Six compatibility surfaces is too many for a small team

**Severity: medium. This is the sustainability finding.**

Each of these needs versioning, migration, documentation and a deprecation policy, indefinitely:

1. `.sgl` surface syntax
2. `.sgl.json` canonical document model
3. `LayoutEngine` plugin API
4. Theme format
5. `.sglpack` bundle format (promoted to Must in the triage)
6. Plugin registry manifest (G14, Could)

Six is more than the architecture needs.

### Recommendations

- **Collapse 5 into a convention, not a format.** `.sglpack` should be a plain zip containing files that already have schemas — sources, a theme, a lockfile-style engine pin — plus a two-field manifest. Then it is packaging, not a sixth thing to version.
- **Keep the registry (6) at Could, and consider dropping it.** npm plus a URL and an integrity hash covers distribution completely. A registry is a permanent operational liability — moderation, uptime, abuse, takedowns — for a convenience that a documentation page mostly provides.
- **Share one `schemaVersion` scheme** across the theme format and plugin manifest so there is one migration mechanism rather than several.

That takes six surfaces down to an effective four, two of which (`.sgl` and `.sgl.json`) are two views of one model.

---

## Finding 6 — The custom-font story is weaker than the theming promise implies

**Severity: low-medium. An expectation-setting problem, not a design flaw.**

The design promises custom themes as a headline capability, and ADR-0003 chooses precomputed font metrics for determinism. Those two pull against each other: metrics tables are **build-time artifacts per font**, and self-contained export (D2, Must) additionally needs subsetting, which in-browser means a large WASM dependency.

So a user supplying their own font gets approximate measurement via fallback metrics and an export with a font-stack reference rather than an embedded subset. That is a defensible engineering position, but it is not what "custom themes" leads someone to expect, and it will recur in issue threads.

### Recommendation

State it in the theme schema rather than leaving it to be discovered. `fonts[].embed: 'subset' | 'link' | 'none'`, with a resolver warning naming the fallback metrics table in use. Support a curated bundled set superbly; document custom fonts as "renders correctly, measures approximately, exports by reference."

---

## Finding 7 — The tests that keep this alive are scheduled too late

**Severity: medium. Maintainability depends almost entirely on this.**

Three mechanisms do the real work of preventing rot, and none is in phase 1:

| Mechanism | Currently | Should be |
|---|---|---|
| Engine conformance suite (B18) | Should, phase 3 | **Phase 1**, alongside the first engine |
| Cross-environment byte-identical corpus | implied in §11 | **Phase 1**, and comparing *quantized* output per Finding 2 |
| Golden SVG snapshots | phase 3 | **Phase 1** |

The cross-environment test in particular is load-bearing and fragile: it will break on browser updates and Node releases, and a flaky test that blocks CI gets disabled, at which point the determinism guarantee is gone and nobody notices for six months. Comparing quantized coordinates rather than raw floats is what makes it survivable.

---

## What to change now

Ordered by leverage.

1. **Make elkjs the default v1 engine** and reclassify in-house `layered` as a replacement. Removes the largest schedule risk and validates the plugin API immediately. *(Finding 1 — decided: [ADR-0005](adr/0005-default-engine-elkjs.md).)*
2. **Scope determinism per engine and quantize output geometry.** *(Finding 2 — recorded in ADR-0004.)*
3. **Declare `affects: geometry | paint` per style property** and drive invalidation off two hashes. *(Finding 3.)*
4. **Add `hintsSchema`, and move the conformance suite into phase 1.** *(Findings 4, 7.)*
5. **Reduce `.sglpack` to a zip convention; keep the registry at Could.** *(Finding 5.)*
6. **Document the custom-font limits in the theme schema.** *(Finding 6.)*

Items 2–6 are all small. Item 1 is the one that matters, and it is a scope decision rather than a technical one.
