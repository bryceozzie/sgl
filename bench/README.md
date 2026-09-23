# Bench

The perf harness for the budgets in DD-09 §2. Runs in headless Chromium, nightly
and on release: **fails at the hard ceiling, warns at the target.**

| Path | Target | Hard ceiling |
|---|---|---|
| Keystroke → styled graph (500 nodes) | ~15 ms | — |
| Full pipeline (50 nodes) | < 60 ms | — |
| Paint-only theme switch | < 16 ms | — |
| Layout timeout | — | 10 s, then terminate and respawn |

`generate.js` writes `corpus/n50.sgl`, `corpus/n500.sgl`, `corpus/n2000.sgl` and
`corpus/unresolved/edge-expansion-limit.sgl` deterministically — they are
generated rather than committed so the shape of the scale fixtures stays a
single decision in one file, not a diff to review each time it changes. Run it
directly with `node bench/generate.js`, or via `pnpm generate:corpus`; `pnpm
test`/`pnpm check` run it automatically first.

**Stage G** (07-execution-plan.md §5) wired the pipeline end to end and added
this generator, so the fixtures these budgets need now exist.

## F9: `render()` alone, measured

**Stage H** added the browser project (`vitest.config.ts`'s `browser` project,
Chromium + Firefox via Playwright) and, with it, a real runner for this row:
`packages/render-svg/test/browser/render.bench.browser.test.ts`. It is **not**
a pass/fail gate on 16 ms — timing asserts are flaky in CI — it prints
median-of-15 to the console; only a real perf regression bench (nightly, per
this file's own table) should ever fail a build on timing.

Inputs are precomputed in Node by `generate-render-fixtures.js` (`pnpm
generate:bench-fixtures`, chained into `pnpm test`/`pnpm test:browser`, not
`pnpm test:unit`): everything upstream of `render()` —
`parse -> resolve -> compile -> resolveTheme -> styleGraph -> premeasure ->
grid -> route/label/quantize -> validateResult` — runs once per (document,
theme) pair, and the resulting `StyledGraph`/`LayoutResult`/`ResolvedTheme` are
written to the gitignored `bench/render-fixtures.json`, so the browser test
times `render()` itself and nothing upstream of it.

Median of 15 runs, measured 2026-09-23:

| Document | Theme | Chromium | Firefox |
|---|---|---|---|
| n50.sgl | neutral-light | 1.1 ms | 2.0 ms |
| n50.sgl | neutral-dark | 0.8 ms | 2.0 ms |
| n500.sgl | neutral-light | 8.9 ms | 15 ms |
| n500.sgl | neutral-dark | 7.7 ms | 16 ms |
| n2000.sgl | neutral-light | 33.8 ms | 54 ms |
| n2000.sgl | neutral-dark | 41.3 ms | 54 ms |

The `< 16 ms` budget (DD-09 §2) holds at 50 nodes, is borderline in Firefox at
500, and is 2–3× over at 2 000 in both browsers. Execution plan §2.1's **F9**
has the detail; confirming or renegotiating the number is a human decision,
not this bench's.
