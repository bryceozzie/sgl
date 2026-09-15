# ADR-0004 — Scope of the determinism guarantee

**Status:** Proposed · **Date:** 2026-09-14 · **Amends:** NFR-1

## Context

NFR-1 promises that identical input, engine, theme and version produce **byte-identical SVG on any platform**. [ADR-0003](0003-deterministic-text-measurement.md) secured the text-measurement half of that. The arithmetic half was never examined, and it does not hold.

ECMAScript specifies `+ - * /` and `sqrt` exactly, following IEEE 754. It does **not** specify `Math.sin`, `Math.cos`, `Math.tan`, `Math.atan2`, `Math.pow` or `Math.exp` — these are implementation-approximated, and V8, SpiderMonkey and JavaScriptCore return different results in the final bits.

Consequences for the built-in engines:

| Engine | Arithmetic | Bitwise reproducible? |
|---|---|---|
| `grid`, `fixed` | integer and rational | Yes |
| `tree` | additive coordinate assignment | Yes |
| `layered` | additive, if routing avoids trigonometry | Yes, with care |
| `radial` | trigonometric placement | No — divergence is small but real |
| `force` | iterative, hundreds of rounds | No — early divergence is amplified, not absorbed |

An unqualified promise is therefore false for two of the six shipped engines, and worse, it is false in a way that surfaces as an intermittently failing cross-environment test that someone eventually disables.

## Decision

**Scope the guarantee per engine, and quantize geometry at the layout/render boundary.**

### 1. Quantization

All coordinates, dimensions and path control points are rounded to a fixed grid — **1/64 px** — as the final step of layout, before anything reaches the renderer or the cache key.

1/64 is exactly representable in binary floating point, so the rounding itself introduces no error, and it is far finer than any visible difference at realistic zoom levels. It absorbs last-bit divergence for every engine whose error does not compound.

### 2. A declared determinism class

`LayoutEngine.capabilities` gains:

```ts
determinism: 'bitwise' | 'quantized' | 'best-effort';
```

- **`bitwise`** — identical raw floats everywhere. `grid`, `fixed`, `tree`.
- **`quantized`** — identical after quantization; raw floats may differ in the last bits. `layered`, `radial`. **The default and the expected class.**
- **`best-effort`** — may differ visibly between runs or platforms. `force`.

The host uses the declared class three ways: the render cache includes it in the key; the cross-environment golden test runs `bitwise` and `quantized` engines and skips `best-effort`; and the UI marks a `best-effort` engine in the picker, so a user committing SVGs to git knows before they choose.

### 3. `force` gets an escape hatch rather than an exemption

A seeded PRNG (already required) plus a fixed iteration count plus quantization gets `force` to reproducible output *on one platform*. To make it reproducible across platforms it would need a deterministic `exp`/`sqrt` path. Offer `@layout.snapshot: true`, which bakes the resulting coordinates back into the document as `@pin` values — converting a `best-effort` layout into a `fixed` one, which is `bitwise`.

That is a better answer than a bespoke maths library, because it is also what users actually want from force layout: run it once, like the result, freeze it.

## Consequences

- NFR-1 is restated as: *identical input, engine, theme and version produce byte-identical SVG on any platform, for engines declaring `bitwise` or `quantized`.* Testable, and true.
- The render cache stays sound, because `best-effort` results are never shared across environments.
- The cross-environment golden test compares quantized output and is therefore robust to browser and runtime updates — which is what keeps it from being disabled.
- Third-party engines must declare a class. An engine that declares `bitwise` and fails the double-run conformance check is rejected by the suite.
- Quantization costs one pass over the geometry, and slightly constrains engines that expect to hand off exact floats. Acceptable.
- Anything ported from another language that uses trigonometry inherits `quantized` at best. Worth knowing before wrapping an external engine.
