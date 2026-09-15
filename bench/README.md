# Bench

The perf harness for the budgets in DD-09 §2. Runs in headless Chromium, nightly
and on release: **fails at the hard ceiling, warns at the target.**

| Path | Target | Hard ceiling |
|---|---|---|
| Keystroke → styled graph (500 nodes) | ~15 ms | — |
| Full pipeline (50 nodes) | < 60 ms | — |
| Paint-only theme switch | < 16 ms | — |
| Layout timeout | — | 10 s, then terminate and respawn |

`generate.js` writes `corpus/n50.sgl`, `corpus/n500.sgl` and `corpus/n2000.sgl`
deterministically — they are generated rather than committed so the shape of the
scale fixtures stays a single decision in one file.

⟶ Arrives with the stages it measures. Until the pipeline runs end to end there is
nothing here to time.
