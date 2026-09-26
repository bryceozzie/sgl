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

It also writes `bench/imports/importer50.sgl` and `bench/imports/lib500.sgl`
(gitignored, outside `corpus/` so no corpus sweep links them): a 50-node
document importing a 500-node library, for A9's keystroke bench below.

## A9: a keystroke with unchanged imports, measured

`packages/core/test/imports-keystroke.test.ts` (part of the `unit` project)
types 40 keystrokes into `importer50.sgl` through one linker and one
`ImportCache`, as the app does (DD-08 §15.2), and **asserts** that each costs
lookups only: the cache's parse and resolve counts do not move, and the host is
asked once. It prints `[A9-BENCH]` with the medians of `parse -> resolveImports
-> compileImports`, and holds them only to DD-09 §2's keystroke budget (60 ms
at 50 nodes; layout is debounced and off the keystroke path).

Node 22, 2026-09-26, load ≈ 0.4:

| | Median per keystroke |
|---|---|
| `importer50.sgl`, imports unchanged (cached) | 1.8–2.0 ms |
| the same document without its `@imports` line | 1.2–1.3 ms |
| its first resolve, cold (parses and resolves the 500-node import; includes JIT warm-up) | ~56 ms, once |

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

## F9: what the live view pays, measured

The same file's other two blocks time DD-08 §6's actual live-view operation —
`render()` and then `wrapper.innerHTML = svg` on the canvas's wrapper `<g>`:
**swap** stops the timer right after the assignment, before the browser has
computed style or laid the new subtree out; **swap+layout** calls
`wrapper.getBBox()` inside the timed region, forcing that work synchronously.
Swap+layout is the one the budget is judged by (fix round 1, item 17), since a
frame cannot paint without doing it.

Chromium only (`vitest run --project browser --browser=chromium …`), medians
of 15, range over three standalone runs and both themes, 2026-09-23:

| Document | `render()` | + swap | + swap + layout |
|---|---|---|---|
| n50.sgl | 0.7–1.1 ms | 1.1–1.4 ms | 3.4–9.7 ms |
| n500.sgl | 7.1–8.0 ms | 10.8–14.5 ms | 37–72 ms |
| n2000.sgl | 29–34 ms | 85–150 ms | 183–254 ms |

With layout counted, 500 nodes misses the `< 16 ms` budget as well as 2 000
missing `< 50 ms`. Execution plan §2.1's **F9** row records the human
decision on this (keep the budget, met before Gate 4, Stage L).

**Superseded as F9's measure (Stage L).** These figures start from an
already-styled graph, so they leave out everything upstream of `render()`
that a real theme switch runs. F9 is now judged end to end by `pnpm
bench:theme` (`apps/web/bench/theme-switch.bench.ts`: a Theme ▾ pick as the
picker makes it, on the real editor, pipeline and canvas). Since
`feat/theme-fast-path` a pick on a document without `@theme` is a paint-only
`<style>` swap that meets the budget on a quiet machine, marginally at 2 000
nodes; execution plan §1 Verification and §2.1 **F9** have the numbers and
the gate policy.
`morphdom` was measured and dropped (slower than the `innerHTML` swap).
