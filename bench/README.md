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
this generator, so the fixtures these budgets need now exist. **The runner
itself is still ⟶**: DD-09 §3.1 puts perf benchmarks in headless Chromium, and
no browser test target exists yet (Vitest browser mode starts at Stage H). Until
then `render()` at 50/500/2 000 nodes is unmeasured and the paint-only theme
switch budget stays unbacked (execution plan §2.1, **F9**) — a Node timing would
use the same V8 as Chromium but not the same environment DD-09 actually cares
about, so this file deliberately does not stand one up as a substitute.
