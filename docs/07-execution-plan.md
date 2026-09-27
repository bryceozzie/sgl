# SGL — Execution Plan

How the delivery plan in [04 §Revised delivery plan](04-feature-backlog.md) actually gets built: the
order, the staging gates, and the context an agent needs to pick up any one stage cold.

This document is **operational**. [01](01-requirements.md)–[06](06-feasibility-and-mvp.md) and the
[detailed design](detailed-design/00-overview.md) say *what* to build and *why*. This says *in what
order*, and *how you know a stage is finished*.

**Restarting an orchestrator session?** Read [the orchestration handoff](orchestration-handoff.md) after §2 and §2.1: in-flight branches, pending next steps and working practices.

**Keep §2 current.** It is the first thing every agent reads, and a stale one sends work in the wrong
direction.

---

## 1. Standing rules

Every agent reads this section before touching anything. It is not repeated per stage.

### The design documents are normative

Type signatures in DD-01…DD-10 are the contract, not a suggestion. Implement them as written.

If a document is **wrong** — the maths does not work, the types cannot express the case, two documents
contradict each other — do not silently deviate and do not silently comply. **Update the document in
the same change as the code**, state the deviation in the commit message, and call it out in your
report. A design document that has drifted from the code is worse than no document.

If a document is merely **incomplete**, fill the gap the way the surrounding design implies, and say
so.

### Dependency direction (DD-00 §2)

Enforced by `eslint.config.js`; CI fails on a violation.

```
core  ←  theme, layout-api
core, theme  ←  text                    (A18, DD-11 T2)
core, theme, text  ←  measure, render-svg
core, layout-api  ←  layout-elk, layout-std
everything  ←  apps/web
```

`@sgl/core` imports nothing from the workspace. Only `apps/web` touches the DOM, except
`CanvasMeasurer`, which is isolated behind the `Measurer` interface. Only `apps/web` imports Preact.

### Determinism (DD-00 §3)

No `Math.random`, no `Date.now`, no iteration over object keys without sorting, no `Map` iteration
order dependence, anywhere below `apps/web`. Lint bans the first two, plus `performance.now`
(Stage H fix round 1) — DD-06 §3 has exactly one sanctioned exception, the worker protocol's `ms`
telemetry field (`worker-runtime.ts`'s `now()`), which never feeds back into engine or renderer
output; that one call site carries an inline `eslint-disable-next-line` with the reason, so the
exception is mechanical rather than a convention to remember. **Every stage that produces
output adds a double-run test**: run twice, assert byte-identical `JSON.stringify` or string output.

A corollary that has already surprised one review: a record keyed by author-supplied strings —
`SemanticGraph.nodes`, `labels`, DD-04's `styles`, a node's `@ports` bag — puts **integer-like keys
first**, in numeric order, ahead of every other key in insertion order. A document declaring `"1": {}`
after `zebra: {}` yields `Object.keys(graph.nodes) === ['1', 'zebra']` while `graph.order` correctly
says `['zebra', '1']`. This is ES-specified, so a double-run test passes and will never catch it.
**`graph.order` is the only safe traversal**; treat key order in any of those records as undefined.

### Errors are values

A stage **never throws** on bad input. It returns `{ value, diagnostics }` with the best partial
result it can build. Throwing is reserved for a violated invariant — a programming error, which the
application treats as a crash to report rather than a document problem.

Build every diagnostic with the `diagnostic()` helper and a code from the catalogue in
`packages/core/src/diagnostics.ts` (`@sgl/layout-api` uses `layoutDiagnostic()`, the same builder over
the catalogue's `SGL4xxx` rows alone, so the layout worker does not bundle every message). Never
hand-roll a message string. Adding a code means adding a
row to the catalogue **and** a corpus fixture that emits it (see Gate 1).

### Branches and commits

One branch per stage, named in the stage heading. Branch from `main`, merge back only when the
stage's gate passes.

```bash
git checkout -b feat/<stage> main
# ... work ...
pnpm lint && pnpm typecheck && pnpm test     # must all pass
git commit
```

Commit messages say what changed and **why the design went that way**, not just what. End every
commit with the co-author trailer the session specifies.

`main` must be green at every commit. If a stage is abandoned part-done, commit it to its branch
prefixed `wip(...)`, say in the message what is missing, and do **not** merge.

### Verification

```bash
pnpm check        # lint + typecheck + build + test — what CI gates on
pnpm build        # every package, then the app
pnpm grammar      # regenerate the Lezer parser; the output is committed
```

`pnpm check`/`pnpm test` also run the `browser` project (Chromium + Firefox, Stage H decision
D3), which needs Playwright's own browser binaries — not npm packages, so `pnpm install` alone
does not fetch them. One-time per machine:

```bash
pnpm exec playwright install chromium firefox
```

CI does this itself, before its own browser-test step (`.github/workflows/ci.yml`).

**Stage I part 2** adds a second, independent Playwright surface: `apps/web`'s own e2e suite
(DD-08 §14), against a production build (`vite build` + `vite preview`), covering the MVP
criteria this stage owns (2, 3, 1's single-engine half) and the corrected DD-08 §14 checklist.
`pnpm check`/root `pnpm test:e2e` run it in **Chromium only** (decision, Stage I part 2 brief) —
the same `chromium` binary the browser project above already needs, so a contributor's machine
stays green without Firefox/WebKit installed. CI's own `test:e2e:all-browsers` script runs all
three (DD-10 §4), which needs WebKit fetched once per machine too:

```bash
pnpm exec playwright install webkit
```

**F9's theme-switch bench** (Stage L) is separate from both and from `pnpm check`, because it is
minutes long and bound by timing:

```bash
pnpm build && pnpm bench:theme     # Chromium only; prints one [F9-E2E] line per document, case and pick
```

It times a Theme ▾ pick, `neutral-light` → `neutral-dark`, exactly as the picker does it
(`selectTheme` with the real CodeMirror editor's dispatch), on the real pipeline and canvas at
n50/n500/n2000, until `getBBox()` after the paint, plus any pre-measure the pick causes. Two cases
since `feat/theme-fast-path` (§2): a document **without** `@theme` (the picker's `themeId` write
changes the view and nothing else: the ordinary path) and one **with** it (the picker also edits
that entry, so the document reparses), each on a *first* pick (after a full render) and a *repeat*
one (after another pick). The gate (fix round 1; DD-09 §2, §3.1) judges the no-`@theme` case's
slower pick in **three samples** per point, three full median measurements in one run: the **best**
of the three must be under the budget, and the **median** of the three under the hard ceiling (50 ms
up to 500 nodes, 100 ms at 2 000). Every run also checks that a node's computed `fill` is the new
theme's. Run it on a quiet machine (check `uptime`; no other vitest or Playwright running): it is
not part of `pnpm check` or CI. `KNOWN_MISSES` in `apps/web/bench/theme-switch.bench.ts` (empty)
would hold a point still missed, whose gate then asserts the miss persists. The `@theme` case is
measured and printed, not gated.

The e2e server is `vite preview` on port 4173 and is **never reused** (Stage J): if the port is
taken, the run fails instead of testing whatever build is already listening there. Set
`SGL_E2E_PORT` to use another port, e.g. when a second checkout is running its own suite.

`check` builds before testing because a workspace package's cross-package `import`s resolve
through its published `exports`, which point at `dist/`. `tsc -b` (the typecheck step) only
compiles `.ts` files, so a package that re-exports a hand-generated `.js` asset — `@sgl/core`'s
Lezer parser, once Stage A wires `parse()` to it — needs its real build (`tsdown`, which bundles
each entry, the grammar as one shared chunk both import) before any other package's tests can
import it.

A stage is not done because the code is written. It is done when its gate passes.

---

## 2. State of the build

| Component | State | Where |
|---|---|---|
| Workspace, types, diagnostics catalogue, style registry, built-in themes, Lezer grammar | **Done** | `main` |
| `@sgl/theme` — `resolveTheme`, `styleGraph`, geometry/paint hashes | **Done**, T1+T2 gate green, tested against `corpus/`-derived graphs (Stage D) | `main` |
| `@sgl/measure` — `premeasure`, three `Measurer`s, run keys | **Done**, T1+T2 gate green, tested against `corpus/`-derived graphs (Stage D) | `main` |
| `@sgl/render-svg` — shapes, style block, markers, text, `render()` | **Done**, T1+T2 gate green (Stage F) | `main` |
| `@sgl/core` — `parse()`, `buildAst`, grammar fixes | **Done**, T1+T2 gate green | `main` |
| `@sgl/core` — `resolve()`, `toJson`/`fromJson`, config-key registry | **Done**, T1+T2 gate green | `main` |
| `@sgl/core` — `compile()`, wildcard expansion, class linearisation | **Done**, T1+T2 gate green, diagnostics coverage gate enabled | `main` |
| `@sgl/layout-api` — `buildLayoutInput`, shape content insets + anchors, host fallbacks, `validateResult`/`quantize` | **Done**, T1+T2 gate green (Stage E) | `main` |
| `@sgl/layout-std` — `grid` | **Done**, T1+T2 gate green, bitwise double-run over the whole corpus (Stage E) | `main` |
| End-to-end pipeline (`source -> RenderResult`), `bench/generate.js` | **Done**, T3 gate green (Stage G) | `main` |
| `@sgl/layout-api` — `createWorkerHost`, `worker-runtime.ts` (worker-side message handling) | **Done**, T1 gate green; the gate's four conditions also proven against a real `Worker` (browser project, Chromium + Firefox) (Stage H) | `main` |
| `apps/web` | **Stage I done** — the editor loop, pickers, diagnostics panel, status chip, fonts, the §13 error boundary and the Playwright e2e gate (DD-08 §14 tests 1/2/3/8, MVP criteria 2/3/1-single-engine) all work end to end. Fix round 1 done (below). `elk`/engine-switch and the per-engine options form are Stage K | `main` |
| `@sgl/layout-elk` — the elk adapter (lazy elkjs, K11 `document` stub), `@sgl/layout-api/conformance`, `applyHostFallbacks`; `apps/web` — elk registered and the default, F11 options form, engine-switch e2e, `size-limit` | **Stage K done, merged at `0e9ecfc`** — T2 + T3 + size check (177.22 kB gz, also under CI's Node 20.19.0) + T4 (Chromium only) green; one fix round (23 items incl. SGL4010, human decision 2026-09-23); H2/H3 recorded as F14/F15 | `main` |
| `apps/web` — files, share, persistence, PWA, `_headers` | **Stage J done, merged at `0a32679`** — Open/Save (`.sgl`, `.sgl.json`, `.svg`), share by URL with the 2 MB inflate cap, IndexedDB autosave and boot, the stored-SVG boot paint (J6), `vite-plugin-pwa` precache + manifest + update chip, the `_headers` CSP; e2e gate MVP criteria 2–6 single-engine plus DD-08 §14 tests 5–7 green in Chromium, Firefox and WebKit (fix rounds 1 and 2 re-verified in Chromium only); Open makes a new local document and a minimal Documents ▾ list reaches every stored one (fix round 2, human decision 2026-09-23) | `main` |

**Gate 1 is cleared.** `feat/compiler` merged to `main` at `a46c72b`; `pnpm check` green there
(496 tests). `.sgl` text in, `SemanticGraph` out, for every document in the corpus, with goldens
committed and the diagnostics coverage table enforced — so **from here no stage hand-builds a
`SemanticGraph`**, and Stage D exists to delete the two that predate this.

**Stage D is done.** `feat/corpus-fixtures` merged to `main`; `pnpm check` green (504 tests). A
shared `corpusStyledGraph`/`corpusGraph` helper (`packages/theme/test/corpus.ts` — a dev-only fixture
module, not a package export) runs the real `parse → resolve → compile → resolveTheme → styleGraph`
pipeline over a named `corpus/` document; `cascade.test.ts` and `measure.test.ts` now draw the
cascade-precedence, container-vs-node-role, byShape and premeasure-coverage tests from it instead of
hand-built `SemanticGraph`/`StyledGraph` literals. Contrary to what this stage's write-up in §5
expected, re-basing did **not** turn up a shape mismatch: node/edge field names, the `'l:<id>'` label
ID convention, and the container-vs-leaf geometry rule all matched what the hand-built fixtures had
guessed. `classes.sgl`'s diamond (`Diamond extends [Left, Right]`) now exercises real
`linearizeClasses` output end to end, confirming the precedence the F3-adjacent §2 note describes.
`premeasure` covers 100% of labels across all 47 documents in `corpus/` (DD-00 §6's measurement exit
criterion), asserted directly rather than inferred. A handful of tests keep hand-built literals because
no corpus document contains an invalid `@style`/`@size` value, an inline `@style.fontSize`, or a
single-`Critical`-class node without its own inline override — each noted in place.

**Stage J merged to `main` at `0a32679`** (`--no-ff`, 2026-09-23) after a three-lens review and two
fix rounds (below). `pnpm check` from clean is green on `main`, run by the orchestrator as one
command: 1881 Vitest passed (unit + browser project, **Chromium only**) and e2e 50/50 in Chromium.
The orchestrator's sandbox blocks Playwright's browser CDN, so Firefox and WebKit could not be
fetched there; the Firefox half of the browser project and `test:e2e:all-browsers` last ran on the
implementer's own machine before the fix rounds, and run in CI. **Stage K is next**, and
its dependency is now satisfied.

**Gate 3 (MVP) is cleared by human decision (2026-09-24), with recorded exceptions.** The six MVP
criteria are automated in Playwright with both engines (Chromium, verified from clean by the
orchestrator). T5: exported SVG verified in **Edge** and **Inkscape** (after F17); **Figma and
Safari waived** for this gate (no access); **PWA install delayed**, not waived: it is still to be
checked by hand before a release, together with opening a `.sgl` from the OS and the update chip;
**CI**: GitHub shows no runs of `.github/workflows/ci.yml`; the human has chosen not to pursue it
for this gate, so Firefox/WebKit and the Node 20 path have not been verified on GitHub.
**Stage L is next.**

**A8 variables, on `feat/variables`** (branched from `main` at `73fdd69`; not merged). **Core bundle:**
`main` 179.76 kB gzipped → 181.40 kB with A8 and F3 (over the 180 kB limit, which stays) → **179.22
kB** after two size changes on the same branch (orchestrator's choice): the layout worker bundles only
the `SGL4xxx` catalogue rows (`layoutDiagnostic()` over `LAYOUT_CATALOGUE`, −0.86 kB; enforced by
`check-core-chunks.mjs`), and Open/Save ▾/Share's work is the lazy `file-actions` chunk (−1.32 kB;
the buttons, file input and `Ctrl/⌘+O` stay at boot, DD-10 §2). That is 0.78 kB under the limit,
short of the 1.5 kB aimed for. `resolve()` now substitutes `@vars`:
`$name` as a whole value with its type, `${name}` inside a string, lexically scoped per container (a
container's `@vars` cover its config, edges and children, wherever written and across
redeclarations; class bodies use the root's). Settled and now language spec §5: a reference to an
undeclared name is `SGL2013` (error) and the value is dropped; interpolating an object, array or
null is `SGL2015` (error) and the placeholder is left out, numbers and bools by their canonical text;
variables may appear anywhere a value can (`@type` and `@extends` included, checked against
`@classes` after substitution) but never in a key, path or node name (the grammar already made `$`
there a syntax error); a `@vars` entry sees enclosing scopes and earlier entries of its own block,
in one non-recursive pass in declaration order, and a reference to itself or a later entry, so every
cycle, is `SGL2014`; variable names must be identifiers (`SGL2011`), which also keeps declaration
order intact through canonical JSON's integer-like-keys reordering. **No `$` escape exists in the
grammar**, so none was invented: a literal `${name}` cannot be written, and adding `$$` or `\$` is a
language-spec decision left open. Canonical JSON keeps the source form (`"$hot"`,
`"API (${tier})"`, `"@vars"`) through a new optional `authored` bag on
`ContainerModel`/`EdgeModel`/`ClassModel`, present only when an element uses a variable, so a
document without variables serialises exactly as before; a string that is exactly `$name` reads
back as a reference, which is how the spec's §9 canonical form already wrote it. `SGL2009` is
retired (row and fixture removed; the number is not reused), three codes and four `unresolved/`
fixtures are added, and `theme/bad-colour.sgl` takes over `SGL5004`, which only `checkout.sgl`'s
literal `$hot` reached before. Goldens: only `checkout.sgl`'s changed, the one corpus document
using `$` (compile golden and both render goldens: the stroke is now `#DC2626`; its resolver golden
is unchanged); `variables.sgl` is a new clean corpus document with new goldens. **F3 is fixed** on
the same branch: `linearizeClasses` keeps the current `@extends` path, skips a back-edge and reports
it as `SGL2004` once per cycle (rotated to its least member), tested by calling `compile()` on
hand-built cyclic models. Tests: `packages/core/test/variables.test.ts`, three F3 tests in
`compile.test.ts`, `apps/web/e2e/variables.spec.ts`. Docs: language spec §5, DD-01 §2 notes, DD-02
§1/§2/§3.5/§6/§7/§8/§9, corpus README.

**A8 fix round 1, on `feat/variables`** (review findings, each confirmed by the orchestrator).
(1) Exponential expansion: variable values are computed lazily on first use and memoised (an unused
doubling chain costs nothing), and substitution is charged against a per-document budget of 2 Mi
units (a value copied by `$name`, a character produced by `${name}`; DD-09 §1.1's 2 MB posture, new
threat row); past it one new **`SGL2016`** error at the crossing use and the value dropped (fixture
`unresolved/variable-expansion.sgl`). `v24` of a doubling chain went from 38.8 s to ~1 ms. (2) The
string form's `RangeError` at n = 28 is now that `SGL2016`. (3) Scopes are a parent chain, not a copy
per container: 20 000 variables under 5 000 scoped siblings, 19 s → ~0.15 s. (4) `@extends` cycle
search (shared `class-graph.ts`) and `compile()`'s linearisation are iterative: 20 000-deep chains
resolve and compile. (5) One canonical cycle break in both resolve and compile: rotated to the
smallest member, which the message names, dropping the back-edge into it; independent of declaration
order (`class-cycle.sgl`'s message now names `A`, not `B`). (6) Redeclared `@vars` merge like any
config; stated in spec §5. (7) Spec §5 states the node-shorthand `SGL1002` and its recovery, ASCII
identifier names, literal non-identifier placeholders, `String(n)` exponent forms, declaring-scope
resolution, `@vars: $o` as `SGL2011`, and nested drops; `SGL2015` now drops the value, like `SGL2013`.
(8) Three mutant-surviving gaps covered. (9) A canonical-JSON `"from": "$a"` is kept as written
(`EdgeModel.fromText`/`toText`) and is `SGL2001` naming it, instead of an empty path. No golden
changed. **Core bundle: 179.22 → 180.17 kB, 0.17 kB over the limit**: stopped and reported, not
trimmed (§2.1 F20).

**A8 fix round 2, on `feat/variables`** (size only, no behaviour change). Canonical JSON is its own
core entry, `@sgl/core/json` (`toJson`/`fromJson` and the writers, imported only by the lazy
`file-actions` chunk; boot never needed `fromJson`): 180.17 → 179.72 kB. The Options ▾ form is the
lazy `engine-options-form` chunk, with defaults and normalisation (`optionsForEngine`,
`defaultOptionsFor`) kept on the boot path: → **178.63 kB**, 1.37 kB under the 180 kB limit, 0.13 kB
short of the 1.5 kB aimed for (§2.1 F20 names the next candidate). New offline e2e case for Options ▾.

**Wildcards in parent path segments, merged to `main` at `2cb614b`** (one review with mutation testing, one fix round; 2279 Vitest + 56/56 e2e from clean) (language change, **human
decision 2026-09-24**; branched from `main` at `1afd586`, not merged). Any segment of an edge
endpoint may now be a `*` or one-star glob (`store*.api* -> payments.api`, `/platform.*.handler`);
`**` stays final-only, and `SGL3004` (same number, new template) now means only "`**` in a
non-final position". The change is `expandEndpoint` in `packages/core/src/compile.ts`: the literal
prefix before the first wildcard resolves as before (`../`, `/`, `SGL2001`), then each remaining
step walks a frontier one level down, giving depth-first declaration order; a matched parent
with no matching child, or a matched leaf, drops out silently, and `SGL3003` fires only for a
wholly empty endpoint. No grammar change. Tests: 17 compile unit tests, a render-svg pipeline
test, `apps/web/e2e/wildcard-paths.spec.ts`, and a new clean corpus document
`wildcard-paths.sgl` (new goldens only; no existing golden changed). `unresolved/wildcard-midpath.sgl`
now uses `lane1.**.handler`. Docs: language spec §3/§7, FR-L15, A21, DD-01/02/03 §3.1; F16 gains
the new document's 4 elk title crossings. Stage C's checklist in §5 below is left as the record of
what that stage built.

**D6 PNG export and D7 copy to clipboard, on `feat/export-png`** (branched from `main` at `270f257`;
not merged). Save ▾ gains **PNG image** with a scale (1×/2×/3×, 2× by default; a native radio group,
still no menu roles), **Copy SVG** (`clipboard.writeText` of `lastGood.svg`) and **Copy PNG**
(`ClipboardItem` with a promised `image/png` at 2×, written inside the click for Safari). The PNG is
`round(width × scale)` × `round(height × scale)` px. Its background is the SVG's own `.canvas` rect. It is
refused with a toast past 16 384 px a side or 8192² px in all. **The font trap:** an SVG drawn through
`<img>` cannot use the page's Inter, so it rasterises a copy with the used Inter weights embedded as
`data:` `@font-face` rules. The WOFF2 files are the ones `fonts.css` loads, fetched from `'self'` or the
precache. The exported SVG is unchanged. **CSP:** nothing changed. `img-src blob:` covers the `<img>`, and in
Chromium under the real `_headers` the `data:` fonts inside the image document raise no `font-src`
violation (DD-09 §1.2). **D2 is not met:** Save ▾ SVG references Inter by name (`font-family:Inter,
system-ui, …`) and embeds no font. That is DD-07 §9's "by reference in MVP", deferred to C8. No external
reference is emitted. Code: `apps/web/src/state/png.ts` (DOM-free), `io/png.ts`, `toolbar/file-actions.tsx`
(`SaveExtras`, `savePng`, `copySvg`, `copyPng`), `toolbar/FileMenu.tsx` (renders `SaveExtras` once the lazy
chunk has loaded, which opening Save ▾ starts), `io/download.ts` (`downloadBlob`). All of it is in the lazy
`file-actions` chunk: 5.96 → 11.60 kB minified. **Core bundle 178.63 → 178.66 kB** (178 631 → 178 658 B
gzipped, +27 B: the `FileMenu` hook-up). Tests: `apps/web/test/png.test.ts` (Node),
`test/png.browser.test.ts` (Chromium: pixel size, the `.canvas` background under both themes, and the
text is Inter, the ink of a probe line at each weight within 3 px of `measureText` with the same WOFF2,
where the unembedded copy misses by ~30 px), `e2e/png-export.spec.ts` (menu, sizes, background against
the resolved theme, font embedded in the build, clipboard round trips with permissions granted, a
refused clipboard, both caps), plus a PNG case in `e2e/offline.spec.ts` (the fonts come from the
service worker) and PNG at every scale and both Copy items in `e2e/csp.spec.ts`. Docs: DD-08 §7 and §11,
DD-09 §1.1 (three threat rows) and §1.2. One unrelated test fix: `e2e/pwa.spec.ts` matched the built
`sw.js` against the minifier's variable name (`e.data.type`), which changes with the precache list, so
any new asset hash could break it. It now matches any name.

**A9 `@imports`** (Stage L, `feat/imports`, branched from `main` at `d3b491b`, `main` merged in at
`672948a` and `c306cdb`; **complete, awaiting orchestrator verification; not merged; no existing
golden changed**). Human decisions of 2026-09-25: a relative path resolves against the user's stored
documents, Share bundles the imports, an unresolved import is a warning, and I14, I16, I17, I21 and
I29 as designed. Design and deviations: DD-02 §10 and DD-08 §15, now marked implemented.
- **Grammar (I16).** `ClassRef` and `Word` are `qualified { Identifier ("." Identifier)* }` and the
  `Variable` token takes a `.ident` tail, so `lambda: aws.Lambda` and `$aws.x` parse. Every
  committed document's CST and AST was pinned first (`grammar-trees.test.ts`) and is unchanged;
  DD-01 §2 has the token audit (a single-token variant was rejected: it re-lexed `a.b -> c` in 23
  documents).
- **Core (step A, orchestrator decision after the wip commit measured 180 128 B).** The boot path
  keeps only `hasImports` and `resolve(ast, seam)`'s `ImportSeam`; everything else is the lazy
  `@sgl/core/imports` entry: `resolveImports`, `compileImports` (I17's two rules), the linker, host
  interface and `ImportCache`, and `IMPORT_CATALOGUE` (`SGL2017`–`SGL2026`, all warning or info).
  Core's own `resolve()` keeps `@imports` with no effect, and I14 applies to documents with
  `@imports` only. `DocumentModel.imports`, `ContainerModel.origin`, `ClassModel.origin`; the
  `imports` registry row; `toJson` prints `@imports` as written and leaves out what was imported.
- **App.** Records carry `fileName` (Open, a bundle) and `group` (a share link's documents); a title
  skips grafted containers. The lazy `imports` chunk holds the stored-document index (a put wrapper,
  per-entry signals, a refresh on `visibilitychange`), the host (I1–I5 tiers and groups) and the
  runtime (one linker per open document, one cache). The pipeline holds a document with `@imports`
  until the chunk has loaded (I25) and the session saves nothing meanwhile; an imported document's
  write re-resolves exactly its importers (I24). Share adds `i=` (I26–I28) and boot stores a link's
  documents as a new group (I29). Documents ▾'s list is the lazy `documents-menu` chunk (F20), and
  `state/filename.ts` its own `filename` chunk; `check-core-chunks.mjs` fails if an excluded chunk or
  an import catalogue row reaches the boot path.
- **Tests.** `corpus/imports/` (one fixture per new code, `main.sgl` goldens) with a file-system host;
  `imports.test.ts`, `imports-limits.test.ts` (exact cap edges), `imports-corpus.test.ts` (round
  trip; cold and warm-cache double runs); `import-host`, `import-index`, `imports-runtime` (Share's
  breadth-first closure), `pipeline`, `share`, `boot`, `document-session` tests; e2e
  `imports.spec.ts` (8 cases: classes and variables applied, freshness, `as:` and a grafted
  subtree, unresolved, cycle, ambiguity, Share to a fresh context with groups and the dialog's
  messages, a long link counting `i=`), an offline case and a CSP case. DD-02 §10.8 and DD-08 §15.5
  map every test-plan item to its test.
- **Bench.** `bench/imports/` (generated): a keystroke in a 50-node document importing a 500-node
  one costs one lookup and no parse or resolve of the import, asserted; 1.8–2.0 ms per keystroke
  (`parse -> resolveImports -> compileImports`, Node) against 1.2–1.3 ms without the import.
- **Size.** Core bundle 178 911 → **179 472 B** gzipped (179.47 kB; 528 B under 180 kB): Documents ▾
  lazy −244, the grammar +189, step A's boot share +85, records and title +63, the pipeline gate and
  lazy load +325, Share and groups +143 (DD-02 §10.9).
- **Docs.** Language spec §2, §5, §8, §11; DD-02 §1–§4, §6–§10; DD-03 §9; DD-08 §15; DD-09 §1.1
  (five threat rows) and §2; bench/README.md.

**A9 fix round 1** (same branch; three reviews: design, mutation, rules and security). Human
decisions of 2026-09-26: **H1** I14's no-`.` class names apply only to documents with `@imports`;
**H2** a document in a share group resolves imports only within its group, never among the
recipient's documents; **H3** the core bundle limit is **182 kB** (was 180; the 300 kB hard
ceiling is unchanged), in a commit of its own. What changed, each with a test shown failing first
or a mutant it kills:
- **Core** (`imports.ts`, `imports-catalogue.ts`, `resolve.ts`, `json.ts`, `model.ts`): a failure
  inside an import is a warning at any depth (`DocumentModel.importFailures`), qualified and
  unqualified; `compileImports` indexes edges by span once (16 000 dangling edges: 16 s → ~0.15 s);
  a duplicate `as` counts as failed; each document gets its own `SGL2016`; `"${c.x}"` agrees with
  `$c.x`; `@imports` is read up to 256 items and nothing is looked up past 64 documents; template
  values are data only, so new rows `SGL2028`–`SGL2031` (and `SGL2020`, `SGL2022`, `SGL2024`
  reworded); `SGL2026` counts own nodes only; a malformed `@imports` is kept as written. New corpus
  fixtures (`deep*.sgl`, `too-wide.sgl`/`wide.sgl`, `too-many-items.sgl`, `node-clash.sgl`) with new
  CST/AST pins; no existing golden changed.
- **App**: H2 in the host (the Share dialog's "a name for two documents" paragraph is removed as
  unreachable); if the `imports` chunk cannot load, one `SGL2027` warning (a boot-catalogue row) and
  no errors, retried on the next change; typing is saved while the pipeline holds; Share bundles a
  document under every name it was reached by; an empty name (`./`, `.`, `sub/`) finds nothing;
  tier order inside a group and `refresh()` dropping deleted documents are tested; a share link's
  storing moved from `boot.ts` into the lazy `share` chunk; `imports.spec.ts` waits for real state
  (the panel stable across frames, the lint's marks).
- **Bench**: each keystroke is checked to change the text; `as: lib` ~9.5–10 ms; eight 1 500-node
  libraries `as:` ~250 ms, a known cost (§2.1 F23).
- **Size**: 179.47 → 179.69 kB (the degraded path and `SGL2027`) → **179.63 kB** (the share move), of
  182 kB.
- **Docs**: spec §2/§5/§8; DD-02 §2, §3.5, §10; DD-03 §9; DD-08 §15/§15.6; DD-09 §1.1 and §2; DD-10 §4.

**A18 branch 1, `"""` strings and the markdown escapes** (Stage L, `feat/a18-grammar`, branched from
`main` at `31db16c` with `design/a18-text` (DD-11) merged in; **not merged; no existing golden
changed**). DD-11 T10's decoder half, T11 and T15–T20, each now marked implemented there with its
deviations. Labels still draw as literal text.
- **Grammar.** One token, `MultilineString { '"""' mlBody ('"""' | '"'? '"'? @eof) }`, in `Value`,
  `NodeValue` and `EdgeValue` only, and `@precedence { MultilineString, ConfigString, String }`.
  `@eof` in a token is accepted, so T16's fallback was not needed. The audit (DD-01 §2, "The `"""`
  token audit") corrects DD-11 twice: `String` and `MultilineString` share a Lezer token group, so
  `"""` lexes as one token in key and path positions too and is `SGL1002` there; and three quotes in
  a row after `:`, at an entry start or after `->` were valid pre-A18 input (adjacent strings or
  keys), not only inside arrays. No committed document has any. All 92 committed documents' CST/AST
  pins (`e65dda4`) were confirmed complete first and are byte-identical after.
- **`buildAst`.** `decodeMultiline` (T17's dedent, then escapes decoded line by line in place, so
  `SGL1004` offsets are source offsets; a `\` ending a line is `SGL1004`, T18); `\*` and `` \` ``
  decode to themselves with no `SGL1004`; `scanLexicalErrors` skips closed `"""` bodies and reports
  an unterminated one as exactly one `SGL1003` to the end of the input (from the scanner, not the
  decoder as T19 said), with the error left at the end of the input not reported again.
- **Editor.** `tags.string`, folding, and `"""` in `closeBrackets`, so typing the third quote closes
  the string.
- **Tests.** `packages/core/test/multiline-string.test.ts` (84: the audit rows, the dedent table,
  key and path positions, unterminated strings, interpolation and variables, the escapes' round trip
  through `toJson`/`fromJson`, double runs; 64 failed before the change), `editor.test.ts` (+2),
  `e2e/multiline.spec.ts` (3: highlighting, typing `"""`, a pasted unterminated one). New corpus
  documents `multiline.sgl` (in `CLEAN_DOCS`: resolve, compile, grid, elk and four render goldens)
  and `malformed/unterminated-triple-string.sgl`, with CST/AST pins.
- **Size.** Core bundle 179.63 → **180.38 kB** of 182 kB: parse tables +0.12, `buildAst` +0.49, the editor +0.06.
  DD-11 T54 estimated 0.20–0.25 kB for this row, so branches 2 and 3 have 1.62 kB where T54
  planned about 0.6–0.8 kB of the rest.

**A18 (branches 2 and 3) merged to `main`** (`--no-ff` of `feat/a18-render` at `343e8d2`, 2026-09-27; it
contains `feat/a18-text` at `94f3491` through the orchestrator's merge `dfb7a59`). Two reviews per branch and
one fix round each; verified by the orchestrator from clean: 5360 Vitest (unit + browser Chromium),
109/109 e2e, core **181.97 kB of 182** (30 B left, F20). On `main` only T58's two compile goldens changed
(`unicode.sgl`, `multiline.sgl`); every other A18 golden is new. Open for the human: **F25** (the
rendered ascent). The two paragraphs below describe each branch; their "not merged" is as of writing.

**A18 branch 2, the text model, the parser and wrapping** (Stage L, `feat/a18-text`, from `main` at
`33af6e7`; **not merged**). DD-11 T1–T10, T12–T14, T21–T41 (T26 as metrics), T51–T54, T58, T59,
each marked implemented there with its deviations; §19 items 1, 2, 6 and 7 fixed.
- **`@sgl/text`** (new; `core, theme ← text ← measure, render-svg`, in the lint rules, DD-00 §2 and
  §1 above): the run and layout types moved from `@sgl/measure` (re-exported there) with `marks`;
  `runStyle` and the code and strong constants; `hashRuns` with marks only on a marked run, so every
  plain key is unchanged; `labelRuns`, `labelBox`, `labelRunKey`, `plainText`, `needsWrap`;
  `layoutLines` (hard breaks; throws on a box); and the lazy `@sgl/text/wrap` entry's
  `layoutWrapped`, the greedy breaker (spaces, U+200B; overlong words and CJK split at code-point
  units that never enter a surrogate pair, a combining mark, a variation selector, an emoji
  modifier, a ZWJ join or a flag). Measurers take a `lineModel` option.
- **`@sgl/core`**: `TextRun` flags and the canonical one-run form; `compile(…, { inline })` and
  `needsInline`; `contentInsets` with its inverse `labelMaxWidth` (one copy: layout-api's and
  render-svg's per-shape methods are gone); `parseInline` as the `@sgl/core/inline` entry.
- **Theme**: the registry's missing `maxWidth` row — `@size.maxWidth` was always dropped with
  `SGL5003`, so nothing could have wrapped. A fixed `@size.width` wraps too (T36); a class's `@size`
  does not (DD-04 step 6 is inline only; DD-11 T35 corrected, §19 item 10 open).
- **App**: the lazy `rich-text` chunk (`state/rich-text.ts`: the parser and the breaker) loads for
  the first document with `*` or a backtick in a label, or a label with a box; the graph or styled
  stage holds like A9's import gate, the measurer's `lineModel` becomes `layoutWrapped`, and a
  failed load is retried on the next change. The measure effect no longer measures the boot-time
  empty fallback while held (it made a held document's first render use an empty layout).
  **Until branch 3 the renderer draws a parsed label as its runs' plain text (markers removed) and a
  wrapped label on its hard lines only**, overflowing its narrower node; tested at unit and e2e.
- **Goldens.** Exactly T58's two: `unicode.sgl`'s and `multiline.sgl`'s compile goldens (one run
  with `\n`). No layout or render golden changed. New: `corpus/text/markdown.sgl` and `wrap.sgl`,
  with compile and `grid`/`elk` goldens through the rich pipeline (`rich-corpus.test.ts`, which
  also pins `multiline.sgl` there); their render goldens are branch 3's. The elk title-crossing pin
  gains `text/wrap.sgl`: 1.
- **Tests** (each shown failing first): `core/test/inline.test.ts` (every §2.2 row, T5–T14, five
  fast-check properties), `label-max-width.test.ts` (containment per shape), `text/test/`
  (`layoutLines` equals the MVP model on every corpus label under two measurers; faces, keys, boxes;
  the breaker's cases and properties), `theme/test/size-max-width.test.ts`,
  `render-svg/test/wrap-pipeline.test.ts` and `apps/web/test/rich-text.test.ts` (the measured box,
  the engine input, the node and the placement agree end to end, under grid and elk and through the
  app's pipeline), `markdown-scan.test.ts` (every corpus document, the app example and
  n50/n500/n2000 compile identically with and without the parser but for the three markdown
  documents), `e2e/rich-text.spec.ts` (3) and an offline case. Parser mutation testing: 16 mutants
  over T5–T8, T10 and T21, all killed after one added case.
- **Size.** Core bundle 180.38 → **181.23 kB** (step 1) → **181.22 kB** of 182; the lazy
  `rich-text` chunk is 2.01 kB gzipped. The render branch has **0.78 kB**.
- **Docs**: spec §3 ("Markdown in labels") and §4; DD-00 §2; DD-02 §7; DD-03 §2, §6; DD-04 §2;
  DD-05 §2–§5, §7; DD-06 §2; DD-07 §4 (the `Shape` interface lost `contentInsets`); DD-08 §3;
  DD-11; architecture §6 and backlog notes; `corpus/README.md`.

**A18 branch 2, fix round 1** (two reviews; each item its own commit, tests shown failing first).
Human decisions: **H1** a fixed `@size.width` breaks only at spaces (a `keepWords` box; only
`@size.maxWidth` splits a word); **H2** a class's `@size` applies to its nodes (DD-04 §4 step 4,
in `@type` order; geometry only). Fixes: the breaker keeps a running width per line (8 000 words
6.7 s → 29 ms; output byte-identical over 22 330 corpus layouts); a rich-text chunk that cannot
load degrades (plain runs, the box ignored, one new `SGL6002` warning, retried on the next change)
instead of freezing the picture; hexagons wrap by `L + min(L, H) ≤ avail` instead of `avail/2`;
M7 killed; T56's real numbers and **F24** (the canvas cache thrashes past ~7 000 wrapped labels;
an LRU does not help); `Intl.Segmenter` banned below `apps/web` and `@sgl/core/inline` banned in
`measure` and `render-svg`; flanking's Unicode-table caveat in DD-11; `loadRichText`'s comment;
`@sgl/text`'s test dependencies; a container's `@size` is `SGL2012`. Goldens: only the two rich
layout goldens of `text/wrap.sgl` changed (its hexagon, 4 lines → 2); none on `main`. Core bundle
181.22 → **181.47 kB**: the render branch has **0.53 kB**, under the ~0.6 kB planned.
- **Docs.** Language spec §3 (Strings) and §4 (`@label`); DD-01 §2 (listing, notes, audit), §3, §4,
  §6, §8; DD-02 §6 rule 7; DD-11 status, T10–T20 notes, T58 note, §19 item 4.

**A18 branch 3, drawing marks and wrapped lines, the fonts and export** (Stage L,
`feat/a18-render`, from `feat/a18-text` at `24e5638`; **not merged**). DD-11 T42–T50, the rest of
T26, T55–T57 and T60's render tests, each marked implemented there; §19 items 3 and 8 fixed, item 5
recorded as **F25** for the human.
- **Renderer** (`@sgl/render-svg`): `render(styled, layout, theme, text?)` takes the measure table
  and draws a label with a box on exactly the lines its entry holds; every other label, a miss and
  no table are the runs split at `\n` (what an unboxed label is measured as, so its key is never
  hashed: DD-11 T42's deviation 1). The vertical model stays `0.8 × fontSize` (F25). A marked
  fragment is a nested `<tspan class="r-strong r-em r-code">` with no position; the three run rules
  are constants appended after the generated rules, only those used; `structureHash` adds a field
  for a marked label; `PaintPlan` keeps the table and the run rules, and `renderPaintOnly` refuses
  another table object. `LabelPlacementView.text` is gone. **No existing render golden changed**:
  the test pipeline passes the table.
- **App**: the render stage uses the table its landed layout was sized from (`layoutTable`, set
  with `layout`), so a label is never drawn on a newer table's breaks inside older frames, and a
  theme switch stays paint-only.
- **Fonts** (T26, human decision): seven run faces, Inter 700, Inter italic 400–700 and IBM Plex
  Mono 400/700 (DD-11's "eight" miscounts its own table), Latin, `display: block`, **registered by
  the lazy `rich-text` chunk** through the Font Loading API (`io/run-faces.ts`), not declared in the
  boot CSS; fetched only when used and precached; export's `SHIPPED` lists the ten faces. No CSP
  change (`font-src 'self'`). **New dependency: `@fontsource/ibm-plex-mono` 5.3.0
  (OFL-1.1)**; Inter's new faces come from the existing `@fontsource/inter`. Plex's licence ships as
  `fonts/OFL-IBM-Plex-Mono.txt`, attributed in the README.
- **Export** (T50): `usedFontFaces` reads an SVG with run tspans element by element, so a bold,
  italic or code run brings exactly its face, never a cross product; an SVG without run tspans
  keeps its selection (checked over the corpus). In the lazy `file-actions` chunk.
- **Goldens.** New: the render goldens of `multiline.sgl`, `text/markdown.sgl` and
  `text/wrap.sgl` through the rich pipeline, four themes (`__goldens__/rich/render/`), and
  `corpus/injection/markdown-in-label.sgl`. No existing golden changed.
- **Tests** (each shown failing first): `rich-render.test.ts` (T42–T48); a seam oracle in
  `rich-corpus.test.ts` (every label's drawn lines are its table entry's lines with its marks,
  each within the wrap width, under grid and elk); the F7 contract, the P3/P4 paint-only path and
  the paint oracle extended to the rich documents and a rich synthetic document under the synthetic
  theme pair; the injection suite through both pipelines; per-element faces
  (`fonts.test.ts`); `apps/web/test/fonts.test.ts` (fonts.css = `SHIPPED` = T26),
  `rich-text.test.ts` (the app draws the measured lines; a rich theme switch keeps the element
  tree), `rich-measure.browser.test.ts` (Chromium: `ready()` loads the faces, every wrapped line's
  `getComputedTextLength()` within 0.5 px of its measured width; F25's numbers); e2e: computed run
  faces and `**x**` → 700, wrapped lines within the node, no run face fetched without markup, the
  seven faces in the precache and none in the built CSS, each run measured in its real face (fails if
  measured before the chunk declares it), Save ▾ SVG embeds exactly each run's face and an `<img>` of it inks
  bold, italic and code within 1 px of each face's metrics (and misses by more than 3 px without
  them), a PNG of an italic title drawn in Inter Italic, the DD-08 §14 font gate with italic, bold
  and code labels, and a markdown document's faces from the service worker offline.
- **Inkscape 1.2.2** (checked by hand on `text/markdown.sgl`'s golden and on the same file with its
  six faces embedded): it applies all three run classes (bold, italic and the code family, strong
  code bold, code never italic), and ignores the embedded faces as D2 found ("font face rule
  limited support"), drawing with installed fonts; the embedded and bare files rasterise
  byte-identically. With only DejaVu Sans installed (no oblique) it draws `em` upright; with a
  family that has an italic installed (Liberation Sans, substituted for the check) it draws `em`
  italic. So the markup is right, and italic in Inkscape depends on the viewer's fonts.
- **Benches** (reported, not gated): `bench/scale-document.js` gains `{ rich: true }`.
  `n2000-rich`'s pre-measure in Chromium is 44 ms cold (plain n2000 35 ms), 32 ms warm; a Theme ▾
  pick on it is paint-only at 48.0 / 54.1 ms median `work` (first / repeat pick), a few ms over the
  50 ms budget on the slower pick (F9's row); the gated points in the same run: 2.2 / 10.9 /
  37.3 ms.
- **Size.** Core bundle 181.22 → **181.36 kB** (fonts, step 1) → **181.81 kB** (renderer, step 2) →
  **181.81 kB** (T50, lazy) → **181.82 kB** (the box gate on the lookup) → **181.71 kB** (the run
  faces moved from the boot CSS to the lazy chunk) of 182: **0.29 kB left**.

**A18 branch 3, fix round 1** (`feat/a18-render`, after merging `feat/a18-text` at `94f3491` in
`dfb7a59`). Step 0: `text/wrap.sgl`'s four rich render goldens re-baselined for branch 2's hexagon
fix (only `n-hexagon` changes shape and lines — two lines instead of four — and every other node only
moves with the packing; no golden from `main` changed). Then, each test shown failing first:
(1) a boxed label missing from the landed layout's table draws from the latest table, not on one
line, and the render follows the latest table only while such a label exists (an edit changing no
boxed label costs one render: found by item 9's bench); (2) the italic PNG check reads the faces of
the rasterised copy itself and compares the drawn advance with an independently loaded Inter Italic
in the drawn tree; (3) code computed upright inside `em`; (4) every run face loaded before the
pre-measure measures its runs (`rich-font-gate.browser.test.ts`), the post-paint checks removed;
(5) a label style asking for weight above 600 or italic loads the run faces without markup, so the
screen draws the face the export embeds; (6) the corpus's export font selections pinned as a golden
made with `24e5638`'s code; (7) an edge label's marks alone emit `.r-em`; (8) each rich-export
iteration waits for its own picture; (9) `n2000-labelled`, T57's control: 31.3 / 32.7 ms against
`n2000-rich` 44.9 / 43.7 ms (median `work`, first / repeat pick, same run), so the run tspans cost
~12 ms; (10) a comment nit. To stay under 182 kB, the `labelRunKey` memo and `textBlock`'s unused
width estimate were removed. **Size:** 181.97 kB after the merge → 181 971 B (1) → 181 916 B (5) →
**181 970 B** (1's follow-up), 30 B under.
- **Docs**: DD-11 (status, T26, T28, T42–T50, T54–T58, T60, §19 items 3, 5, 8); DD-07 §5, §6, §9,
  §11; DD-08 §3, §5, §7, §12; DD-09 §2, §3.2; DD-10 §1–§2; architecture §7; README attribution.

**F20 bundle headroom** (Stage L, `feat/boot-headroom`, from `main` at `944015b`; **not merged**).
Size only; no behaviour, golden, CSP or precache change, and no new chunk. Measured first: the core
bundle's 181 970 B broken down by source module (marginal gzip; `@codemirror/view` 55.1 kB, `state`
14.7, `@lezer/lr` 8.0, `language` 7.5, `commands` 7.0, `@lezer/common` 6.6, `lint` 4.5, core's
`resolve` 4.2, preact 4.0, …; the worker 8.8 kB). Two changes, each its own commit:
- **`@sgl/layout-std/descriptor`** (`ea5fd5c`, **−996 B**). The page imported `gridEngine` for
  `REGISTERED_ENGINES`, and an object literal's `layout()` cannot be tree-shaken, so grid's packing
  code sat in the boot bundle though only the worker runs it. `gridDescriptor` (everything but
  `layout()`, as `@sgl/layout-elk/descriptor` is for elk) is its own entry; `gridEngine` spreads it.
  Tests: `layout-std/test/descriptor.test.ts` (the descriptor field by field, and `gridEngine`
  minus `layout()`); `check-core-chunks.mjs` fails if a boot chunk holds grid's layout code, and
  requires the worker to (shown failing on the build before the change).
- **Terser minifies the JS** (`bf1053c`, **−4 980 B**). `apps/web/build/minify.ts`'s `sglMinify()`,
  a `post` `renderChunk` hook on the page and the worker builds, with `build.minify: false` (terser
  over esbuild's output was 1 kB *larger*) and `build.cssMinify: 'esbuild'` (CSS byte-identical).
  `module: true`, `ecma: 2020`, two compress passes, no `unsafe*` option. The lazy `elk` chunk keeps
  esbuild (terser takes ~45 s on elkjs; the build stays ~15 s). `terser` 5.51.2 was already in the
  lockfile (vite's optional peer, through workbox-build) and is now a declared **devDependency** of
  `@sgl/web`; nothing of it ships. Tests: `apps/web/test/minify.test.ts` (3); all 109 e2e cases run
  against this build.
- **Size.** Core bundle 181 970 → 180 974 → **175 994 B (175.99 kB) of 182 kB: 6.01 kB left**
  (5 976 B reclaimed). §2.1 F20 is closed. Not taken, for the human (each needs a behaviour or
  design change): elk's mapping into the lazy `elk` chunk (−2.3 kB from the worker, but the
  default engine needs it before the first picture, and DD-10 §2 settles that chunk as elkjs only);
  a lazy `@codemirror/lint` (−4.3 kB, but the editor's first render shows diagnostics); the static
  measurer as a lazy degrade path (−1.0 kB, but `CanvasMeasurer` falls back to it synchronously);
  the high-contrast and print themes, the example document and the diagnostics catalogue (each
  needed by some first render).
- **Docs**: DD-06 §7, DD-08 (Stage K's engines paragraph), DD-10 §2.

**F16, mostly fixed** (Stage L, `fix/f16-title-crossings`, from `main` at `755bfd0`, `main` merged in
at `c6859f7`; **not merged**). Under `elk`, 13 edges in six documents entered a container through its
own title. **Root cause:** the title is not sent to ELK (DD-06 §6.1 note 2); it sits in the band
`elk.padding.top` reserves, which ELK treats as empty padding, so an edge into a child runs straight
down from the container's top edge, through the title whenever it meets the child under it. **Tried
at the source first:** the title as a container label `[H_LEFT, V_TOP, INSIDE]` or `…, H_PRIORITY]`
gives 0 crossings only because ELK then reserves a left column as wide as the title (node frames
change in 18 documents); `[H_CENTER, V_TOP, INSIDE]` leaves all 13; `SEPARATE_CHILDREN` on
containers makes ELK throw on 10 documents. **Fix:** `fromElkGraph` detours each vertical run
through the title of a container holding its far end round the title's right (`avoidTitle`,
`mapping.ts`; DD-06 §6.2): turn back below the title, end on the node's top, or enter its side; runs
stacked right to left, and a detour that would meet another route is not made. Only under
ORTHOGONAL and POLYLINE (the engine passes `arrowSize`), never SPLINES. **Fix round 1** (7 items,
after review): the last segment into a node is always at least `arrowSize` + 4 px (the round-1
turn-back left 3 px, and the arrowhead on the title); runs that do not fit are left alone instead of
being crossed (round 1 skipped them and crossed 5 of them); mixed shapes no longer cross; thin bands
use a tolerance; the SPLINES gate; the ancestor check restored; horizontal runs out of scope.
`titleCrossings`: `checkout` 2 → 0, `containers-edges` 1 → 0, `nesting-3` 1 → 0, `text/wrap` 1 → 0,
`wildcard-paths` 4 → 0, `wildcards` 4 → 4 (ELK runs other edges 0.4–20 px right of those titles,
so no detour fits: §2.1 F16). K4 hierarchy crossings stay 0; no overlaps, no detached ends; no
detour adds a meeting of two routes on any corpus document. **Goldens:** only `sgl.elk` layout
goldens of documents whose routes change: `layout-elk` `result/` checkout, containers-edges,
nesting-3, wildcard-paths, and `render-svg` `rich/sgl.elk/text__wrap`; `wildcards`' is back to
`main`'s. **Size:** 175 994 → 176 817 B (+823 B, worker), over the branch's +600 B budget (§2.1 F16).

**Stage K merged to `main` at `0e9ecfc`** (`--no-ff`, 2026-09-23) after a three-lens review and
one fix round (23 items). `pnpm check`'s steps from clean are green on `main`, run by the
orchestrator: 2139 Vitest passed (unit + browser project, Chromium only), e2e 55/55 in Chromium,
`size-limit` 177.22 kB gz of 180 (the same figure under Node 20.19.0, CI's `.nvmrc`). **All six
MVP criteria are automated with both engines registered: Gate 3 is next**, and its only
remaining step is T5, by hand. **T5 so far (human, 2026-09-23):** golden SVGs render correctly in Edge but rendered **all black in
Inkscape** (F17, since fixed on `fix/svg-inkscape`, below — re-checked by hand after the fix: **Inkscape renders the goldens correctly**, human, 2026-09-24); Figma and Safari not checked (no access); PWA install could not be completed and
is set aside for now. CI (`.github/workflows/ci.yml`) is active on GitHub but has **no recorded
runs**, so Firefox/WebKit and the Node 20 path are not yet verified there. The orchestrator accepted two things the gate text does not say
literally, both recorded here: (1) container titles are placed by the elk adapter in the band
ELK reserves (the title is not sent to ELK, DD-06 §6.1 note 2), which meets the gate's intent,
"not from the host fallback"; (2) a few edges still enter a container through its own title
(`checkout` 2, `containers-edges` 1, `nesting-3` 1, `wildcards` 4), pinned as a counted warning
because no ELK option removes them — **F16**. History note: `7e5aed5` on the merged branch is a
deliberately red `wip` commit (the worker-blocker reproduction, fixed in `344620e`), kept rather
than rewritten because the branch was already pushed; `main`'s first-parent history is green.

**F17 fixed, merged to `main` at `ff6853e`** (Gate 3 / T5; one all-lens review, no blockers; the orchestrator rendered every re-baselined golden in Inkscape 1.2.2 — none paints black; 2220 Vitest + 55/55 e2e from clean). Exported SVGs rendered all black in Inkscape
because Inkscape 1.2.2 discards the whole `<style>` element that holds the theme-token rule
`svg.sgl{--sgl-canvas:…;…}`. `render()` now writes two `<style>` elements where it wrote one: the
main one (`RenderResult.styleBlock`) with every painting rule, literal values only and no custom
property declared or read — `.canvas` gets its literal resolved colour instead of
`var(--sgl-canvas)` — and right after it the unchanged token rule in its own element (the new
`RenderResult.tokenBlock`). (Re-theming by overriding the tokens was later dropped, human decision 2026-09-24 — F18; the vestigial token element goes in the F7/F14 re-baseline.)
`packages/render-svg/test/style-elements.test.ts` holds that over the whole corpus, with an
injection case for hostile token names, values and canvas colour; `test/browser/tokens.browser.test.ts`
checks in Chromium that the token element parses whole, removing it leaves the paint unchanged, and
an override applies. `apps/web/e2e/f8-style-decode.spec.ts` now reads both `<style>` elements.
**Every SVG render golden (36) was re-baselined, by human decision on 2026-09-23**; with the
`<style>` elements removed, each is byte-identical to its predecessor, and no other golden changed.

**Gate 2 is cleared.** `feat/app-editor` cleared its review-fix round
and merged to `main` at `b013aff`; `pnpm check` is green there (1772 Vitest + 6 skipped by design,
14 e2e in Chromium, unchanged from the branch), so **Stages A–I are all on `main` and Stage J's
stated dependency is satisfied**. `fix/arrowhead-gap` merged at `b16ad27` before it (1643 tests),
`feat/layout-host` at `279d84b` (1625 tests), `feat/pipeline` merged at `ffff7de` before it (1553 tests), `feat/renderer` at `6d76e2c` (1453
tests), and `feat/grid-engine` at `fdff204` (757 tests). Each sat unmerged on their branch through review first, which is the documented
pattern, not the merge-gap failure mode — but it is worth noting for the next stage that this has now
happened six times in a row (Stages C, E, F, G, H, I), so **check `git branch -vv` before briefing stage
N+1** rather than trusting a §5 entry that says "Depends on. Stage X merged." `main` must be green at
every commit.

**Stage E is done**, merged to `main` from `feat/grid-engine`, rebased onto `main` at Stage D.
`buildLayoutInput`
(`packages/layout-api/src/sizing.ts`) turns a `StyledGraph` and a `LabelId -> Size` table into a
`LayoutInput`, closing a real gap in `LayoutInput`'s frozen contract: neither Architecture §4.2's
sketch nor DD-06 §2's original recipe had anywhere to put per-node sizing once `GraphNode` turned
out (Stage C) to carry no geometry at all. `sizing`/`labelSizes` were added to `LayoutInput` as
parallel maps rather than as fields on `GraphNode` — additive, not a change to any existing frozen
field — and the deviation is written up in DD-06 §2. `grid` (`packages/layout-std/src/grid.ts`)
implements DD-06 §7's row/column packing in two passes — bottom-up sizing, top-down absolute framing
from a single shared memo — and clears **F1** by filtering `.hidden` out of `children`/`rootChildren`
at every level, not just the top. The host fallbacks (`placeLabels`, `routeStraight`) and
`validateResult`/`quantize` are implemented per DD-06 §4/§5, with `routeStraight` additionally doing
§4.4's arrow reserve (not named in this document's own Stage E task list, but skipping it would leave
every directed edge — the majority of the corpus — with its arrowhead straddling the node boundary).
§4.6 (aspect lock) is **not** implemented; no corpus document exercises `aspectRatio` and no stage's
task list names it. `validateResult`'s `SGL4003` "corrected" behaviour for an overflowing
`contentFrame` is downgraded to warn-only, since its inherited signature returns diagnostics, not a
new `LayoutResult`, and has nowhere to put a correction. Bitwise double-run determinism and
zero-diagnostics validation (both `SGL4002` and `SGL4003`, and DD-06 §8's conformance item 3 — no two
sibling leaf frames overlap) hold over every document in `corpus/`, including `malformed/`,
`unresolved/` and `injection/`; layout goldens are committed for the same clean-document set
`compile()`'s own gate uses (757 tests total, up from 504 before this stage). One finding surfaced
and fixed during implementation, not by design: an early version double-counted a container's own
padding when placing its children (content-origin offset applied on top of an
already-padding-inclusive relative position) — caught by the `nesting-3.sgl` containment test, not
by the flatter fixtures. A gap outside this stage's reach: a root-level `@layout.columns` hint can
never reach `grid`, because `compile()` (DD-03, frozen) keeps only `model.root.config.title` from the
root's config and drops the rest.

**A review round found one real defect and two latent inconsistencies, all now fixed.** `content-insets.ts`
read DD-07 §4's inset table as if its `w`/`h` were the *label's*; they are the *shape's own*, the
same `w`/`h` the table's `path` column draws with, so every non-box shape (ellipse, diamond, hexagon,
cylinder) came out too small — a diamond roughly half the size it needed to hold its label. Fixed to
the solved-for-the-label forms (`packages/render-svg/src/shapes.ts` on `feat/renderer`, commit
f1c476c5, already had the correct derivation; DD-07 §4 is amended to say explicitly which `w`/`h` the
table means). The test suite now asserts the containment property the formulas exist to satisfy, not
just pinned numbers, across a spread of label sizes — the drift guard the duplication needs, since
`layout-api` may not import `render-svg` even after both are on `main` (DD-00 §2 rule 2 is permanent,
not a merge-order artefact; the "until Stage F merges and the two copies become one" framing here was
wrong and is corrected by this note). `anchor.ts` was checked line-for-line against the same
`feat/renderer` commit's anchor functions and found to already agree (no fix needed there); its tests
were strengthened with diagonal-ray boundary checks to pin the defining geometric property. Stage F
then added the automated cross-package equality test this paragraph said wasn't possible yet — a
`render-svg` *test* file is exempt from the import-boundary lint rule, so
`packages/render-svg/test/shapes.test.ts` now calls both `@sgl/layout-api`'s `anchorPoint`/
`contentInsets` and `render-svg`'s own `SHAPES[id].anchor`/`.contentInsets` and asserts exact equality
across all seven shapes, a spread of ray angles, and a spread of label sizes — confirming the two
independently-written copies do agree, not just by manual line-for-line comparison. Separately, in
`fallbacks.ts`: `routeOne`'s port-terminated `endNormal` used a port's own *outward* boundary normal
directly instead of negating it, inverting §4.4's arrow reserve at a port-terminated head (latent
today — `grid` declares `ports: false`); and `selfLoopLayout` returned before §4.4's arrow reserve
ran at all, so a directed self-loop's arrowhead would have straddled the boundary exactly like the
edges the reserve was added to fix. Both corrected, with tests. DD-06 §7 also gained a line noting
that `pack()` — per the algorithm exactly as designed, not a bug — honours a container's `min` but
silently ignores its `fixed`/`max`.

**Stage F is done**, merged to `main` at `6d76e2c` from `feat/renderer`, which had itself been merged
forward onto `main` at Stage E (`fdff204`) before this stage's own work started. It proves the renderer
implementation that was already on the branch: 1438 tests at the first gate, 1453 after four review
rounds, up from 757, all new. Golden SVGs are committed for the clean-document corpus set under
both built-in themes — **`grid` only**, not "both engines" per DD-07 §11's aspirational list, because
the `elk` adapter is still `NotImplemented` (Stage K). The injection suite
(`packages/render-svg/test/injection.test.ts`) parses every rendered `corpus/injection/*.sgl` output
with `fast-xml-parser` and asserts no `script` element, no `on*` attribute, and every `href` on the
allowlist — plus a same-shape check for `checkout.sgl`, so the suite also proves a normal document
parses cleanly, not only that hostile ones are neutralised. Shape maths (`shapes.test.ts`) pins path
strings, the degenerate centre case, and — for every ray angle tested — the exact boundary property
each anchor family must satisfy (on a frame edge for box shapes, on the ellipse equation, on a polygon
edge for diamond/hexagon), plus the cross-package equality test against `@sgl/layout-api` described
above. Document order (DD-07 §7) is asserted directly: the `L-containers`/`L-nodes` layers each follow
`graph.order` filtered to their own kind, and `L-edges` follows declaration order with hidden edges
skipped — not inferred from the goldens.

**F4 (§2.1) is resolved, not just decided.** A one-sided wildcard whose expansion contains its own
literal other endpoint (`x -> /**` type self-pairing) is confirmed as intended behaviour, not an
artefact to suppress: `compile()` needed no code change. DD-03 §3.1's "open" framing is corrected to
"resolved," and `corpus/wildcards.sgl` gained `loop.p -> loop.*` (one self-loop, one ordinary edge)
so the case has real coverage — regenerating the `resolve`/`compile`/`grid` goldens for that one
document, additively, with every other node and edge in it untouched.

**Two documented discrepancies with the implementation, both in DD-07 §8, are fixed — in the
documents, not the code**, which had it right in both cases. The doc described an `escText`/`escAttr`
split; the code correctly collapsed both into one `escapeXml` (the attribute character set is a strict
superset of the text set). The doc's `href` row also listed `http:` and in-document `#n-…` fragment
links as allowed; `safeUrl` only ever implemented `https:`/`mailto:`, and the language spec's own
`@link` row already agreed with the code on schemes — only its incidental mention of `#path` needed
the same correction `security.test.ts` now pins directly (`safeUrl('#n-target').href` is `null`).
In-document fragment linking remains an unimplemented, now-honestly-undocumented gap, not a silently
dropped feature.

**One real gap surfaced during accessibility verification and was fixed, not just noted**: DD-07 §7
specifies `@a11y.description` adding `aria-description` alongside `aria-label`'s `@a11y.label`
override, and the code had no such branch at all — not a latent bug, a feature that was simply never
written. `a11yDescription()` in `index.ts` fills it, wired into both `renderNode` and `renderEdge`, and
`corpus/a11y-links.sgl` (new — no existing fixture exercised `@a11y` or a valid `@link` at all) covers
both the node and edge cases plus the `@link` happy path, which was equally uncovered.

**A second gap was found and left as a documented finding, not fixed, because fixing it is out of this
stage's reach**: `renderNode`'s port-circle loop (DD-07 §3's `<circle class="n-port">` template) is
live code, but nothing in the pipeline ever populates `LayoutResult.nodes[id].ports` for it to read —
`grid` declares `capabilities.ports: false`, and DD-06 §4's host fallbacks cover label placement and
edge routing but not port placement. `render.test.ts` pins the property directly (a port circle carries
`aria-hidden="true"`) against a hand-built `LayoutView`, per DD-07's own `LayoutView` doc comment
anticipating exactly this ("every field here is structurally satisfied by the real `LayoutResult` ...
no cast at the call site"), rather than silently skip it. No stage's task list names a port-layout host
fallback; it belongs with whichever stage eventually reconsiders `ports: false` for `grid` or ships an
engine that lays them out.

**A second review round found four real defects, all fixed on the same branch (1453 tests, up from
1438), plus a set of smaller findings — most still open.** The four fixed defects: (1) `text.ts` interpolated `placement.align` straight into
`text-anchor="..."` with no escaping and no allowlist — the one string in the package that skipped
`escapeXml`, because every producer in the real pipeline (`layout-api/fallbacks.ts`) only ever emits
a literal `'start'|'middle'|'end'`, so the injection corpus (driven entirely through that pipeline)
structurally could not exercise a hostile value. A hand-built `LayoutView` with
`align: 'middle"><script>alert(1)</script>'` produced a real `<script>` element in otherwise
well-formed XML. Fixed by mapping `align` to one of the three literals before it reaches markup
(`'middle'` fallback, chosen over `'start'` because it cannot overflow the frame), and by adding the
same enum check — plus `baseline` and `occlusion` — to `validateResult` (DD-06 §5) so a buggy engine
is rejected before the renderer ever sees the value; both layers are tested. (2) `LabelPlacement
.baseline` was declared but never read: `renderText` always top-aligned, latent only because the host
fallbacks always emit a frame sized exactly to the label. Now honoured (`top`/`middle`/`bottom`, DD-07
§5). Regenerating the goldens surfaced a second, unrelated bug the size of the resulting shift made
visible: `index.ts`'s `labelLines()` joined a label's already-one-run-per-line `LabelSpec.runs` with
`''` and then split on `'\n'` — a no-op search for a character `compile()`'s `textRuns` had already
consumed — silently collapsing every multi-line label onto one line (`corpus/unicode.sgl`'s
`multiline` node rendered as `"Line oneLine two"`). Fixed to the one-line function the comment already
claimed it was (`runs.map((r) => r.text)`); the largest resulting golden delta, measured directly
rather than assumed, dropped from 8.4 px (the multi-line bug) to 0.003 px (quantization noise) across
all 248 labels in the clean corpus. (3) `corpus/a11y-links.sgl` had render goldens under both themes
and nothing else — no `resolve`/`compile`/`grid` golden, and it was absent from three of the four
independently hand-maintained `CLEAN_DOCS` arrays (`core/test/resolve.test.ts`, `compile.test.ts`,
`layout-std/test/grid.test.ts`), because the guard meant to catch exactly this only asserted the list
*contained* two unrelated entries. Consolidated into one `CLEAN_DOCS` in `packages/core/test/corpus-docs.ts`
(core is the dependency graph's floor, DD-00 §2), all four suites re-pointed at it, the missing
goldens committed, and the guard replaced with a real assertion that `CLEAN_DOCS` plus the known-dirty
corpus subdirectories exactly partition `listCorpusDocs()`. (4) `render-svg/src/security.ts` and its
test carried one literal control character apiece (inside `safeUrl`'s scheme-stripping class and a
control-character test string), which made git treat both files as binary — unable to diff, merge or
blame the package's two most security-sensitive files. Replaced with `\x00`-style escapes; both are
ordinary diffable text now.

**Fix 5 (this change) corrects a claim the review round's write-up made but never actually fixed:**
the paint-only `<style>`-block-swap property asserted in **nine** places does not hold — see **F7**
above for the two independent reasons, both verified against the committed goldens. Seven were fixed
in the Fix 5 change itself (`index.ts`'s `RenderResult.styleBlock` doc comment, DD-07 §1/§2/§5/§11,
DD-08 §3 and its Theme ▾ row, DD-09 §2's budget row); a follow-up review found the last two, which
had escaped because neither uses the phrase the sweep grepped for. **They were the two that mattered
most**, both being instructions rather than prose: Stage I's own gate in §5 told a future agent to
"assert the SVG tree is untouched and only the `<style>` block changes" — a Playwright assertion that
cannot pass, now restated to assert *geometry* is untouched, which is what MVP criterion 2 actually
says; and `text.ts`'s `renderText` doc comment still mirrored the DD-07 §5 claim that was corrected
in the document but not in the code beside it. Nothing in `src/` changed beyond those two comments,
because the code was always right — it never claimed the property internally, only the surrounding
prose did. **The lesson for the next sweep:** grep for the *assertion*, not the vocabulary. Both
survivors named the property without using the words `paint-only`, `styleBlock` or `style block`.

**F8** (above) is a second, unrelated finding surfaced while grepping for survivors of the same claim:
whether `<style>`'s XML-escaped content still decodes correctly once it reaches DD-08 §6's `innerHTML`
path is spec reading, not a verified result, because no browser target exists yet. **F9** is a
consequence of F7 rather than a separate discovery: DD-09 §2's `< 16 ms` paint-only-theme-switch
budget was justified *by* the style-swap, so removing the swap left the figure with nothing behind it
and nothing able to measure it until Stage G builds the bench.

**The smaller findings from the second review round are mostly still open — cosmetic or cleanup, no
behaviour impact, none blocked on a future stage, so none of them belong in §2.1 (which is only for
findings blocked on a stage that has not been built):**
- `cssDash` (`style.ts:33`) has a dead conditional whose branches both return `null`.
- `xmlns:xlink` is declared on every SVG and never used — no `xlink:href` is emitted, and `render.test.ts`
  pins the dead declaration.
- The renderer re-emits `SGL3001` for an unknown shape (`index.ts:151`), duplicating `compile()`'s own
  diagnostic, though the Stage F brief in §5 says the shape table needs no fallback branch.
- `eslint.config.js:78`'s `**/test/**/*.ts` exemption also disables the `Math.random`/`Date.now`
  determinism bans, which its comment does not mention.
- `security.ts` is still CRLF, the only such file in the repo (the NUL bytes that made it binary to git
  were fixed in the review round above; the line endings were not).
- DD-07 §8's `href` row still says the language spec's `#path` mention "needs the same correction" —
  it was corrected in commit `405d451`, so that sentence is stale; the same section's CSS-values row
  says "`rgb()/hsla()` grammar" where the code (`security.ts`) accepts `rgb|rgba|hsl|hsla`.
- The hostile-label fixture's occlusion payload exercises nothing: the fixture's label is a node title,
  so `renderEdgeLabel` — the only reader of `occlusion` — is never called. The assertion passes and
  occlusion is safe anyway (`strict === 'plate'`, plus the `validateResult` check), but the test implies
  coverage it does not have.

**Deliberately left out.** DD-07 §11's "paint-only swap: render A, render B differing only in paint →
trees identical when `<style>` is stripped" is not implemented as a test, for two independent reasons
(F7). `neutral-light`/`neutral-dark` differ only in theme tokens (`neutral-dark`'s own file says so), so
the *layout* is provably unaffected by a theme switch — but the rendered *tree* is not byte-identical
after stripping just the `<style>` block. Reason (a): `s-{paintHash}`/`t-{paintHash}` class names embed
the hash directly in every element's `class` attribute, so a paint change changes those attribute
strings throughout the tree, not only inside `<style>` — fixable in principle by keying the class name on
something theme-invariant, not pulled here. Reason (b), independent of (a) and not fixable by a class
rename: a directed edge's arrowhead marker bakes its stroke colour into a `<defs>` element and into the
marker's own `id`, so `marker-end`/`marker-start` references change too, for any document with a
directed edge — this needs a different marker strategy or a `context-stroke` rewrite (both currently
rejected), an ADR-level decision this stage does not make. DD-08 §3's strategy description is corrected
by this change to reflect both reasons, describing a full re-render, not a `<style>`-only swap against
a retained tree. The real version of the swappable property (switching theme leaves `geometryHash` and
layout untouched) is Stage G's stated exit test, at the pipeline level where it is actually true.

Both grammar defects tracked in the README (quoted `@`-keys, `$name` as a
`Variable` token) are fixed and Stage A's gate passed on `main`. Stage B found
one more, upstream of the resolver: `build-ast.ts` had a `ConfigEntry`/`Property`
value-builder switch with no `'Variable'` case, so `$name` lexed as a
`Variable` token but was silently **dropped** rather than reaching the AST —
`@style.stroke: $hot` resolved to no `style` key at all, not to a value worth
a diagnostic. Fixed on `feat/resolver` (`buildValue`/`buildVariable` in
`build-ast.ts`) since Stage B's own gate needs it; `feat/parser`'s original
gate still passes unchanged, as it never asserted on this path.

Stage C's task list in §5 does not mention class linearisation as a task, but
DD-02 §4 is explicit that "DD-03 computes `classes: string[]` in linearised
order per node" and `GraphNode.classes`/`GraphEdge.classes` are frozen types
that need it — filled per the standing rule for an incomplete document.
`compile()`'s `linearizeClasses` implements DD-02 §4's literal recipe
(depth-first over `@extends`, left to right, de-duplicated keeping the last
occurrence); this is monotonic for a chain but not guaranteed so for a diamond
where two siblings share a base — no corpus fixture exercises that edge, and
the deviation (a full C3 merge would remove it) is documented at the function.
Another implementation choice, also undocumented in DD-03 itself: `@hidden`
propagates down the whole subtree (needed for DD-03 §7's "subtree is omitted"
and DD-06 §2's per-node filter to agree).

A post-review amendment on this branch (not a new stage) corrected a related
call that *was* wrong: a node's `ports` originally came only from its own
inline `@ports`, reading DD-03 §3's "the target node's `@ports`" as excluding
a class's. That phrase is about which node an edge *endpoint* validates
against, not about cascade — and DD-02 §7 gives `ports` scope `node, class`
precisely so a class can supply them. Ports now merge across the linearised
class chain and then inline, per port id, with inline winning, the same
precedence `shape` already used; `validatePort` consults the merged
`GraphNode.ports`, not `container.config.ports`, so a class-provided port is
no longer wrongly rejected with `SGL2003`. The same amendment added port-side
validation (`SGL3007`, unknown/non-string `side` values fall back to `east`),
split `SGL3001` ("unknown shape") from the new `SGL3006` ("a real shape name
this version doesn't draw yet"), added `GraphEdge.hidden`, and fixed two bugs:
a zero-length resolved path (e.g. `inner -> ../` from one level down) was
silently treated as a hit on the document root instead of `SGL2001`; and
`SGL2003` was fired once per edge in a wildcard cross product instead of once
per distinct portless node.

**Stage G is done**, merged to `main` at `ffff7de` from `feat/pipeline`, branched from `main` at
`fffe941` (Stages A–F, 1453 tests). `pnpm check` is green (1553 tests, up from 1453) after a review round
that found four real gaps and four nits, all fixed on the same branch. It formalises the
`source -> RenderResult` harness Stage F had already written early (as `renderCorpusDoc` in
`packages/render-svg/test/pipeline.ts`) into `runPipeline`, the literal function task 1 asks
for. **`runPipeline` also inserts `validateResult` into the shared harness for the first time**
— DD-06 §4's own guard against a corrupt engine result reaching the renderer, which the earlier
`renderCorpusDoc` never ran — so every golden and double-run test Stage F wrote (`render.test.ts`,
`injection.test.ts`) now passes through it too on every run, not just Stage G's own tests; `grid`
still produces nothing `validateResult` rejects, so no golden changed.

**Two pipeline-level properties sit on top of the corpus goldens Stage F already proved**, both
in `packages/render-svg/test/pipeline.test.ts`: every corpus document — all 52, not only the 16
`CLEAN_DOCS` — emits exactly its audited end-to-end diagnostic set, and a `neutral-light` vs
`neutral-dark` switch leaves `geometryHash` and the full `LayoutResult` untouched while moving
`paintHash` (MVP criterion 2, at the level it actually holds, stronger than DD-09 §3.3 invariant
3's `styleGraph`-only check). The diagnostics property was `CLEAN_DOCS`-only in the first pass,
which a review round called out as covering 16 of 52 documents while leaving the 36 dirtiest —
`malformed/`, `unresolved/`, `injection/`, and the three generated scale documents — to
`render.test.ts`'s never-throws sweep, which asserts nothing about *which* diagnostics come out.
Extended the same way the clean half was built (a table read off a real `runPipeline` run, not
guessed): each dirty document's own `// expects: SGLnnnn` header (read directly, the same
convention `parse.test.ts`/`resolve.test.ts`/`compile.test.ts` already use) plus an explicit,
human-written `DOWNSTREAM_EXTRA` map for the two fixtures where parser error-recovery adds a
second, pre-existing diagnostic `parse.test.ts`'s own malformed-corpus check already tolerated
without pinning (`malformed/unterminated-string.sgl` also emits `SGL1001`;
`malformed/wildcard-two-stars.sgl` also emits `SGL3003`). A partition check
(`every non-CLEAN_DOCS corpus document is accounted for above`) guards the split itself.

**Task 3 closes F5.** `bench/generate.js` writes `corpus/n50.sgl`, `n500.sgl` and `n2000.sgl`
deterministically; none are committed, matching the design's existing intent (bench/README.md:
"generated rather than committed so the shape of the scale fixtures stays a single decision in
one file"), and `pnpm test`/`pnpm check` regenerate them first via a new `generate:corpus` script.
`corpus/unresolved/edge-expansion-limit.sgl` (a 32 x 32 wildcard cross product, the smallest
square past `MAX_EDGE_EXPANSION`) was generated the same way in the first pass; a review round
found that wrong against bench/README.md's own rationale — a ~30-line correctness fixture is not
"the shape of a scale fixture," and generating it made a correctness gate depend on a build step
a bare `vitest run` or an IDE test runner outside `pnpm test` would not take, unlike every other
committed `unresolved/*.sgl` fixture. It is committed instead, `bench/generate.js` no longer
writes it, and its `.gitignore` entry is removed. It is added to `compile.test.ts`'s
compiler-owned-diagnostics list and `SGL3005` is removed from
`packages/core/test/diagnostics-coverage.test.ts`'s allowlist — the F5 finding is deleted from
§2.1 below, not left to rot.

**A second, unrelated staleness bug turned up while touching that same allowlist, and is fixed
in the same change.** `SGL5004` (theme: a style value failing its registry type) and `SGL6001`
(renderer: a disallowed link scheme) were still marked unreachable with a comment saying theme
"is not yet wired to the corpus" and the renderer "has no tests yet" — true when Stage C wrote
it, false since Stage D and Stage F respectively, but nobody had reconnected the check itself in
the meantime, so it kept passing for the wrong reason. `@sgl/core` cannot fix this alone (it
imports nothing from the workspace, DD-00 §2 rule 1), so the gate is now split:
`packages/core/test/diagnostics-coverage.test.ts` keeps the `1xxx`–`3xxx` half
(`parse -> resolve -> compile`), and a new `packages/render-svg/test/diagnostics-coverage.test.ts`
runs the *whole* pipeline and owns `5xxx`/`SGL6001`. `SGL5004` (`checkout.sgl`) and `SGL6001`
(`injection/js-url-link.sgl`) are confirmed reachable and dropped from the allowlist; `SGL5001`,
`SGL5002`, `SGL5003`, `SGL5005`, `SGL5006` stay on it, but the reason is corrected: each fires on
a defect in a *theme document* (an extends cycle, depth over 8, an unknown token), not a `.sgl`
document, and both built-in themes are well-formed, so no corpus fixture — however malformed
itself — can ever reach them. A review round found the split itself had no partition guard — a
future `SGL6002` could fall through neither gate, a future `SGL5007` could demand a fixture core
structurally cannot produce — so both sets now derive from one predicate in a new
`packages/core/test/diagnostics-scope.ts` (`isRenderSvgOwned`), with a test asserting the two are
disjoint and their union is exactly `CATALOGUE`.

**A real, if narrow, defect in `@sgl/theme` surfaced from writing the theme-switch test above,
and is fixed, not just noted**: `StyledGraph.paintHash` is computed entirely from per-element
`ComputedStyle.paintHash`es, but the canvas background (`ResolvedTheme.canvas.background`) is
paint with no element of its own to carry it, so it was never folded in. `empty.sgl` (zero
elements) exposed it cleanly — `paintHash` came out as `fnv1a64('')` under *both* built-in
themes despite a real background-colour difference between them — but the gap is general: any
theme pair that agreed on every element's paint while differing only in canvas background would
report "no paint change" and could wrongly skip a repaint. Fixed in `packages/theme/src/cascade.ts`
by folding `canvas=<background>` into the same `paintParts` array before hashing; DD-04 §5's
`StyledGraph.paintHash` comment is corrected to say so. This is the graph-level aggregate hash
only — no per-element `ComputedStyle.paintHash` changed, so no rendered SVG byte changed and no
golden needed regenerating (verified: all render/injection goldens pass unchanged). A review
round found this fix had no direct unit test — only the three-packages-downstream pipeline test,
and only load-bearing for `empty.sgl` specifically, which nothing stated. Added a direct case to
`packages/theme/test/cascade.test.ts`'s existing hash-partition `describe` block: two
`ResolvedTheme`s differing *only* in `canvas.background` move the graph `paintHash`, leave
`geometryHash` and every element's `ComputedStyle` untouched — proving the canvas term is doing
the work, not a coincidental element change — and the pipeline test now says in a comment that
`empty.sgl` is the one document where its own assertion is load-bearing rather than redundant
with an element-level paint difference.

**Deliberately left out.** The actual benchmark *runner* — DD-09 §3.1 puts this measurement in
headless Chromium, and no browser test target exists until Stage H (Vitest browser mode). Task 3
only asks for the fixture generator, and F9 (§2.1) is updated to reflect that the fixtures now
exist but the measurement, and any renegotiation of DD-09 §2's numbers, still needs a browser
target. Also left out: actually running `pnpm generate:corpus`'s output through headless
Chromium, a Playwright smoke test of the generated `n2000.sgl`, and any change to `apps/web`
(unstarted, Stage I). DD-09 §4's acceptance-mapping row for MVP criterion 2 now names the new
pipeline-level theme-switch test alongside the Playwright test and hash property it already
credited, since it is the strongest automation of that criterion that exists today. Two
same-branch renames for clarity, not behaviour: `grid.test.ts`'s local `LayoutInput ->
LayoutResult` helper, also called `runPipeline`, is now `runHostPipeline`, distinct from
`pipeline.ts`'s exported `source -> RenderResult` one; and `eslint.config.js`'s
`bench/**/*.js` globals block no longer declares `process`, which `bench/generate.js` never uses.

**Stage H is done**, merged to `main` at `279d84b` from `feat/layout-host` (1625 tests). Branched from `main` at `38ab324` (Stage G, 1580
tests after this stage's own additions). `createWorkerHost` (decision D1) now takes a
`spawn: () => Worker` factory rather than a fixed instance, so it can `terminate()` and respawn;
`options` carries the default/per-engine timeouts (`DEFAULT_ENGINE_TIMEOUT_MS = { 'sgl.grid': 2000
}`, DD-06 §3's own number made concrete) and the main-thread `measure` callback. The worker-side
logic is a second module, `worker-runtime.ts` (decision D2) — deliberately `Worker`-free, taking a
registry and a `{ post }` port, so `worker-runtime.test.ts` drives it with a fake port and no real
`Worker` at all; `apps/web/src/layout.worker.ts` is the one real file this stage adds to `apps/web`,
wiring that runtime to the actual worker global scope with `gridEngine` registered (it has to live
there, not in `@sgl/layout-api`, because DD-00 §2 rule 3 forbids the reverse import). `contract.ts`'s
`MeasurerView` gained `layoutRunsAsync` — the design's own `'measure'`/`'measure-reply'` RPC had
nothing to call it from without an async member, and Architecture §6's full `Measurer` interface
already specified one; the reduced structural view in `contract.ts` had simply dropped it. All of
this is written up in DD-06 §3 in the same change, including the decision that `run()` rejects with
`AbortError` on abort rather than resolving `{ value: null, diagnostics }` like every other failure
path — the one deliberate exception to §1's errors-are-values rule, reasoned through against DD-08
§3 at `host.ts`'s `makeAbortError`.

**The browser project (decision D3) exists now**: `vitest.config.ts` gained a `browser` project
(Chromium + Firefox via `@vitest/browser`'s Playwright provider, both pinned to the installed vitest
version, 3.2.7), matching `*.browser.test.ts` files; `pnpm test:unit` stays Node-only via an explicit
`exclude` on the `unit` project (without it, `*.browser.test.ts` also matches `*.test.ts` and fails
under Node with `Worker is not defined`). The Stage H gate's four conditions — timeout to
`SGL4001`, abort, `SGL4002` on malformed output, the measure RPC — are proven twice: `host.test.ts`
against a fake `Worker` under Node, `host.browser.test.ts` against a real one in both
browsers via a small test-fixture worker (`fixture.worker.ts`, decision D2's "browser tests use
their own test-fixture worker entry" — synthetic `test.ok`/`test.slow`/`test.throws`/
`test.malformed`/`test.measuring` engines, not `gridEngine`, so each condition can be forced on
demand).

**The real `gridEngine`, in a real `Worker`, is now proven too** (fix round 1, item 3 —
superseding this paragraph's earlier claim that adding `gridEngine` to the shared fixture worker
broke it): that failure was re-diagnosed and turned out to be the same intermittent Vite
dev-server cache issue this section's operational note already describes, not a defect in
registering the real engine — two standalone diagnostic workers (one importing only `gridEngine`,
one mixing it with the `src`-imported `EngineRegistry`, the exact combination the original fixture
worker used) both loaded and ran cleanly once `node_modules/.vite` was cleared first. Proving it
properly surfaced a **real** gap while re-testing it, though: `worker-runtime.ts` never applied
DD-06 §4's host fallbacks (`routeStraight`/`placeLabels`) after `engine.layout()` returned, so
`grid` — which declares `edgeRouting: 'straight'` and returns no edges of its own — could never
pass `validateResult` through the real worker/host protocol; every edge came back `SGL4002`
"missing EdgeLayout". Fixed by applying `routeStraight` unconditionally (it only fills an edge the
engine left out, so it is a no-op for an engine that already routed everything) and `placeLabels`
only when `capabilities.labelPlacement` is `false` (it *replaces* `result.labels` outright, so
running it unconditionally would destroy a future `labelPlacement: true` engine's own output) —
this is the one place in the pipeline with both the engine's `capabilities` and its
`LayoutInput`/`LayoutResult` in hand, so it belongs in the worker, not `host.ts`. A dedicated
worker entry, `packages/layout-std/test/browser/grid.worker.ts` (deliberately a *second* worker
entry, not `gridEngine` added back into the shared fixture worker, so a real engine's own import
graph never again shares a file with the small synthetic engines DD-06 §10's gate conditions
depend on), plus a Node-side fixture generator (`bench/generate-grid-fixture.js`, the same
"precompute in Node off a real corpus document, ship as data" shape `generate-render-fixtures.js`
already established) prove `createWorkerHost` → real `gridEngine` → a valid, non-null
`LayoutResult`. DD-06 §10's line recording this as left out is corrected in the same change; the
"bitwise double-run across Chrome and Firefox" half of that line is corrected properly in fix
round 2 below — round 1's own same-browser double-run assertion proved determinism *within* each
browser only, not across them, which round 1's write-up here overclaimed.

**F9 (§2.1) is measured, not cleared** (decision D4). `bench/generate-render-fixtures.js` runs
`runPipeline`'s stages up to but excluding `render()` in Node for n50/n500/n2000 under both built-in
themes and ships the result as a gitignored JSON file; `render.bench.browser.test.ts` times
`render()` alone against it, in-browser, printing median-of-15 rather than asserting a threshold —
timing asserts are flaky in CI, per the brief. n50 stays under the 16 ms budget in both browsers;
n500 is borderline in Firefox; n2000 is 2–3x over it everywhere. The numbers are recorded in
the F9 row below and in `bench/README.md`; confirming or renegotiating DD-09 §2's figure is left as
the human decision the brief said it was, not decided here.

**Fix round 1** (orchestrator review of `ec84684`) closed five blockers, three should-fixes and
three nits, all against real code, none against a hypothetical. **Blockers**: (1) `onMessage`'s
`'measure'` branch never checked whether the message was still for the current request — a late
reply from a superseded (but not-yet-respawned) request, or from a worker already replaced by a
respawn, could resolve an unrelated `layoutRunsAsync` call with stale data, since a fresh worker's
own `'measure'` `req` counter restarts at 0. Fixed by binding each worker's message listener to
that worker instance (`worker !== w` inside the listener discards anything from an
already-replaced worker, of any message type) plus an explicit `message.id === current?.id` check
in the `'measure'` branch specifically, for the same-worker-superseded case the instance check
doesn't reach. (2) `validateResult` dereferenced `result.nodes`/`.edges`/`.labels`/`.bounds` with
no guard that `result` — an untrusted, `structuredClone`d value from a third-party engine — was
even an object; `undefined`/`null`/a number/`{}` threw a `TypeError` from inside `host.ts`'s
message listener *after* the request's timer had already been cleared, leaving `run()` unsettled
forever. Fixed with an upfront shape check, one `SGL4002` and an early return, same as any other
malformed result. (3) the real `gridEngine`-in-a-real-`Worker` gap, above. (4) `host.browser.test.ts`'s
timeout test used a host-wide `timeoutMs`, which also (mis)applied to the follow-up `test.ok`
request — flaky under load (the orchestrator caught a real failure in Firefox under a full
`pnpm check` run). Fixed with a per-engine override on `test.slow` alone; DD-06 §3 also now notes
that the timeout clock starts at `run()`, covering a respawned worker's cold boot and its engine's
import, not just the `layout()` call. (5) DD-08 §3's layout-effect pseudocode still modelled
`host.run()` as throwing a diagnostic on every failure, which cannot happen under this stage's own
contract; rewritten for "resolves a `StageResult`, rejects only with `AbortError`."

**Should-fix**: (6) `run()` called after `dispose()` posted to a terminated worker and hung until
timeout, spawning an orphan worker nothing would ever use — now rejects immediately (a programming
error, §1's "throwing is reserved for a violated invariant," except this rejects a promise rather
than throwing synchronously, to keep every `await host.run(...)` call site's contract uniform). (7)
a new `host-runtime.integration.test.ts` wires the real `createWorkerHost` to a real
`createWorkerRuntime` through an in-memory channel with `queueMicrotask`-based (genuinely
asynchronous) delivery, covering the four gate conditions plus item 1's stale-measure case at Node
speed, so protocol drift between the two halves is caught by `pnpm test:unit`, not only by the
slower browser project against a real `Worker`. (8) a new `worker-runtime.test.ts` case sends two
concurrent `layoutRunsAsync` calls and delivers their replies in reverse order, confirming
`measure-reply` really does route by `req` rather than by delivery order. (9) `performance.now`
(the worker protocol's `ms` telemetry) joined the determinism ban in `eslint.config.js`, with a
single sanctioned call site (`worker-runtime.ts`'s `now()`, one inline
`eslint-disable-next-line`) rather than being an unbanned exception nobody had written down; §1
above and DD-06 §3 both name it. (10) DD-06 §3's lifecycle said a successful `'result'` always
resolves `diagnostics: []` — wrong, `validateResult`'s own warnings (e.g. `SGL4003`) pass through
on a success too; a `host.test.ts` case now pins a non-null value carrying a warning.

**Nits**: (11) the unregistered-engine `SGL4011` message no longer repeats the engine id `{id}`
already names in the template (`"not registered in this worker"`, not `"engine 'x' is not
registered..."`), and DD-06 §3 now says this code covers that case too, not only an engine throw.
(12) `package.json` had picked up CRLF→LF line-ending normalisation and a decoded `\u`-escape in
its `description` across the earlier commits — restored byte-for-byte against `main`, with only
the intended script/dependency lines differing; `vitest` is now pinned to the same exact `3.2.7`
`@vitest/browser` already used, and the lockfile regenerated. (14) `WorkerHostOptions.measure`'s
doc comment now says the returned value must be `structuredClone`-safe plain data.

**Fix round 2** (orchestrator review of `8891f2e`) closed two more items, both confirmed against
real code, both direct consequences of round 1's own fixes rather than newly-introduced defects.
(1) **"Across Chrome and Firefox" was overclaimed.** Round 1's `grid.browser.test.ts` asserted only
a same-browser double-run — proof of determinism *within* each browser, not *across* them or
against Node, which is what DD-06 §10's phrase actually means. Fixed by having
`bench/generate-grid-fixture.js` also compute the **expected** `LayoutResult` in Node, via the
exact sequence `host.ts`/`worker-runtime.ts` run for a real request (`gridEngine.layout ->
routeStraight -> placeLabels -> quantize(…, 64)`), and asserting in-browser that
`JSON.stringify(outcome.value) === JSON.stringify(expected)`. It held on the first real run, with
no loosening: **Node's precomputed result, Chromium's own run and Firefox's own run are all
byte-identical for `n50.sgl`** — Node ≡ Chromium ≡ Firefox, genuinely proven, not just asserted.
The same-browser double-run test is kept alongside it (a different property: repeatability, not
cross-environment agreement). (2) **A non-object engine result through the real worker produced
`SGL4011`, not `SGL4002`.** Direct fallout from round 1's own item 3 fix: once `routeStraight`/
`placeLabels` ran unconditionally after `engine.layout()`, they made exactly the same
shape assumptions `validateResult` does, so an engine resolving `undefined` (or anything else that
fails that shape check) made `routeStraight` throw *inside the worker's own `try`/`catch`* — the
caller got a worker-side `SGL4011` with a raw `TypeError` message, and round 1's item 2 shape guard
in `validateResult` was only ever reachable through a fake `Worker` that skips the fallbacks
entirely, never through the real protocol. Fixed by exporting `validate.ts`'s `describeShapeError`
(reused, not duplicated) and having `worker-runtime.ts` skip the fallbacks and post a malformed
`raw` result through unchanged whenever it fails that check, so `host.ts`'s own `validateResult` is
what rejects it — restoring the `SGL4002` the design actually calls for. A new
`host-runtime.integration.test.ts` case proves this through the real host + real runtime: an engine
resolving `undefined` now gives `{ value: null, diagnostics: [SGL4002] }`, and the next request
succeeds; a `worker-runtime.test.ts` case proves the narrower claim (the malformed result is posted
through as `'result'`, unchanged, not `'error'`).

**Operational note, reworded, not a code finding**: the previous round observed `pnpm check`
hanging intermittently on the browser project on this machine after other pnpm commands had just
run; the orchestrator's own clean, combined `pnpm check` run on `ec84684` did **not** reproduce it
(~30 s, one real failure — item 4's flaky timeout test, not a hang). This stage's own reruns during
this fix round saw the hang recur once more, always fixed by clearing `node_modules/.vite` first —
so it reads as a genuine but intermittent Windows-specific Vite dependency-optimisation race in
front of the browser provider, not a reliably reproducible property of this repository and not a
defect in the host/runtime code. Recorded as an observation for whoever next hits it, not as
something this stage could fix.

**Stage I part 1** (merged to `main` at `b013aff` with the rest of Stage I; branched from `main` at `af09d48`,
Stages A–H, 1625 tests). `pnpm check` is green (1653 tests, up from 1625). Only what part 1's
brief scoped: `@sgl/core/editor` (`packages/core/src/editor.ts`) — the `LRLanguage` over the
shared Lezer parser, DD-01 §6's tag/fold/indent mapping, filled out for four tokens the table
didn't name (`ConfigString`, `Bool`, `Null`, `Variable`); the DOM-free signal graph and pipeline
orchestration (`apps/web/src/state/pipeline.ts`, `types.ts`, `metrics.ts`, `measure-styles.ts`,
`worker-host.ts`), with the layout host, measurer and debounce clock injected (I3) and driven by
fakes in `apps/web/test/pipeline.test.ts` — last-good survives a syntax error, a superseded
layout is aborted and ignored, a theme-only change skips layout but re-renders, `SGL4001`/
`SGL4002` keep the previous layout, and the 120 ms debounce coalesces rapid edits; the real
worker wired through `createAppWorkerHost` (`apps/web/src/state/worker-host.ts`); the CodeMirror
editor (`apps/web/src/editor/`) with DD-08 §4's extension list, `setDiagnostics` on every `diags`
change, and a transaction-based `replaceDocument` ready for part 2's Open/Save; the canvas
(`apps/web/src/canvas/`) with the host `<svg>`, pan/zoom (`k ∈ [0.1, 8]`), fit on open and on the
button only, the `innerHTML` swap of a wrapper `<g>`, and hover/click computed from
`lastGood.layout` frames via a pure `hitTestNode` (`apps/web/test/hit-test.test.ts`,
`viewport.test.ts`); `App.tsx` wiring all of it into DD-08 §2's editor-left/canvas-right shell.
Verified in a real browser via `pnpm dev`: typing renders and updates the diagram live, and an
unterminated string shows a squiggle at the right offset while the previous diagram stays on
screen (FR-E4) — `App.tsx`'s `EXAMPLE` default document is `checkout: { web: "Web App" ... }`,
a colon after the container key, per DD-01's `NodeDecl` grammar (`NodeKey (":" NodeValue)?` —
the colon is not optional before a block). Pickers, the
diagnostics panel, the status chip, Inter/font bundling, the §13 error boundary and the
Playwright gate are **explicitly part 2**, not started. F2 (a class-sourced diagnostic's
`related` span) is also part 2's, not this change's.

A **build-tool finding, fixed in the same change**: `packages/core/tsdown.config.ts` already listed
`src/editor.ts` as a second entry (Stage A/D-era scaffolding, before this stage gave it real
content); once `editor.ts` actually imported the same generated, non-TS grammar module
(`src/grammar/sgl.parser.js`) that `index.ts` already does via `parse.ts`, tsdown's default
unbundle mode extracted that shared file into one hashed chunk but did not rewrite the relative
import specifier in either entry's own output — both `dist/parse.js` and `dist/editor.js` kept the
literal, now-nonexistent `./grammar/sgl.parser.js` path, breaking `@sgl/core` at import time for
every consumer, not just the editor entry. Not caught by `pnpm build` (which only reports success
per file written), only by `pnpm test`, which is why §1's "`check` builds before testing" rule
exists. Fixed with `unbundle: false` in `tsdown.config.ts`. *(Corrected in fix round 1: this
paragraph originally said the grammar is then inlined into both entries. It is not.)* Bundle mode
puts the grammar in one shared chunk, `dist/sgl.parser-<hash>.js`, which imports only `@lezer/lr`,
and rewrites both `index.js`'s and `editor.js`'s imports to point at it. That rewriting is what
unbundle mode failed to do. The entries stay independent where DD-01 §7 needs it: `index.js`
imports nothing from `editor.js`, so no CodeMirror code reaches a consumer of the `.` entry.

**Deviations from DD-08 §3's pseudocode, all recorded in DD-08 §3 itself in the same change**:
`premeasure`'s real signature has no `previousTable` parameter to pass one through (the
measurer's own per-run cache delivers the same reuse in practice); `ctx.metrics` has no
`ResolvedTheme` field to derive "theme-derived numbers" from, so the app reuses the same static
constant `packages/render-svg/test/pipeline.ts`'s reference harness already established;
`diags` also folds in `theme`'s, `styled`'s and `render()`'s own diagnostics, which the
pseudocode's list omits; and the paint-only skip condition's "engine/options unchanged" half is
tracked in a small piece of state alongside `lastGood`, since `lastGood`'s own documented shape
has nowhere to carry an engine id or an options bag.

**Bug fix, `fix/arrowhead-gap`, merged to `main` at `b16ad27`.** A user-reported
rendering bug, not a stage: every directed edge's arrowhead stopped `arrowSize` short of the node
it pointed at. Root cause was a double application, not a missing one — `fallbacks.ts`'s
`applyArrowReserve` (DD-06 §4.4) correctly shortens the path by `arrowSize` so the marker's *tip*
lands on the boundary, but `render-svg/src/markers.ts`'s `markerElement` anchored the marker's
`refX` at the tip itself (`start ? 0 : w`), which put the tip at the already-shortened path end
instead of `arrowSize` beyond it. Fixed by anchoring `refX` at the shape's *base* instead
(`start ? w : 0` for `triangle`/`open`/`diamond`, whose point falls exactly at the marker box's far
edge; `circle` gets its own offset, since it is capped to `min(w, h) / 2` to fit inside
`markerHeight` and so falls short of that far edge by `(w - h) / 2`) — DD-06 §4.4 itself needed no
change. DD-07's markers paragraph now states the anchoring rule. Every corpus golden with a
directed edge changed, by exactly its marker's `refX` value and nothing else (confirmed by a
word-diff across all 28 changed files). Added the seam test the original bug slipped through:
`pipeline.test.ts` now reads a rendered edge's own path and marker geometry back out of the SVG
string (not the `EdgeLayout` that produced them) for every `forward`/`both` edge with a
box-anchored endpoint across `CLEAN_DOCS`, and asserts the reconstructed tip lands on the target
node's `LayoutResult` frame boundary within 0.05 px — confirmed failing (short by `arrowSize` on
every checked edge) against the pre-fix `refX`, passing after. `markers.test.ts` gained a matching
direct unit assertion pinning the anchor per arrowhead kind.

**Stage I part 2 is done on `feat/app-editor`** (`main` merged in twice more — once for the
theme-switch-budget renegotiation and Stage K reordering, once for the arrowhead-gap fix, both
above). `pnpm check` is green twice in a row from clean, unit/browser at 1743 tests (up from 1653)
plus the new Playwright e2e project (8/8, Chromium). Everything the part 2 brief scoped:

- **Pickers (DD-08 §10)**: `ThemePicker`/`EnginePicker` (`apps/web/src/toolbar/`), the 24 px
  swatch, the `determinism` badge, "(set by document)" when `@theme`/`@layout.engine` overrides
  the picker. Reading an override (`state/overrides.ts`) and *writing* one — "editing it writes
  into the document's root config via a transaction" — needed a small new module
  (`state/root-config-edit.ts`) to compute the minimal text change from the already-parsed AST,
  dispatched through the `EditorView` `Editor.tsx` now exposes via an `onView` callback (the one
  deliberate, narrow hole in "the pipeline never touches CodeMirror," owned by the app shell). The
  per-engine options form is F11 (Stage K), not built.
- **Diagnostics panel and status chip (DD-08 §11), the "Fit" offer (§6), the §13 error boundary**:
  all state-layer logic (`state/chip.ts`, `state/pipeline-error.ts`), Node-tested
  (`apps/web/test/chip.test.ts`, and the error-boundary/chip/fit-offer cases added to
  `pipeline.test.ts`) before any component renders it. `pipeline.ts` gained
  `effectiveThemeId`/`effectiveEngineId` (document overrides win over the picker signals), a
  `pipelineError` signal fed by try/catch around `render()` and around the layout effect's
  `host.run()` rejection path (§13: a rejection other than `AbortError` is a violated invariant,
  not a document problem), and `layingOutVisible`/`fitOffered` signals driving `chip`.
- **Fonts (DD-08 §5)**: Inter 400/500/600 as WOFF2 (`apps/web/src/fonts.css`), `font-display:
  block` — written by hand rather than importing `@fontsource/inter`'s own `400.css`/etc., which
  ship every Unicode subset at `font-display: swap`; this file declares the three Latin-only faces
  itself, pointing at the same WOFF2 files the installed package already has.
- **A real bug found and fixed while building DD-08 §14 test 8 (the font gate), not a doc
  finding**: `apps/web/src/state/pipeline.ts`'s layout effect fired on boot with `table` still
  `{}` (its initial value), laying out every label at zero size before the *real* premeasure table
  landed a moment later and produced a second, correctly-sized layout — a real, briefly-visible
  "wrong size" flash on every cold load, not a test artefact. Fonts were never the cause;
  `document.fonts` already reported every face `loaded` by the time either layout ran. Fixed with
  a `hasMeasuredOnce` guard on the layout effect, gated correctly only after finding that setting
  it *after* the `table.value` write was one statement too late — `@preact/signals` reruns a
  dependent effect synchronously, inline in the write itself, so the guard has to already be true
  before that statement runs, not after.
- **F2**: `packages/core/src/compile.ts`'s `resolveShape`/`buildPorts` now thread which class (if
  any) contributed the value that produced a `SGL3001`/`SGL3006`/`SGL3007`, and attach a `related`
  span at that class's declaration (`model.spans.get('c:<name>')`, already populated by
  `resolve()`) when it did. `packages/core/test/compile.test.ts` covers both the inline case (no
  `related`) and the class-sourced case (three nodes extending one bad class, all `related` to the
  one declaration). No golden changed — the existing tests only ever asserted `.code`, never the
  full diagnostic object.
- **F8**: verified live rather than left as spec reading. `apps/web/e2e/f8-style-decode.spec.ts`
  reads a rendered label's computed `font-family` back out of the DOM and confirms it is the real
  multi-word stack, not literal `&apos;` — the reading DD-07 §8 gave (`style` is not in HTML's
  foreign-content breakout list, so it parses as ordinary SVG element content, entities decode)
  holds.
- **F9**: measured, and **does not clear the renegotiated budget** — see the F9 row below. This is
  the one item the brief said to stop and report rather than resolve; not fixed here, and the
  execution plan's F9 row is updated with the numbers rather than marked cleared.
- **Criterion 1's single-engine half** needed a real 40-node, three-level document; none in
  `corpus/` fit (n50/n500/n2000 are generated, two-level, and exist for scale timing, not this
  shape). Added `corpus/forty-three-level.sgl` (hand-written, committed with its own goldens,
  `CLEAN_DOCS`) rather than inlining a large literal in a Playwright test.
- **Playwright e2e** (`apps/web/e2e/`), against a production build (`vite build` + `vite
  preview`): MVP criteria 2, 3 and 1's single-engine half; DD-08 §14 tests 1, 2, 3 (as corrected by
  I2) and 8. `pnpm check`/root `pnpm test:e2e` run it in Chromium only; `pnpm
  test:e2e:all-browsers` (CI, `.github/workflows/ci.yml`) runs all three engines, needing a
  one-time `pnpm exec playwright install webkit` per machine (README, alongside the existing
  chromium/firefox note).

Two testing gotchas found and worked around, both in the e2e suite rather than the app:
`closeBrackets` (DD-08 §4) auto-pairs a typed opening `"`/`{`, so per-character `type()` of a
fixture or of deliberately-broken syntax can pass through a momentarily *valid* intermediate state
a debounced layout can legitimately pick up as `lastGood` — `page.keyboard.insertText()` (one
atomic input event, the same shape a real paste produces) avoids it; and the example document's
own trailing newline means `Control+End` lands on an empty final line, so "delete the closing
brace" needs two `Backspace`s, not one.

**Stage I fix round 1 is done**, merged to `main` at `b013aff`. The 18-item list came from the
orchestrator's triage of the part 2 review. An interrupted implementer left a WIP commit
(`0ffa048`), which this round verified item by item and finished. What landed:

- **Guard tests that fail when the guard is removed** (`apps/web/test/pipeline.test.ts`). Both
  mutations were checked by hand.
  - *Superseded layout.* The fake host can now ignore abort, so a superseded request's
    *fulfilled* result really arrives, both before and after the current one. The test asserts it
    touches none of `layout`/`layoutDiags`/`lastGood` and that the current result is adopted.
  - *`hasMeasuredOnce`.* The boot test fires every debounce the moment it is scheduled and records
    each run's `LayoutInput`. It asserts exactly one layout runs, carrying the real premeasure
    table's non-zero size for every label.
- **"At the right span"** (`apps/web/e2e/criteria.spec.ts` criterion 3, `dd08-14.spec.ts` test 2,
  `helpers.ts`). The test reads CodeMirror's error decorations back as document offsets and
  compares them with the front end's own spans for the text read back from the editor. It also
  checks the panel's exact diagnostic codes. `toCmDiagnostic` moved to `editor/diagnostics.ts` with
  a unit test. Shifting its span by one fails both e2e tests.
- **DD-08 §13 on every stage** (`state/pipeline.ts`, `types.ts`). `parse`/`buildAst`, `resolve`,
  `compile`, `resolveTheme`, `styleGraph` and `render()` each hold their last good value on a
  throw, and a stage downstream of a frozen one does not run. A boot-time throw falls back to the
  empty document, so the editor still mounts. `lastGood` is built from the render's own inputs.
  Layout-input building moved inside the layout boundary. Every boundary logs the original error
  with `console.error`. The unit tests inject throws into parse, compile, styleGraph (at boot) and
  render, plus `measurer.ready()`/`premeasure`.
- **Picker writes** (`state/root-config-edit.ts`, new `state/picker-actions.ts`, both pickers).
  A write edits whatever already sets `@theme`/`@layout.engine`, in place, including an
  `@layout: { … }` object. A new line is added only when nothing sets the key. Tests cover the none,
  dotted and object shapes, each with zero diagnostics after the write. The edit is built from the
  pipeline's `parsed`. A lint rule (`eslint.config.js`) now forbids importing `parse` in
  `apps/web/src` outside `pipeline.ts`. Selecting an engine resets `engineOptions` to `{}`.
- **No sleeps in e2e** (`Canvas.tsx`, e2e). The canvas stamps `data-theme`/`data-paint-hash` on
  the wrapper from `lastGood`, and theme-switch tests wait for it. There is no `waitForTimeout` in
  `apps/web/e2e/`.
- **Canvas coverage** (new `apps/web/e2e/canvas.spec.ts`): the overlay is a sibling of the export
  and absent from it; hover and click outlines match the node; ctrl+wheel zoom holds the cursor
  point and clamps to exactly `[0.1, 8]`; drag pans; Fit centres at 94 %. Also `viewport.test.ts`'s
  exact-40 % case.
- **Packaging** (`packages/core/package.json`, `apps/web/package.json`, lockfile).
  `@codemirror/language`/`@lezer/highlight` are optional peer dependencies of `@sgl/core` (dev
  dependencies there, regular dependencies of `apps/web`). `pnpm install --frozen-lockfile` is
  clean. A packed `@sgl/core` installed into an empty project pulls in only `@lezer/common` and
  `@lezer/lr`, and its `.` entry imports and parses.
- **Inter's OFL licence** ships as `dist/fonts/OFL.txt` (`apps/web/public/fonts/OFL.txt`), with
  an attribution in `README.md`.
- **Docs**: DD-08 §3/§5/§6/§10/§11/§13/§14, the DD-09 §2 row, `corpus/README.md`, and the
  corrected tsdown description (above and in `tsdown.config.ts`).
- **F9**: the bench's forced-layout variant (item 17) and the human decision (item 18) are in the
  §2.1 row and in Stage L's table. `morphdom` is not implemented. The forced-layout variant runs
  in Chromium only, where the budget is judged: running it in Firefox too slowed neighbouring
  tests enough to fail a clean `pnpm check`.
- **A pre-existing cold-cache failure, fixed test-side.** `pnpm check` from clean failed
  `packages/layout-std/test/browser/grid.browser.test.ts` twice, with `SGL4001`. The first request
  through a real Worker also pays Vite's dependency optimisation, while the Node unit project
  saturates the CPU, and so exceeded `sgl.grid`'s 2 s timeout. The `fd6bbf0` bench fails the same
  way. That test proves bitwise equality, so its host now gets a 30 s grid timeout. After this, two
  consecutive clean `pnpm check` runs were green. Every e2e test passes in each of Chromium,
  Firefox and WebKit (`test:e2e:all-browsers`, 42/42). One earlier all-browser run hit three
  Firefox 30 s timeouts under three-browser parallel load; Firefox alone passed 14/14.

**Stage J is implemented on `feat/app-files`** (branched from `main` at `9645992`; merged at
`0a32679` after the two fix rounds below — this paragraph describes the branch as first submitted). `pnpm check` from clean is green twice in a row: Vitest 1847 passed + 6 skipped
by design (1803 unit, 44 browser; up from 1772), and the e2e suite 34/34 in Chromium. The
all-browser run (`test:e2e:all-browsers`) passes 102/102 across Chromium, Firefox and WebKit. No
golden changed. What landed, by file:

- **The DOM-free state layer** (`apps/web/src/state/`), each piece behind an injected interface and
  Node-tested in `apps/web/test/`: `share.ts` + `base64url.ts` (DD-08 §8: `deflate-raw` +
  base64url, the 2 MB cap that stops *reading* — reader cancelled, input fed in 512-byte slices —
  and every refusal a value), `filename.ts` + `files.ts` (§7: the title chain, sanitising, the
  remembered extension, the 2 MB Open cap checked before reading, what each Save item writes),
  `storage.ts` + `storage-idb.ts` (§9: IndexedDB `sgl` v1 via `idb`, `documents` and `settings`,
  and an in-memory store for tests and as the fallback), `autosave.ts` (500 ms, chained writes,
  quota toast once per run), `boot.ts` (share link → new document; invalid → toast and the last
  document; `lastOpenDocId`; else the example), `document-session.ts` (the whole record follows the
  pipeline) and `toasts.ts`.
- **The DOM around it**: `toolbar/FileMenu.tsx` (Open, `Ctrl/⌘+O`, Save ▾, the Share dialog),
  `panels/Toasts.tsx`, `io/{app-boot,download,pwa,launch-queue}.ts`, `App.tsx`/`main.tsx` (boot from
  storage before the first render), `canvas/Canvas.tsx` (J6's stored-SVG paint, `data-origin`,
  fit on Open), `app.css`.
- **The build**: `vite.config.ts` (`vite-plugin-pwa` `generateSW`; the `_headers` plugin),
  `build/headers.ts` (DD-09 §1.2's CSP and DD-10 §5's `_headers` from one definition, held to both
  documents' text by `test/headers.test.ts`), placeholder icons (`public/icons/`, from
  `scripts/generate-icons.mjs`), the example (`src/examples/checkout.sgl`). New dependencies are the
  two the design names (J3): `idb` (runtime) and `vite-plugin-pwa` (dev; it brings `workbox-build`,
  and the app registers the service worker by hand so `workbox-window` stays out of the bundle).
- **The e2e gate** (`apps/web/e2e/`): `files.spec.ts` (criterion 4, §14 test 5), `share.spec.ts`
  (criterion 6 in a fresh browser context, §14 test 6), `offline.spec.ts` (criterion 5 and §14 test
  7, single-engine), `persistence.spec.ts` (autosave across a reload, the J6 boot paint),
  `pwa.spec.ts` (every emitted file is precached; the manifest), `csp.spec.ts` (the build served
  under its own `_headers`, with no CSP violation). Stage I's specs now wait on the example's
  computed node count; `canvas.spec.ts` opens Stage I's small document through Open first (the
  larger example made WebKit's repaint at 8x zoom slow enough to time its wheel test out once).

**Decisions the brief and the documents left open, all recorded in DD-08 §5/§7–§9/§11/§12/§14**:
the first-run example is an adapted copy of `corpus/checkout.sgl`, because that file pins
`engine: "layered"` (roadmap, unregistered) and would boot every new user into `SGL4011` and a
blank canvas; canonical JSON is refused while the document has a parse/resolve error; an
unaccepted extension is refused like an oversize file; Open replaces the current document's text
(Share, not Open, creates a document); the 8 000-character guard measures the whole link; an invalid
link clears the hash too; `e`/`t` carry the effective engine/theme and fall back to the default
when unknown; only `lastOpenDocId` is written to `settings`.

**Three test-infrastructure findings, fixed at the root rather than retried** (J5's CI-only
`retries: 1` was already in `playwright.config.ts`; it is now commented): (1) every Playwright
context installed the service worker and filled a ~560 KB precache, and with ten parallel Firefox
workers that alone pushed unrelated tests past their timeouts in set-up and teardown — the suite
now blocks service workers except in `offline.spec.ts` and `csp.spec.ts`, and the same Firefox run
is then clean; (2) with that fixed, an all-browser run could still hang several Firefox instances
launching together in context set-up and teardown (`browserContext.close: Test ended`, juggler
errors, test steps already finished), so the Firefox project is capped at four workers; (3)
Playwright's WebKit fails an offline navigation, and blocks routed requests,
before the service worker can answer, so in WebKit criterion 5 takes the network away by stopping a
server of the test's own (`e2e/static-server.ts`). Separately, `playwright.config.ts` no longer
reuses an existing server and takes `SGL_E2E_PORT`: another checkout's `vite preview` was found
listening on a neighbouring port serving a different build, which a reused server would have tested
silently. Two bugs in Stage I's e2e surfaced on the way: DD-08 §14 test 1 typed an edge from an
undeclared node (an error, so the document never rendered) and its "at least 3 nodes" wait was
already satisfied before typing, so the test passed without testing anything; it now adds a real
node and waits for exactly one more.

**Left out**: `elk`, engine switching and F11 (Stage K); PNG (D6), drag-and-drop (F2),
`showSaveFilePicker` (F3), short links (F6), the document drawer (E17), the SVG export-options UI (D10, Stage L);
deploying and `wrangler.toml` (J4). No automated test covers the update chip (it needs two
successive builds) or `launchQueue` (it needs an installed app); both belong to the T5 manual gate.

**Stage J fix round 1** (three reviews, each finding confirmed by the orchestrator; on
`feat/app-files`, not merged). Verified in **Chromium only** — Firefox and WebKit were not available
to this round, so the all-browser figure above predates it. Item by item:

1. **The offline gate is falsifiable.** `offline.spec.ts` empties the HTTP cache before going
   offline (Chromium: CDP `Network.clearBrowserCache`) and requires every response of the offline
   reload to be `fromServiceWorker()`, plus a response for each kind of file the app needs. With
   `globPatterns: ['**/*.html']` it now fails (it passed before). WebKit's own server
   (`static-server.ts`) sends `no-store`; Firefox has neither mechanism and stays unfalsifiable.
2. **Edits in the last 500 ms before leaving the page were lost** (every time). The `pagehide`
   flush did issue the IndexedDB `put`, but the transaction was left to auto-commit, which needs a
   later task that Chromium never runs for a page being unloaded; it aborted instead.
   `storage-idb.ts` now calls `IDBTransaction.commit()` after each `put`, and `autosave.flush()`
   issues its write synchronously rather than behind a write in flight (IndexedDB keeps issue
   order). e2e and unit tests; a no-op flush fails both.
3. **Criterion 6's theme half**: `t=` is pinned exactly, and a source with no `@theme` must render
   the link's theme in a fresh (light-default) context.
4. **Criterion 6 outside the app**: the produced link is decoded with Node's `inflateRawSync`, and a
   link built with `deflateRawSync` opens with exactly its source.
5. **The 512-byte inflate slice** is held by a test that records every write to the decompressor
   (fails with the slice at `1 << 30`; the older 64 MB bomb test did not).
6. **The 2 MB share cap** is pinned (`SHARE_INFLATED_CAP === 2 * 1024 * 1024`) and exercised at
   exactly 2 MB and 2 MB + 1 with the default cap.
7. **Criterion 4's JSON oracle** is a checked-in file (`e2e/fixtures/json-form-edited.expected.sgl.json`),
   not `toJson`; Open's 2 MB boundary is tested both sides.
8. **Boot never rejects**: ids fall back from `crypto.randomUUID` (absent on insecure origins) to
   `getRandomValues`, then to time + counter; any boot failure opens the example in memory with a
   toast, in `bootApp` and again in `main.tsx`'s new `catch` (before: a blank page).
9. **Share dialog focus**: focus moves to the link on open; Escape works at once; Escape/Close
   return focus to Share.
10. **Save ▾** is a plain disclosure (no `menu`/`menuitem` roles) that closes on Escape and outside
    click; the `▾`/`⟳` glyphs are `aria-hidden`; error toasts are `role="alert"` and stay until
    closed.
11. **Share where `CompressionStream` is missing** toasts instead of failing silently
    (`encodeShareFragment` returns a value).
12. **File names**: the reserved-device check uses the stem before the first dot and knows
    `CONIN$`/`CONOUT$`/`COM¹²³`/`LPT¹²³`; the cap counts code points; bidi and zero-width
    characters are stripped.
13. **An Open read before the editor exists** is held and applied when it arrives
    (`state/open-queue.ts`); a fake-`launchQueue` e2e now covers that path in-page (it also passed
    before — today's timing never drops it — so this one is defensive).
14. **A share link pasted into an open tab** (`hashchange`) is imported: invalid → toast, stay;
    valid → flush autosave, then reload so boot imports it exactly as on load.
15. **Service-worker updates**: `registration.update()` when the page becomes visible, at most
    hourly.
16. **CI**: `retries: 1` stays, with `failOnFlakyTests: true`, so a retry cannot hide a race.
17. DD-08 §7–§9, §11, §12, §14 and this section updated to match; D10 added to Stage L.

After the round, `pnpm check`-equivalent from clean is green twice: Vitest 1866 passed (the unit and `browser (chromium)` projects), e2e
45/45 in Chromium.

**Stage J fix round 2** (the last round; on `feat/app-files`, merged with it; Chromium only). Item by
item:

- **R1: autosave ordering.** Round 1's synchronous flush could be overtaken. With write A in flight,
  a timer write B queued behind it was issued *after* a flush's newer C, and overwrote it. Each
  record is now numbered when it leaves `pending`, and a queued write older than one already
  issued is skipped (`autosave.ts`; unit test failed first with `['A','C','B']`).
- **R2: Open creates a new local document** (human decision, 2026-09-23, on held item H). One
  path for the toolbar, `Ctrl/⌘+O` and the launch queue. It flushes the open document, stores a
  new record (new id, the opened text, the remembered extension, the current engine and theme),
  sets `lastOpenDocId`, and loads it with an empty undo history (undo never crosses documents).
  The previous record is left byte-identical. Toast: "Opened {filename} as a new document. Your
  previous document is in Documents." (`state/documents.ts`, `DocumentSession.switchTo`,
  `editor/extensions.ts`'s `loadDocument`.)
- **R3: Documents ▾**, the minimal slice of E17 (same decision). At DD-08 §2's `[≡ docs]`, the
  Save ▾ disclosure pattern (now `toolbar/disclosure.ts`): every stored document by title and
  updated time, most recent first, the open one marked. Picking one flushes, switches, sets
  `lastOpenDocId`, paints the stored picture and fits. "New document" is empty. The share-import
  toast names Documents. Delete, rename, search and tabs stay E17 (Stage L).
- **R4:** DD-09 §1.1's first threat row now names the one other thing `innerHTML` may take: the
  renderer's own earlier output for the same document, read back from this origin's IndexedDB
  (the J6 boot paint). This is its only DD-09 edit (human-approved).
- **R5:** this paragraph, the Stage J row, and the E17 row in Stage L.

After round 2, the clean `pnpm check`-equivalent run is green twice: Vitest 1881 passed (unit and `browser (chromium)`), e2e
50/50 in Chromium.

**Stage K is implemented on `feat/layout-elk`** (branched from `main` at `35ab6bb`; merged at
`0e9ecfc` after the fix round below — this paragraph describes the branch as first submitted). The brief's gate command, run from clean twice, is green both times: Vitest
2040 passed (the `unit` and `browser (chromium)` projects), e2e 51/51 in Chromium, `pnpm size`
174.63 kB of 180 kB. **Chromium only**: Firefox and WebKit could not be fetched in this sandbox.
The harness refused the command as one shell line, so its steps were run in the same order as
three consecutive commands, each stopping on the first failure. No existing golden changed. What
landed, by decision:

- **The adapter (DD-06 §6).** `packages/layout-elk/src/`: `descriptor.ts` (the engine's id,
  capabilities, schemas and option defaults as their own entry, `@sgl/layout-elk/descriptor`, so
  the main thread lists the engine and builds its form without elkjs), `mapping.ts` (§6.1/§6.2
  as pure functions), `load-elk.ts` and `index.ts`. Running elkjs 0.11.1 showed nine places
  where §6.1/§6.2's pseudocode is wrong or silent (empty label text is ignored; `H_LEFT` titles
  reserve a left column, so titles are centred; ELK adds the title band itself; label padding is
  read from the parent; spacing is per level; `nodeSize.minimum` is not transposed for DOWN/UP;
  `portSize` is unseen; edges are relative to ELK's `container`; label boxes for asymmetric
  insets), all written up in DD-06 §6.1/§6.2.
- **K1, lazy.** `elk.bundled.js` is a dynamic `import()` on the first `layout()`, the instance
  cached. The app's build emits it as its own `elk` chunk (1 439.76 kB raw, ≈ 436.5 kB gzip),
  imported only by the worker, and precached. That needed `worker.format: 'es'` and an `elk`
  manual chunk holding elkjs only (DD-10 §2).
- **K11, a scoped `document` stub (orchestrator decision on a blocker Stage K reported).**
  Inside a worker, `elk.bundled.js` (line 6430) takes its own worker branch — installs itself as
  `self.onmessage`, never exports its in-thread FakeWorker — so `new ELK()` failed. `load-elk.ts`
  sets `globalThis.document = {}` only when absent, only for the import, and deletes it in a
  `finally`. The wip commit `7e5aed5` reproduces the failure; `344620e` fixes it; the Chromium
  worker test has no shim of its own and is the tripwire.
- **Host (DD-06 §4).** `applyHostFallbacks` is now the one post-engine sequence, shared by the
  worker runtime and the conformance harness; it adds `finishEngineRoutes` (§4.4's arrow reserve
  on routes an engine returned; §4.5's teardrop for an engine self-loop under 16 px, whose label
  and `bounds` follow it). It runs before `routeStraight`, so nothing is reserved twice (tested
  alone and through the real worker runtime). `grid` returns no edges, so its output is unchanged.
- **K2.** `elk.randomSeed: '1'`. Two runs are identical after quantization in Node (conformance
  check 2, every corpus document) and through a real Chromium worker; ELK's quantized output in
  Chromium equals Node's golden byte for byte.
- **K3.** New goldens only: the `ElkNode` sent and the engine's `LayoutResult`, for each
  `CLEAN_DOCS` document, under `packages/layout-elk/test/__goldens__/`.
- **K4.** `hierarchyCrossings` counts route segments through an unrelated container's frame, as
  a logged warning: **0 on every corpus document**, and 0 for `containers-edges.sgl` under both
  `ORTHOGONAL` and `POLYLINE`. Found by inspection instead: an edge entering a container from
  above can cross its centred title (`checkout.sgl`), recorded in DD-06 §6.3 for review.
- **K5.** Labels come from ELK: the output-mapping unit test places each label at ELK's own
  coordinates; through the real worker runtime (Node) and a real Chromium worker the posted
  labels equal ELK's, and a centred container title differs from what `placeLabels` would place.
- **K6.** `.size-limit.js` + root `pnpm size` + a CI step: the entry, its static imports, the
  CSS and the worker, gzipped, elk excluded — **174.63 kB**, limit 180 kB.
- **K7/K8, T4.** `criteria.spec.ts` criterion 1 on both engines (`forty-three-level.sgl`: ids,
  edge ids, label texts and paint hash identical, layout geometry hash different); DD-08 §14
  test 4 (`dd08-14.spec.ts`); criterion 5 offline (`offline.spec.ts`: the elk chunk is served by
  the service worker after the HTTP cache is emptied; elk → grid → elk offline, no failed
  request); `pwa.spec.ts` checks elk is precached and imported only by the worker.
- **K9, F11.** `state/engine-options.ts` (Node-tested) and `toolbar/EngineOptions.tsx`: one
  hand-built form per engine beside Engine ▾, a plain disclosure (Save ▾'s pattern), writing the
  persisted `engineOptions`; selecting an engine resets it to that engine's defaults.
- **Default engine.** `sgl.elk` (ADR-0005), ending I1's interim `grid` default; stored
  documents keep their own `engineId`.
- **Conformance (DD-06 §8).** `@sgl/layout-api/conformance` (`runConformance`), run on both
  engines over every corpus document plus a 1 000-node graph built in memory
  (`bench/scale-document.js`, shared with `bench/generate.js`). **K10**: elk's 1 000-node graph
  takes ≈ 0.8 s in Node and ≈ 1.1 s round trip in a Chromium worker run alone (≈ 2.3 s inside
  the full parallel test run), against its 10 s timeout, which is not raised.

**Stage K fix round 1** (22 review items plus item 23, SGL4010, from the human decision of
2026-09-23 on held item H1; on `feat/layout-elk`, not merged). H2 (DD-06 §5's bounds
recomputation) and H3 (an elk performance budget) stay held. Chromium only. The brief's gate
command, run from clean twice, is green both times: Vitest 2139 passed (the `unit` and
`browser (chromium)` projects), e2e 55/55, `pnpm size` 177.22 kB of 180 kB, with the new
boot-path check passing. The first attempt at the first run failed one test on a Vitest timeout
(`n2000.sgl` under elk at 5.5 s against the 5 s default under the full parallel run); that
test now has 30 s. Item by item:

- **1. Container titles are top-left again** (DD-06 §4.1/§6.1): `start`/`top`, at ELK's
  container frame inset by `contentInset`, as `grid` places them — pinned per `CLEAN_DOCS`
  document. The reviewer's `[H_LEFT, V_TOP, INSIDE, V_PRIORITY]` works only because
  `V_PRIORITY` is not an ELK placement and ELK rejects the whole value; the title is instead
  not sent to ELK at all (byte-identical layouts, pinned), with `elk.padding.top` covering the
  band once and the title's width a minimum container width. Elk goldens regenerated (12
  files: titles `middle`/`bottom` → `start`/`top`); no other golden changed.
- **2. Edges through a title**, counted by `titleCrossings`. Centred titles (before item 1):
  `checkout` 2, `containers-edges` 1, `forty-three-level` 1, `nesting-3` 2, `wildcards` 1,
  `n50` 4, `n500` 49, `n2000` 199. Top-left titles (after): `checkout` 2, `containers-edges` 1,
  `nesting-3` 1, `wildcards` 4. No ELK mitigation removed the rest (`considerModelOrder` makes
  ELK throw on 8 documents; `mergeHierarchyEdges` and `spacing.labelNode` change nothing;
  `FIXED_SIDE` on containers moves them), so they are a pinned, counted warning.
- **3.** The pipeline sends `optionsForEngine(engine, bag)`, what the form shows; a stored
  `columns: "x"` no longer reaches grid raw (it threw `SGL4011`). Unit and e2e tests.
- **4.** `portConstraints` is ELK's enum in `hintsSchema` and the mapping; unknown values
  skipped. **5.** A missing ELK coordinate is `NaN` (→ `SGL4002`), never 0.
  **6.** The arrow reserve on an engine route is clamped: never reverses or zeroes a short end
  segment. **7.** `elkEngine.layout()` honours an abort once elkjs has loaded, so the worker
  and its loaded elkjs survive; DD-06 §3's "respawn ~30 ms" premise amended. **8.** The
  redundant deep copy is gone (the graph is built per call; nothing re-reads it).
  **9.** DD-06 §6.2 (every section is concatenated), §8 (check 1 fails on errors only),
  DD-08 §10 (item 3's sentence).
- **10.** The K4 tests assert: hierarchy crossings equal the recorded `{}`,
  `containers-edges.sgl` is `{ORTHOGONAL: 0, POLYLINE: 0}`, title counts pinned; new corpus
  document `nested-crossing.sgl` puts an edge in a non-root ELK `container`.
- **11.** Conformance check 6: every edge end within `arrowSize` of its node (or port) — grid
  and elk pass. **12.** Per directed edge, the end sits `arrowSize` ± 0.5 px off its node,
  failing with the reserve skipped and with it doubled. **18.** Check 3 compares all siblings,
  containers included. **16.** A non-root-container edge label is placed absolutely.
  **19.** The Chromium worker has no `document` after elk loads.
- **13.** F11 end to end (`e2e/engine-options.spec.ts`): Direction → Right re-lays out,
  persists across a reload, and an engine switch resets it; fails with the form's write made
  inert. **14.** Criterion 1 also compares the rendered paint (`<style>` plus every element's
  `class`/`fill`/`stroke`/`stroke-dasharray`). **15.** Criterion 6 with `e=sgl.grid`: grid on
  the picker, in the record, and geometry different from elk's; boot unit test.
- **17.** `pnpm size` also runs `apps/web/scripts/check-core-chunks.mjs`: no chunk reachable
  from `index.html`'s entry by static imports may reference an `elk` chunk or contain elkjs,
  and elkjs is emitted once. Importing `@sgl/layout-elk` into `App.tsx` passed size-limit
  (178.71 kB) and failed this check.
- **20.** `size-limit` + `@size-limit/file` pinned to **12.1.0** (engines `^20 || ^22 || >=24`),
  the newest that runs on CI's Node: run under Node 20.19.0 itself (`npx -y node@20.19.0`) it
  passes; 14.0.0 there fails with "does not provide an export named 'glob'".
  **21.** Root `check` runs `pnpm size` after `build`.
- **22.** F11 number fields have maxima (spacing 0–500 px, grid gap 0–200 px, columns 1–50); a
  refused value gets `aria-invalid`, a visible message, and the box shows the value in use.
- **23. SGL4010 is live** (human decision 2026-09-23). `layoutConfigDiagnostics` in
  `@sgl/layout-api` warns, at the key, for (a) a container-level `@layout.engine` naming
  another engine — **until B8/B9 (per-container engines), a nested engine warns and is
  ignored** — and (b) any `@layout` key the effective engine declares neither as an option nor
  as a hint. The app's pipeline runs it with the effective engine's descriptor; the panel shows
  it with a warning squiggle and the diagram stays. Corpus fixtures `layout/nested-engine.sgl`
  and `layout/unknown-key.sgl`; SGL4010 moves to the whole-pipeline coverage half. The welcome
  example drops `payments`' nested `@layout`, so a first visit shows no warning. One test table
  (not a golden) changed: corpus `checkout.sgl`'s audited diagnostics gain SGL4010 (its root
  `direction` under grid).

**F9 phase 2a** (Stage L, `feat/f9-live-view`, branched from `main` at `c11a5ad`; no golden
changed). Phase 1 measured prototypes only; its findings are in §2.1 F9, and its bench and forks
stay in the branch history at `a074df2`. This change: (1) **an end-to-end theme-switch bench**,
`pnpm bench:theme` (§1 Verification): `apps/web/bench/theme-switch.bench.ts` mounts the real
`createPipeline` (real `CanvasMeasurer` and Inter faces), the real `Editor` (CodeMirror) and the
real `Canvas` in Chromium, and times a Theme ▾ pick exactly as `ThemePicker` makes it:
`selectTheme` (the `themeId` write) then `dispatchTextChange` (the `@theme` edit, which the
editor's `updateListener` hands to `pipeline.setDocument`), until `getBBox()` after the last swap,
plus the pre-measure the pick triggers. A pick is two paints when the document has no `@theme` yet
(`first`), one once it has (`repeat`: the document's `@theme` overrides `themeId`); both are
measured, and each run proves the last synchronous swap was the last paint (idle wait, then no
further swap and no layout request). The breakdown comes from `vi.mock` wrappers around the stage
functions, a wrapper on `pipeline.setDocument` and a timed `innerHTML` setter on the canvas's
wrapper element, so nothing is instrumented in production code; the layout worker runs in the page
(`vi.mock` breaks a real `Worker`'s module graph). It is a `bench` Vitest project (Chromium only),
not part of `pnpm test`/`test:watch`, which now name `unit` and `browser`. Each point's gate
asserts the budget, or, for the points in `KNOWN_MISSES` (n50, n500, n2000), that the miss
persists; a failed measurement fails it. (2) **`ClassTable`/`MarkerTable` name each distinct style
and marker once per render** (`packages/render-svg/src/style.ts`, `markers.ts`), caching pure
functions of their keys; `test/naming-memo.test.ts` holds the whole corpus under both themes, and a
cross product of every arrowhead × size × colour × end, to the uncached naming rule. (3)
**`fnv1a64` in 16-bit limbs** instead of `BigInt` (`packages/core/src/hash.ts`), with a fast-check
property test against the `BigInt` reference kept in `test/hash.test.ts`. (4) `morphdom` removed.
**Numbers.** The first version of the bench timed only the `themeId` write; on that path (2) and
(3) took median `work` from n50 12.7 / n500 106 / n2000 417 ms to 7.2 / 50 / 205. On the picker's
real path (fix round 1, 21 runs after 3 warmups, with (2) and (3)): **n50 18.6 / 11.2, n500
114.5 / 63.8, n2000 454.2 / 250.6 ms** (first / repeat pick). n2000 repeat: `buildAst` 7.8,
`resolve` 2.9, `compile` 20.9, `styleGraph` 48.3, `render` 46.5, the `innerHTML` swap 41.0,
CodeMirror 1.9, effects 2.6, style + layout 64.1, pre-measure 12.6. n2000 first adds the `themeId`
write's own paint (134.0: `styleGraph` 43.8, `render` 45.0, swap 40.4) and 64.4 ms of CodeMirror
for inserting the `@theme` entry. DD-08 §6 and DD-09 §2's planned response now point at F9 instead
of `morphdom`.

**F19 fixed** (Stage L, `fix/large-doc-parse`, branched from `main` at `ce0589d`; no golden
changed). The editor's `updateListener` handed the pipeline `syntaxTree(state)`, which after a
whole-document replacement, or soon after boot, covers only what CodeMirror's incremental parse
had reached (about 20 ms of work or the viewport; its background worker, which finishes later,
changes no text and stops 100 000 characters past the viewport). Reproduced through the UI first
(`apps/web/e2e/large-document.spec.ts`, which failed on `ce0589d` with `SGL1001` and the chip on
"Showing last good render"): Open of a 2 000-node file, a Documents ▾ switch back to one, and an
edit at the top of a 3 000-node document just after it boots. A share link of the largest scale
document within the 8 000-character guard (800 nodes) already rendered whole, because a share link
always boots (F13) and boot parses in `createPipeline`, not in the editor; the test stays as a
guard. The fix: the listener passes `completeSyntaxTree(state)` (`apps/web/src/editor/complete-tree.ts`),
CodeMirror's own `ensureSyntaxTree` to the end of the document with no time limit — an `isDone`
check when the tree is already whole (0.01 ms on a keystroke), the rest of the same parse
otherwise (in Node, about 20 ms more for a replaced n2000, 40 ms for n3000). Synchronous rather
than deferred, because the pipeline's own synchronous work on the same text is larger. And the
pipeline's `parsed` stage now refuses a tree whose length differs from its text as a §13
programming error (holds last good, crash chip), so a truncated parse can never be rendered or
diagnosed. DD-08 §4 says how the tree is kept whole. Unit tests: `apps/web/test/complete-tree.test.ts`
and a `pipeline.test.ts` case. `pnpm bench:theme` before / after (median `work`, ms): n50 17.5 /
18.7 first, 11.0 / 10.4 repeat; n500 117.4 / 113.5, 63.3 / 63.9; n2000 451.6 / 453.5, 250.4 /
244.6 — noise.

**The golden re-baseline** (Stage L, `feat/rebaseline`, branched from `main` at `3c8321a`; F7,
F14 and F18, human decisions 2026-09-23/24). The one deliberate re-baseline of every layout and SVG
golden, in three commits, each regenerated with the repo's own `vitest -u` and each golden diff
proved attributable to that change alone by a script. **R3 (F18):** the vestigial token `<style>`
element and `RenderResult.tokenBlock` are removed (every new SVG golden is exactly the old one
minus that element); F17's guarantee stays tested over the corpus: one `<style>`, no custom
property in it or anywhere else. **R2 (F14):** `quantize` (`layout-api`, the host's last step
under every engine) discards an engine's `bounds` and recomputes them (DD-06 §5, new `bounds.ts`):
the extent of every frame, port, rotated label frame and route (curves by their extrema), plus 16 px
on every side rounded outward to the 1/64 grid, then translates every coordinate so `bounds` starts
at the origin (the app's overlay and hit-testing assume it, so `apps/web` is unchanged). `grid`'s
self-loop teardrops are no longer clipped (they reached y = -25 on `parallel-selfloop.sgl`), and
`elk`'s margin is 16 px, not ELK's 12. Every elk result, grid and SVG golden changed except
`empty.sgl`; each is the old one translated by one (dx, dy) with new bounds (the SVG header and
canvas rect). **R1 (F7):** paint classes `s-`/`t-`/`p-` are named after the element's cascade
signature (role, shape, classes, inline `@style`: DD-04 §4 steps 1–5, pinned in DD-04 and
DD-07 §6), never a resolved value; marker ids are `m-{kind}[-s]-{size}-{edge signature token}`
and a marker's colour is a `<style>` rule on its own shape (`mf-`/`ms-`), checked in Chromium,
Inkscape 1.2.2 and resvg in both themes. Structure no longer depends on paint: an empty paint
class stays on the element, a `labelPlate: none` plate stays as `fill:none`, and the arrowhead
kind (which names the marker; `none` drops the attribute) is the one exception, covered by the new
`RenderResult.structureHash` (also `structureHash(styled)`, no render needed; widened by fix
round 1, below). The goldens' paint is byte-for-byte unchanged: only class names, marker ids and
the `<style>`/`<defs>` text moved. New tests: `render-svg/test/paint-only.test.ts` (light ↔ dark
changes only `<style>`/`<defs>` text, whole corpus), `bounds.test.ts` (both engines, sampled curves,
the self-loop case), `browser/markers.browser.test.ts`, and the marker cross product carried to the
new key in `naming-memo.test.ts`. `pnpm bench:theme`, `main` / this branch, same machine (median
`work`, ms, first / repeat pick): n50 23.9 / 22.8, 12.7 / 13.0; n500 146.5 / 145.4, 85.1 / 85.9;
n2000 601.7 / 601.9, 322.9 / 326.4 — noise, as expected until the canvas swaps only the `<style>`
text (F9 C). F7 and F14 are cleared from §2.1.

**Re-baseline fix round 1** (`feat/rebaseline`, two reviews; no golden changed). **Item 1:**
`@size` painted — DD-04 §4 step 6 applied any key, so `@size.fill` coloured an element whose paint
class, named after a signature that rightly omits `@size`, it shared with an unstyled sibling, which
turned red too. Step 6 now applies only `SIZE_KEYS` (`@sgl/core`: width, height, minWidth,
minHeight, maxWidth, aspectRatio — the spec row gained `minHeight`, which the registry, DD-04 and
`buildLayoutInput` already treated as a size key), and the resolver warns `SGL2010` for any other
`@size` key; no corpus document uses `@size`. **Items 2–3:** `render-svg/test/oracle.test.ts`
checks every rendered element's own paint rule against its own `ComputedStyle` (and every marker
colour against its edge), over the corpus under both themes and a synthetic document under a
synthetic role-, shape- and class-specific theme pair (`test/fixtures/synthetic.ts`); it kills a
dropped shape, dropped classes (edge, title, plate) and a dropped inline style at the signature call
sites. **Item 4:** `structureHash` now also covers each element's id, signature, label text,
rendered config and edge endpoints, so an inline `@style` edit (same `geometryHash`, new class
names) changes it and it can guard a swap on its own for the same layout; a two-lane 32-bit hash
keeps it at ~2.2 ms at n2000 in Node (fnv1a64 over the same fields: 7.6 ms). **Item 5:**
`layout-elk`/`layout-std` `bounds.test.ts` run `runHostSequence` over the corpus: bounds at the
origin, 16 px of margin on every side. **Items 6–7, 9:** literal margins in tests; `Q`, port and
`contentFrame` extents tested; K5 compares the real host result too, translation undone.
**Item 8:** `canonicalise` sorts nested keys (flat bags unchanged), with a fast-check property test
of the signature. **Item 10:** documented in DD-06 §5 rather than measured — ink (strokes,
arrowheads) relies on the margin, which holds for `strokeWidth ≤ 32`, `arrowSize ≤ 42` (`≤ 34` for
`open`); measuring it would move every golden, and the theme warning needs a new diagnostic code,
left for a catalogue decision. `pnpm bench:theme` (median `work`, ms, first / repeat): n50 21.5 /
14.0, n500 145.8 / 82.1, n2000 614.6 / 336.6 — within this machine's noise of the re-baseline's
numbers above.

**The theme fast path** (Stage L, `feat/theme-fast-path`, branched from `main` at `681729f`; no
golden changed; F9's budget met on a quiet machine, marginally at n2000: §2.1 **F9** stays open,
to watch). **P1 (human decision, 2026-09-24):** Theme ▾ is a view preference —
`selectTheme(pipeline, id, dispatch)` always sets `themeId` (the record persists it, a share link's
`t=` carries it), and when the document already sets `@theme` it also edits that entry in place
(never an insertion), which then overrides `themeId` (DD-08 §10).
**P2:** the `themeId` write and the dispatch are one `@preact/signals` `batch()` (effects wait for the
batch's end, computeds are lazy), so a pick is one paint: a non-string `@theme`, where both halves
repaint, painted twice before. **P3:** `styleGraph` resolves each distinct cascade signature once
(reusing the style for every `@size`-free element that shares it; a signature that reported a
diagnostic is never reused), keeps the signatures per graph object, reuses the graph `geometryHash`
when every element's is unchanged, and takes `paintHash` on first read; `main`'s own `cascade.ts`,
kept (trimmed) as a test fixture, is the reference, compared as JSON over the corpus, the synthetic
pair, 150 random documents and repeated restyles (DD-04 §5). `cascadeSignature` moved to `@sgl/theme` (render-svg re-exports it).
`render()` returns a `PaintPlan`; `renderPaintOnly(previous, styled, layout)` rebuilds only the
`<style>` text, one style per paint rule, and refuses unless the layout is the same object and
`structureHash` is equal; `structureHash`'s graph part is kept per graph (DD-07 §6). The pipeline
takes that path when the graph object, the layout object and `geometryHash` are unchanged, skips the
pre-measure then (same labels, same geometry); the canvas swaps the `<style>` text when the tree on screen has the render's plan (`showLastGood`) and
stamps `data-paint-hash` after the frame (DD-08 §3, §6). **P4:** `lastGood.svg` and the record's
`lastGoodSvg` are getters, derived by `withStyleBlock` on first read (autosave's write, Save ▾ SVG),
never on the switch's path. Tests: `picker-actions`, `theme-picker`, `theme-fast-path`,
`document-session` (apps/web), `memo` (theme; a refactor guard, green before and after),
`paint-only-path` (render-svg) — every behaviour change's test was seen failing first — and the oracle `apps/web/test/paint-swap.browser.test.ts` (now in the
browser project): after the swap the live DOM serialises exactly as a full render's, whole corpus
both ways plus the synthetic pair. e2e: criterion 2 now expects "Theme", an untouched source and a
change in the `<style>` text alone besides the same geometry; share criterion 6 starts from a
document with `@theme`; new `theme-picker.spec.ts` (a reload's fresh render equals the swapped DOM).
**The core bundle is now 179.99 kB of the 180 kB limit** (`pnpm size`; `main`: 178.86 kB): the fast
path's first version was 180.72 kB, and it was trimmed to fit, not the limit raised (the reference
styleGraph moved to a test fixture, `PaintPlan` became a plain object built on `ClassTable`, and
`diags` identity was left as it was). The next feature on the boot path needs room found first.
`pnpm bench:theme` now times two cases (execution plan §1) and gates the no-`@theme` one;
`KNOWN_MISSES` is empty. Median `work`, ms, first / repeat pick, same machine as the re-baseline's
numbers above (before: `main`'s bench, one case, 23.4 / 14.1, 144.7 / 82.1, 589.3 / 323.7):

| | n50 | n500 | n2000 |
|---|---|---|---|
| no `@theme` (gated) | 2.5 / 2.6 | 13.0 / 12.7 | 42.7 / 44.5 |
| `@theme` (not gated) | 13.0 / 11.9 | 64.4 / 67.9 | 249.6 / 262.8 |

n2000 without `@theme` (first / repeat): script 3.8 / 2.9 ms (`styleGraph` 2.2 / 1.4,
`renderPaintOnly` 0.6, `resolveTheme` 0.1, the swap 0.1, effects 0.8 / 0.7) and Chromium's style
recalculation 38.8 / 41.5 ms, the floor (replacing a single
rule's text costs ~24 ms at that size; replacing the `<style>` element instead of its text measured
the same); run-to-run the slower pick's median ranged 44–52 ms while this was built, so the headroom
is real but thin. With `@theme` (the document's own text changes, a known cost, not optimised here):
CodeMirror 2.9, `buildAst` 9.2, `resolve` 3.9, `compile` 26.2, `styleGraph` 6.4, `render` 51.4, the
`innerHTML` swap 51.3, style + layout 78.6 and the pre-measure 14.5 ms at n2000 (first pick).

**Theme fast path, fix round 1** (`feat/theme-fast-path`, two reviews; no golden changed).
**Item 1, a blocker already on `main`:** editing a label's text never laid out again — the layout
skip compared `geometryHash`, the engine and its options, and a label's measured size is in none
of them (`a: "short"` → a long label kept its 72 px box around ~260 px of text, on screen, in
Save ▾ SVG and in storage). The skip now compares what `host.run` is handed: the engine, its
options, the `LayoutInput` (as JSON) and the measure table's keys; source spans are compared only
when the landed layout reported diagnostics (they place nothing; they only locate diagnostics), so
a blank line or a `@theme` value of another length does not lay out again, while an inline
`@style` edit does (it is in the graph the engine gets). The key is not even built for the same
graph, table and `geometryHash` (a theme switch). A skip also aborts a request still in flight.
The paint-only path's "same layout object" now means the frames of the last full render, and a
new layout always comes after a text edit (DD-08 §3). **Bundle:** that fix took the core to 180.11
kB; `state/share.ts` + `base64url.ts` became a lazy chunk (boot loads it only for a link with a
payload; Share and a pasted link when used), excluded by name in `.size-limit.js` like `elk`, and
the core is **179.68 kB**; `e2e/offline.spec.ts` proves Share and opening a link work offline from
the precache alone. **Item 2:** tests that kill the surviving mutants — a different plan on screen
never gets a style swap, the wrapper's `data-theme`/`data-origin`/`data-paint-hash` after a swap
and the J6 path resetting the canvas's on-screen plan (`canvas.browser.test.ts`, the real `Canvas`),
a document switch with A's paint-only record queued keeping A's picture, and a text edit with the
same `geometryHash` still pre-measuring. **Items 3, 5:** the bench's three-sample gate with a hard
ceiling (§1) and a computed-`fill` check on every run. **Items 4, 6–9:** §2.1 F9 reopened as a
watch item; P1's wording (the picker always sets `themeId`); the redundant `geometryHash` guard
commented as an early exit; the cascade reference fixture trimmed, with a keep-in-step header;
a DD-04 code fence.

**F21, criterion 1's flaky e2e: a host bug, not a slow page** (`fix/criterion1-flake`; no golden
changed). The failing wait was the first one (`criteria.spec.ts:113`, the 40-node document under
`elk` right after `setSource`), not the switch. Instrumented (`[F21]` console lines from
`host.ts`, removed again), 15 × 4-worker repeats: all 5 failures ran the same sequence. The boot's
example layout (request 0, `elk`) is still running when the test's `setSource` lands; the edit's
request 1 supersedes it, so the host posts `'abort'` for 0 and `'layout'` for 1 **to the same
worker** and starts the 250 ms escalation. Under load the worker is still importing elkjs or
inside ELK's synchronous run, so 0 goes unanswered, the escalation terminates and respawns the
worker, and `respawn()` never re-posted request 1: nothing ran it, its 10 s timer resolved it as
SGL4001 with no layout, and a 30 s wait showed the canvas never updating (the example stayed on
screen). Every pass had either no abort in flight or an answer in 102–220 ms, and landed
322–863 ms after `setSource`, so the 5 s wait had ~6× headroom and "the page is just slow" is
refuted. It predates F9 because the race is Stage H's host plus Stage K's first `elk` load; one
worker passed because the import and the example's layout finished inside 250 ms. **Fix:**
`respawn()` re-posts the current request's `'layout'` message to the new worker (DD-06 §3 step 5);
it keeps its original timer, and a timeout's respawn has already taken the request, so nothing is
re-posted after one. `host.test.ts` pins it (failing before the fix): the re-post after an
escalation, its unchanged deadline, and no re-post when nothing is current. With the fix the same
instrumentation showed 12 of 15 runs escalating and every one landing, 913–1450 ms after
`setSource` (the new worker imports elkjs again); uninstrumented, the 4-worker repeat passed 45/45
twice. No test timeout was raised and no retry added. **What users saw before:** any edit made
while a first `elk` load or an `elk` run longer than 250 ms was in flight (the norm at a few
hundred nodes, F15) could leave the old diagram up for 10 s and then report a timeout for an
engine that never ran. **Still true, recorded not fixed:** every such edit costs a respawn and
another elkjs import (hundreds of ms) before its layout, because ELK cannot be interrupted; the
"laying out…" chip covers the wait.

**C5: the `high-contrast` and `print` themes** (Stage L, `feat/themes-c5`, branched from `main` at
`270f257`; not merged; no existing golden changed). Two built-in themes in `packages/theme/src/themes/`,
each `extends: neutral-light` with no `rules`, `byShape` or `byClass`, so every corpus document has
`neutral-light`'s `geometryHash` (checked per element) and a switch between any two of the four
themes is F9's paint-only `<style>` swap. **`high-contrast`** is black on white: `ink`/`line`
`#000000`, `ink.muted` `#2E2E2E`, containers `#EBEBEB`, `accent` `#0033B8`, `danger` `#990000`,
each accent AAA as text. `render-svg/test/themes-c5.test.ts` reads the rendered `<style>` of the
whole corpus and checks every pair made of theme colours: titles on their fill, edge labels on
their plate, strokes and arrowheads on the canvas and each container fill, strokes on their own
fill — text ≥ 7:1, non-text ≥ 3:1; worst pairs `#2E2E2E` on `#EBEBEB` 11.39:1 (text) and
`#990000` on `#EBEBEB` 7.48:1 (stroke). **`print`** needed more than tokens: the corpus paints literal
colours (`classes.sgl`'s `#123456`, `checkout.sgl`'s `$hot`) that no token reaches, and DD-04 said
print sets *every* fill and stroke. **Deviation, recorded in DD-04 §3/§4:** a theme may carry
`force`, a paint-only `StyleSet` applied after every cascade step (step 7), the document's included;
a geometry key in it is `SGL5003` and dropped, so metrics never depend on it. It is a theme input,
not an element one, so `cascadeSignature`, paint class names and `structureHash` are unchanged; the
cascade reference fixture is kept in step. `print`'s force: fill and plate white, stroke and text
black, shadow none; dashes, arrowhead kinds and widths stay. The same test checks the rendered corpus
for no fill but white or none and no stroke or text but black. **App:** no source change — Theme ▾,
`t=` and a stored `themeId` all read `BUILT_IN`. **Bundle:** 178.63 → **178.87 kB** (+0.24 kB,
1.13 kB under the limit), above the ~0.5 kB floor set for this item, so the themes stay in the core
bundle rather than a lazy chunk, and a stored or shared document in either paints on its first render
with nothing to await. Tests: `theme/test/builtin-c5.test.ts`, `render-svg/test/themes-c5.test.ts`,
the F7 contract (`paint-only.test.ts`) over all six theme pairs, the paint oracle and memo test under
all four themes, `theme-fast-path` over every ordered pair, the `paint-swap` DOM oracle
(light → high-contrast, high-contrast → print), `pickers`; new render goldens under
`__goldens__/render/high-contrast/` and `print/`. e2e: `themes-c5.spec.ts` (the four options; each pick
changes only the `<style>` text, source and layout geometry untouched; print's computed paint; a stored
record and a `t=print` link boot in the theme; a document's own `@theme` edited in place) and an
offline case in `offline.spec.ts` (a document stored in `print` boots offline in it and switches to
`high-contrast`, every response from the service worker). `pwa.spec.ts` now matches the service
worker's `SKIP_WAITING` handler by pattern: terser names its parameter by character frequency over the
whole `sw.js`, asset hashes included, and this build named it `s`, not `e`. Docs: DD-04 §1, §3, §4, §7, §8; DD-07 §11;
DD-08 §6, §10; DD-09 §3 criterion 2.

**D2: exported SVGs embed their fonts** (Stage L, `feat/svg-fonts`, branched from `main` at `d3b491b`;
not merged; no golden changed; **human decision 2026-09-25**: always embed the Inter weights the file
uses). Clears §2.1 F22. **Where (orchestrator):** at export, never in `render()`, so the live view,
`lastGood.svg`, autosave's `lastGoodSvg`, the J6 boot paint and every golden are unchanged.
**`@sgl/render-svg/fonts`** (a new package entry, `src/fonts.ts`): `embedFonts(svg, fonts)` reads the
families, weights and styles the main `<style>`'s rules name (a `font-family` rule without a weight
is 400), picks from the caller's `{ family, weight, style, woff2Base64 }` faces the one CSS font
matching would use for each, and writes one `@font-face` rule per face with a
`data:font/woff2;base64,…` URL at the start of that `<style>`, XML- and CSS-escaped; sorted, so
byte-stable; an SVG with no text comes back unchanged; a malformed face throws (caller bug).
`usedFontFaces` is the selection alone. **App:** `io/fonts.ts` (`withEmbeddedFonts`) fetches only the
used shipped WOFF2 files (`fonts.css`'s own; offline, the precache), once per page, and embeds.
Save ▾ SVG, Copy SVG and the PNG's rasterisation-only copy all use it; `state/png.ts` loses its own
weight scan and splice, and the PNG now embeds only used weights (400 was always added). A failed
font fetch refuses the SVG with a toast, as for the PNG. Copy SVG hands `ClipboardItem` a text promise
inside the click (Safari's user-activation rule), `writeText` as the fallback; it is byte-equal to
Save ▾ SVG. **Size:** the app's `checkout.sgl` exports 8 206 → 105 131 bytes (three weights, no
subsetting). **Bundle:** core 178 901 → **178 911 B** gzipped (+10 B); the lazy `file-actions` chunk
11 602 → 15 598 B minified. **Inkscape 1.2.2** (checked by the implementer, `inkscape
--export-type=png` on that export): it parses the rules, warns "font face rule limited support" and
draws with an installed face (DejaVu Sans; Inter is not installed), the PNG byte-identical to the
unembedded file's; the rest of the `<style>` still applies. That is Inkscape's limitation; Figma was
not checked (no access). Tests: `packages/render-svg/test/fonts.test.ts`,
`apps/web/e2e/svg-export.spec.ts` (exact weights; base64 decoding to the shipped bytes; the exported
file loaded as an `<img>` inks its label 0.5 px from Inter's metrics, the unembedded one 9.75 px;
Copy SVG equals Save ▾ SVG; a failed fetch), an offline case in `e2e/offline.spec.ts`;
`files.spec.ts` and `png-export.spec.ts` updated for the embedded file, `test/png.test.ts` for the
moved code. Docs: DD-07 §9, DD-08 §7.

**A18 markdown labels and `@sgl/text`, on `design/a18-text`** (branched from `main` at `672948a`; not
merged). **Phase 1: design only, awaiting review. No code.** [DD-11](detailed-design/11-text.md)
implements the human decision of 2026-09-25 (bold, italic, code; `\n` and `"""` breaks; wrapping at
`@size.maxWidth`; nothing else). It records decisions T1–T60 and adds no diagnostic codes. One
existing golden changes, `unicode.sgl`'s compile golden: a plain label becomes a single run
containing `\n`. Decisions marked ⚑ go to the human first:
- T13: markdown is always on for `@label`, with no intraword emphasis, instead of an opt-in.
- T36: a fixed `@size.width` also wraps.
- T26: the fonts to add: Inter 700, four Inter italics, and IBM Plex Mono 400/700. About 156 kB,
  precached, none on the boot path.
- T55: the boot budget. A18 costs about 0.8–1.05 kB on the boot path, with the parser and breaker in
  a lazy `rich-text` chunk. It needs F20's lazy `DocumentsMenu` first, and together with A9 it fits
  only narrowly.

Sequencing: A18's grammar branch starts after A9's grammar change is on `main` (DD-11 §4.3).

**B5 engines, on `design/b5-engines`** (branched from `main` at `755bfd0`; not merged). **Design
only. No code.** [DD-12](detailed-design/12-engines.md) designs `fixed`, `tree` and `radial`
(decisions N1–N52), and every §15 recommendation was accepted by the human on 2026-09-27 (H1–H9):
- H1: under `fixed`, an unpinned node is packed below the pinned ones, with one `SGL4020` warning per node.
- H2: a pin is the frame's top-left, relative to the parent's content box. Spec §4 is changed on this branch.
- H3: `force` is cut from v1.0 (backlog B22, Could).
- H4: an engine that ignores pins warns (`SGL4021`), through the optional capability `pins?`.
- H5: `SGL4020` and `SGL4021` are allocated.
- H6: the root's `@layout` options reach the engine, in its own branch, `fix/root-layout-options`, where `checkout.sgl`'s elk goldens may be regenerated.
- H7: the spec's examples say `elk`, not `layered`. `corpus/checkout.sgl` changes in a code branch.
- H8: `radial` is `bitwise` with in-house trigonometry. ADR-0004 is amended.
- H9: `tree` and `radial` load from a lazy `std-trees` chunk inside the worker; `fixed` is static.

Orchestrator decision: bare engine names (`fixed`, `grid`, `elk`) are accepted in
`@layout.engine`, as a bug fix in `feat/b5-pin`.

In this branch, the design documents were updated to match the decisions (spec §4 and §9, the
backlog, ADR-0004, architecture §4.5, 01 FR-Y8, 06 §3), with two factual fixes: F10 said `elk` was
unbuilt, and DD-00's DD-11 row was stale. Next is the plan in DD-12 §13: `feat/b5-pin` →
`feat/b5-fixed` → `fix/root-layout-options` → `feat/b5-tree` → `feat/b5-radial`. The estimated boot
cost is ~3.2 kB of the 6.01 kB left.

**B5 branch 1, `feat/b5-pin`** (from `main` at `caa0189`; not merged). This is DD-12 §13's branch 1.
- **`@pin` has a registry row** (`config-registry.ts`, N4). Its scope is node, containers
  included. It must be `{ x, y }`, both numbers within ±100 000; otherwise the whole pin is dropped
  with `SGL2011` ("expects `{ x, y }` numbers within ±100 000"). Any other sub-key is `SGL2010`
  and kept. On an edge, a class or the root it is `SGL2012`. The pin reaches `LayoutInput`
  unchanged in `GraphNode.config.pin`, relative to the parent's content box (H2).
- **Engine notes reach the document (N20;** DD-12 §17 item 3 is resolved). An engine returns
  `LayoutResult.notes` (`{ code, span, params }`). `host.ts`'s `engineNotes()` keeps a note only
  if it is a non-error `LAYOUT_CATALOGUE` row with a finite span, and builds its message with
  `layoutDiagnostic()`. `LayoutResult.diagnostics` and `ctx.log` stay dropped. Notes are added
  only to an accepted result.
- **Pins are a capability.** `EngineCapabilities.pins?` is optional, so `apiVersion` stays 1.
  **`SGL4021`** is allocated (H5): a warning at a node's first `@pin` key, from
  `layoutConfigDiagnostics`, when the engine lacks `pins`. Neither `grid` nor `elk` has it.
  `SGL4020` moves to `feat/b5-fixed`, its emitter.
- **Bare engine names (N22, the orchestrator's bug fix).** `documentEngineOverride` maps
  `grid` → `sgl.grid` when only the latter is registered. `corpus/checkout.sgl` says `elk` (H7).
- **Fixtures:** all seven of DD-12 §12's `corpus/layout/pin-*.sgl`. The four `fixed` ones are
  `SGL4021` per pin under `grid` until `fixed` lands (`DOWNSTREAM_EXTRA`).
- **Goldens.** New: the fixtures' CST/AST pins and fonts-golden entries. Changed: only
  `checkout.sgl`'s core resolve, compile, CST and AST goldens, for its source text (the engine
  string and shifted spans). Its layout and render goldens are byte-identical.
- **Found:** an elk conformance failure (check 6, an edge starting 12 px from its node) for
  `root -> box` when `root` is declared after the titled container `box`. It happens without pins.
  It is reported, not fixed; `pin-nested.sgl` avoids that edge.
- **Size:** core **176.38 kB** of 182 (+0.39 kB) before fix round 1.
- **Tests:** `resolve.test.ts` (18 `@pin` cases); `host.test.ts` (notes);
  `host-runtime.integration.test.ts` (the engine → worker → host → `run()` seam);
  `layout-config.test.ts` (`SGL4021`); `overrides.test.ts` and apps/web `pipeline.test.ts` (bare
  names, `SGL4021` under the real registered engines, the pin in `LayoutInput`);
  `e2e/engine-options.spec.ts` (`engine: grid` lays out, and `SGL4021` is squiggled at `@pin`).
- **Docs:** DD-02 §7, DD-06 §2, §3 and §9, DD-08 §10, DD-12 §13 (as built, with deviations),
  and the corpus README.
- **Fix round 1** (after merging `main` at `b3171e6`). Eight items; each test failed first.
  1. `engineNotes` reads at most 100 notes, by index. The cap is silent, because no catalogue
     row can say how many were dropped. Params are read only for the template's placeholders.
  2. A note's span must be non-negative integers with `from <= to`. The app clamps every span to
     the document (`clampSpan`) before `setDiagnostics` and `scrollToSpan`.
  3. `workerText()`: string params lose backticks and control characters, and are cut to 120
     characters.
  4. The worker's `'error'` message is `{ t, id, reason }`. The host builds `SGL4011` from its own
     engine id and `workerText(reason)`, so the worker carries no catalogue row;
     `check-core-chunks.mjs` now requires that.
  5. `registeredEngine()` is exported, and a `pins: true` stub silences `SGL4021`. This kills
     mutation M9.
  6. and 7. `SGL4021` skips a pin the resolver dropped, so it is reported once, as `SGL2011`.
     It is once per node path, at the first pin key in source order.
  8. A blank `@layout.engine` is `SGL2011` and dropped, so the editor's engine applies.

  Size: core **176.96 kB**, +0.08 kB over `main` (176.88).

**Help branch 1, `feat/help-reference`** (Stage L, E19, DD-13 §13 branch 1; branched from `main` at
`ca9956e`; no golden changed). **DD-13 P5's exports**, each now the value the code uses in place of
its literal: `@sgl/core` exports `CONFIG_REGISTRY` and `LANGUAGE_SHAPES`; `DEFAULT_SHAPE` (`ids.ts`)
replaces `compile.ts`'s three `'rect'` fallbacks, and `@sgl/render-svg`'s `DEFAULT_SHAPE` is now a
re-export of it; `PORT_SIDES` (`compile.ts`, SGL3007's set) is exported; `STRUCTURAL_KEYS`
(`@extends` in a class, `@edges` at the root or in a container) lives in a new
`structural-keys.ts` beside the registry, whose `EXTENDS_KEY`/`EDGES_KEY` `resolve.ts` now matches
on; `A11Y_KEYS` drives the renderer's `a11yLabel`/`a11yDescription`. `REGISTERED_ENGINES` carries
each descriptor's `capabilities`. **`buildReference(engines)`** (`apps/web/src/reference/`, with its
types) builds DD-13 P6's `Reference`, deeply frozen, from those tables plus the style registry,
`DASH_PATTERNS`, `BUILT_IN` through `resolveTheme`, `CATALOGUE` and `IMPORT_CATALOGUE`. Nothing
imports it yet; `apps/web/test/reference-boot.test.ts` fails if `main.tsx` or the layout worker
reaches `src/reference/` by static imports. Tests: `reference.test.ts` (representative entries,
completeness by iterating each source table, canonical order, determinism, freezing) and the two
`reference-constants.test.ts` (each constant against the behaviour it names). Core bundle **176.05 kB
of 182** (+54 B). Deviations are listed in DD-13 §13 branch 1: `@edges`' scope includes the root,
`STRUCTURAL_KEYS` has its own module, and four gaps were filled (`hint/` ids, `engineId`,
`key/layout.engine`, `@style`'s sub-keys are the `style/` ids).

### 2.1 Open findings

Things a review has found, confirmed against running code, and deliberately **not** fixed yet —
each because the stage that can act on it has not been built. Every row names its owner; the owning
stage's entry in §5 repeats the detail. **Clear a row by fixing it and deleting it**, not by letting
it rot: a register that outlives its findings is the same failure as a stale §2.

| # | Finding | Owner |
|---|---|---|
| **F6** | `renderNode`'s port-circle template (DD-07 §3) is live, correctly `aria-hidden`, and unit-tested directly — but unreachable through the real pipeline: `grid` declares `capabilities.ports: false` and no host fallback places ports (DD-06 §4 covers labels and routing, not ports), so `LayoutResult.nodes[id].ports` is never populated end to end. Found during Stage F's accessibility pass. **Since Stage K the port circles are reachable under `elk`**, which declares `ports: true` and fills `NodeLayout.ports`; still not under `grid`. DD-12 N15 gives `fixed` a `placePorts` helper (ports spread evenly on the frame's side), which `grid` could adopt, changing `ports.sgl`'s `grid` goldens; left for a follow-up after `feat/b5-fixed`. | `feat/b5-fixed` makes them reachable under `fixed`; `grid`'s half is unassigned (a follow-up adopting DD-12's `placePorts`) |
| **F9** | **The paint-only theme-switch budget is met on a quiet machine, marginally.** Budget (DD-09 §2, kept by human decision 2026-09-23): `< 16 ms` up to 500 nodes, `< 50 ms` at 2 000, Chromium; hard ceilings 50 / 100 ms. Measured end to end by `pnpm bench:theme` on the ordinary path, a Theme ▾ pick on a document with no `@theme` (`feat/theme-fast-path`, §2: the pick sets `themeId`; `styleGraph` once per cascade signature; `renderPaintOnly` and a `<style>`-text swap; no re-parse, no re-measure, no layout). Slower-pick median `work`, ms: orchestrator's three runs on a quiet machine n500 13.2 / 12.8 / 13.0, n2000 48.9 / 44.3 / 44.8; this branch's fix round 1, one run of the three-sample gate on a quiet machine (load average 0.29 at the start, 0.50 at the end; 4 cores; nothing else running) n50 2.6 / 2.5 / 2.6, n500 13.9 / 14.8 / 13.0, n2000 47.6 / 47.0 / 48.6 (best 47.0, median 47.6; the `@theme` case n2000 265.6 / 266.6 first / repeat). A reviewer running alongside another test suite (load ≈ 6) saw n2000 50–56 and one n500 at 17.5. **Where the time goes at n2000:** ~3–4 ms of script; the rest is Chromium's style recalculation for the new `<style>` text, ~40 ms, which is the floor (replacing even one rule's text costs ~24 ms at that size, and replacing the `<style>` element instead of its text measured the same), so the headroom is a few ms and within machine noise. **Not gated:** a document that sets its own `@theme` is edited by the pick and re-parsed and re-rendered in full, ~250–275 ms at n2000 (~65–70 ms at n500): the document's own text changing. **Gate policy (fix round 1; DD-09 §3.1 "perf: nightly + release"):** the bench is not part of `check` or CI; run on demand on a quiet machine; three samples per point in one run, the best of the three slower-pick medians under the budget and the median of the three under the hard ceiling; all three reported. **A18 (`feat/a18-render`, DD-11 T57), reported and not gated:** `n2000-rich`, every label marked up as nested run tspans and every tenth wrapped, takes the paint-only path at 48.0 / 54.1 ms median `work` (first / repeat pick), ~5 ms script and the rest style recalculation over the extra elements — a few ms over 50 on the slower pick, under the 100 ms ceiling. The gated n50/n500/n2000 hold no markup (same run: 2.2 / 10.9 / 37.3 ms). If this matters, the response is DD-09 §2's second column, not a change to the markup. **Control (fix round 1, item 9):** `n2000-labelled`, the same labels and boxes without markup, measured in the same run as `n2000-rich`: 31.3 / 32.7 ms against 44.9 / 43.7 ms, so about 12 ms is the run tspans and the rest is what any fully labelled 2 000-node document costs. | watch; re-measure before Gate 4 |
| **F10** | `ctx.random`'s seed (`host.ts`'s `SEED = 1`) is one fixed constant, shared by every request for every document — `LayoutHost.run()`'s frozen signature has no per-call seed parameter, so Stage H could not add one unilaterally (DD-06 §3). Where a per-document seed should come from — a new `run()` parameter, or something content-addressed from a graph hash so the same document always seeds the same way without threading a value through every call site — is undecided, and is an orchestrator/design decision to make, not Stage H's to settle unilaterally. No engine shipped so far reads `ctx.random` at all (`grid` is fully deterministic; `elk`, built in Stage K, pins its own seed with `elk.randomSeed: '1'` instead), so nothing depends on the answer yet. DD-12 (B5) proposes that `fixed`, `tree` and `radial` read none either, so this row's owner has become `force` (DD-12 N50, H3). | `force` (backlog B22, Could since 2026-09-27) — no v1.0 engine reads `ctx.random` (DD-12 N50) |
| **F12** | After a service-worker update is accepted in one tab, other open tabs keep running the old JS while `cleanupOutdatedCaches` has already removed the old precache, so a lazy chunk the old code has not yet loaded (from Stage K, `elk`) can fail to load offline in those tabs. Found in Stage J's review; `pwa.ts` has no cross-tab coordination (e.g. reloading other clients on `controllerchange`). | Stage L |
| **F13** | A share link pasted into an already-open tab (Stage J fix round 1, item 14) imports by flushing autosave and **reloading**, not by switching in place like Open and Documents ▾ (fix round 2). That loses undo history, and when IndexedDB is unavailable (memory-store fallback) the reload loses the tab's documents outright. Also: criterion 5's offline test is falsifiable against the HTTP cache in Chromium and WebKit but not in Firefox, which has neither mechanism the spec uses; and error toasts persist until closed with no cap on how many pile up. | Stage L (E17, alongside the rest of the Documents UI) |
| **F15** | `elk` misses DD-09 §2's performance budget as measured in Node by Stage K's review: `elkEngine.layout` alone takes 0.5–0.8 s warm / 1.4 s cold at n500 (budget: 400 ms for the whole pipeline) and ~1.9 s warm / 3.8 s cold at n2000 (budget 3 s). Gate 3 is not timed. **Decision (human, 2026-09-23): record it and measure in the browser before Gate 4; the budget is not reopened.** That browser measurement should also take F24's wrapped-label numbers (pre-measure and the canvas cache) at n2000. | Stage L, before Gate 4 (the Gate 4 bench) |
| **F16** | Under `elk`, 4 edges in `wildcards` still enter a container through its own title (`lane2` 3, `fan2` 1; pinned in `packages/layout-elk/test/elk.test.ts`). `fromElkGraph` detours such runs round the title (DD-06 §6.2), but here ELK runs other edges into the same container 0.4–20 px right of the title, so any detour would cross them, and a detour is never made at that price. Also open: the fix costs +823 B on the worker's boot path, over the branch's +600 B budget (the side-entry shape is about 100 B of it). | Stage L; the size needs a decision |
| **F23** | **A document that imports many nodes `as:` costs what that many nodes cost, on every keystroke** (A9 fix round 1). Eight 1 500-node libraries imported `as:` graft 12 000 nodes, and a keystroke is ~250 ms in Node: `resolveImports` 39 ms (the imports themselves are cached; the graft is cheaper than resolving the same nodes written in the document, 53 ms) and `compileImports` 221 ms (`compile()` of the same nodes, 214 ms). The keystroke budget (DD-09 §2) is for 50 nodes; this is a 12 000-node document. Candidates: an incremental compile, or a graft kept across keystrokes when the imports are unchanged. Measured by `packages/core/test/imports-keystroke.test.ts` (DD-02 §10.8). | Stage L, with the next performance work on large documents |
| **F24** | **Wrapping re-measures every wrapped label on each keystroke, and `CanvasMeasurer`'s cache thrashes past ~7 000 of them** (A18 fix round 1, item 5). Measured in Node (static metrics, 7-run medians; long labels on the n2000 document): `premeasure` 11.7 ms unwrapped, **20.5 ms with every node wrapped** at 90 px (30.8 ms with the branch's first, quadratic breaker; the review measured 17 → 87–98 ms on its own document with it). Through `CanvasMeasurer` with a counting fake canvas, three `premeasure` passes over the same graph (what three keystrokes do) make 5 746 / 0 / 0 canvas calls at 2 000 wrapped labels and 17 174 / 0 / 0 at 6 000, but **20 068 / 20 053 / 20 051 at 7 000** and 29 375 / 28 846 / 28 938 at 10 000: past the 20 000-entry cache (about three entries per wrapped label: its words, separators and laid fragments) every pass misses. With the quadratic breaker it thrashed from ~5 000 (24 027 / 24 006 / 24 006 at 6 000). **An LRU does not help** (tried: 19 016 per repeat pass at 7 000, 28 479 at 10 000; a cyclic scan larger than the cache defeats any recency policy), so the clear-all cache stays. The remedy is for `premeasure` to reuse the previous table's entry for an unchanged key (DD-05 §5 already describes the app keeping its previous table), dropping the table when the measurer's line model changes (the rich-text chunk loading, or its degraded model); or a larger cap. **Notes:** measure it in the browser, with real `measureText`, together with F15's browser measurement before Gate 4 (the n2000-rich variant of DD-11 T56 is not built yet). | Stage L, before Gate 4, with F15 |
| **F25** | **The renderer's first baseline is `0.8 × fontSize`; measurement's ascent is the font's own** (DD-11 §19 item 5; found by DD-11's design, measured by `feat/a18-render`). DD-07 §5 once said `y = frame.y + layout.ascent` from the measured `TextLayout`; `render()` was never given one and has always drawn `0.8 × fontSize`, which A18 kept (T42) so no golden moved. `CanvasMeasurer`'s ascent is `fontBoundingBoxAscent`, which Chromium rounds to whole pixels: Inter's 0.969 em comes out as **13 px** for a 13 px node title against the rendered **10.4 px** (label drawn **2.6 px** higher than measurement's baseline), 12 px against 9.6 for a container title (2.4 px). Adopting the measured ascent would move every label by about 2–2.6 px and re-baseline every render golden under every theme; the label boxes and layout are unaffected (heights use `lineHeight`). `apps/web/test/rich-measure.browser.test.ts` pins the numbers. **A human decision:** keep `0.8 em` (DD-07 §5 now says so), or adopt the measured (or a fixed 0.97 em, deterministic across browsers) ascent in one golden re-baseline. | **Deferred: human decision 2026-09-27, leave it for now** (it cannot overflow a box); fold it into the next re-baseline of the render goldens made for another reason, by whoever next touches DD-07 §5 |
| **F26** | **E15 (drag to pin) cannot write a dragged position back yet: the host throws away the translation it applies.** `quantize` (DD-06 §5, F14) moves every result so that its content box, plus the margin, starts at `(0, 0)`, and discards the offset (`x0`, `y0`). A pin is relative to its parent's content box, and at the root to the diagram's origin (DD-12 H2), so a canvas position cannot be turned back into a root pin without that offset. Proposed remedy (DD-12 N3): an optional `origin` on `LayoutResult`. B5 does not need it. | E15 (Could), when built |
| **F28** | **DD-06 §8's conformance check 3 (no two sibling frames overlap) assumes the engine chooses every position.** Under `fixed`, nodes the author pinned may overlap on purpose. Today's suite passes, because the corpus has no pins, and `fixed`'s own tests cover pinned overlap (DD-12 §12). The SDK's published conformance guide must exempt nodes placed by the author before third parties rely on it. | Stage M (B18) |

---

## 3. Why this order

The ordering is not arbitrary and changing it is expensive. Three constraints drive it.

**The corpus is the test strategy.** DD-09 §3.2 makes `corpus/` the shared fixture set every test
level draws on. Until `parse` → `resolve` → `compile` works, no stage can use it, and every stage has
to hand-build `SemanticGraph` literals instead. That is what happened to the theme, measure and
renderer stages, and it is why Stage D exists to undo it. **The front end therefore goes first**, as a
vertical slice, before anything else is widened.

**The pipeline has exactly one async boundary.** Everything from `parse` to `render` is a pure
synchronous function except `layout`, which crosses into a worker. So the whole pipeline can be closed
and proven *in Node, synchronously*, by calling the engine directly — before the worker host, the
editor or the browser exist. Gate 2 is that proof, and it de-risks everything after it.

**Determinism is cheapest to enforce from the start.** A double-run test costs three lines when the
stage is written and is an archaeology exercise six stages later.

---

## 4. Gate tiers

Each stage names the tiers it must clear. Higher tiers include lower ones.

| Tier | Name | What it means |
|---|---|---|
| **T1** | Package gate | `pnpm lint && pnpm typecheck && pnpm test` green; the stage's own unit tests cover its branches |
| **T2** | Corpus gate | The stage's assertions hold over `corpus/`, and its goldens are committed and byte-exact |
| **T3** | Pipeline gate | End-to-end through every stage built so far, twice, byte-identical |
| **T4** | Acceptance gate | The six MVP criteria in [06 §3](06-feasibility-and-mvp.md#mvp-acceptance), automated |
| **T5** | Release gate | The manual checklist in DD-09 §3.1: a golden opened in Inkscape, Figma and Safari; PWA installs; a `.sgl` opens from the OS |

**Every gate is anti-regression.** Clearing a gate means every earlier gate still passes.

---

## 5. Stages

### Stage A — Parser · `feat/parser`

**Goal.** `parse(source)` turns `.sgl` and `.sgl.json` text into the typed AST with spans.

**Depends on.** Nothing. Branch already carries salvaged work — start by reading it, not by rewriting it.

**Read.** DD-01 (all) · DD-00 §3 · language spec §1–§3, §10 · `packages/core/src/ast.ts` ·
`packages/core/src/diagnostics.ts` · `packages/core/src/grammar/sgl.grammar`

**Frozen.** The AST types in `ast.ts`. The `Diagnostic` shape and the catalogue's existing codes.

**Tasks.**
1. Finish `build-ast.ts`: CST → typed AST, a span on every node, escape decoding (`\n \t \" \\ \/`,
   `\uXXXX`; anything else is `SGL1004` and keeps the backslash).
2. Wire `parse()` in `parse.ts` to the generated parser plus `buildAst`, collecting `SGL1xxx` from
   Lezer error nodes.
3. Error tolerance (FR-L12): malformed input yields a partial AST **and** diagnostics, never a throw.
4. Verify the two grammar fixes on the branch — quoted `@`-keys, and the `$name` `Variable` token —
   regenerate with `pnpm grammar`, and confirm the committed output matches.
5. `$name` parses into a `Variable` node but **is not substituted**; that is Stage K. Decide and
   document what `resolve` will do with one in the meantime (see Stage B task 5).

**Gate — T1 + T2.**
- Every non-`malformed/` corpus document parses with zero error diagnostics, including
  `json-form.sgl.json` and `checkout.sgl`.
- Each `corpus/malformed/*.sgl` yields ≥1 `SGL1xxx` whose span covers the offending text, **and** a
  non-empty partial AST.
- Span coverage: every AST node has `from <= to`, both within `[0, source.length]`.
- `packages/core/test/grammar.test.ts` updated — its two "still fails to parse" assertions are now
  wrong and must move to the passing list.
- Double-run: parse twice, identical AST JSON.

**Out of scope.** Variable substitution. Incremental reparse. Editor language support (`core/editor`).

---

### Stage B — Resolver · `feat/resolver`

**Goal.** `resolve(ast)` folds the AST into the canonical `DocumentModel`, and `toJson`/`fromJson`
round-trip it.

**Depends on.** Stage A merged.

**Read.** DD-02 (all) · language spec §2, §4, §6, §9 · `packages/core/src/model.ts`

**Frozen.** `DocumentModel`, `ContainerModel`, `EdgeModel`, `ClassModel`, `ConfigBag`.

**Tasks.**
1. Build the container tree: merge redeclarations (`SGL2005`), expand the string-to-label and
   bareword-to-class shorthands, reject a non-`@` key holding a number/boolean/null/array.
2. Normalise dotted `@`-keys into nested bags (`SGL2006` when a scalar is replaced by an object).
3. Classes: `@extends` linearisation, cycle detection (`SGL2004`), `SGL2007` for non-config in a class
   body.
4. Edges: an `EdgeStmt` with *n* ops becomes *n* `EdgeModel`s on the declaring container, label copied
   onto every one, `ordinal` = index in the chain. Endpoints keep their `PathExpr` **unresolved** —
   including wildcards, which expand in Stage C, not here (DD-02 §5).
5. A `Variable` value: emit a diagnostic saying variables are not supported in this version and treat
   the value as its literal text. Allocate a new `SGL2xxx` code, add it to the catalogue and add a
   corpus fixture. Stage K replaces this.
6. Config-key registry (`config-registry.ts`) driving validation (`SGL2010`–`SGL2012`) and `toJson`
   emission order.
7. `toJson` per DD-02 §6 — stable key order, nested config, `@type` always an array, two-space indent,
   trailing newline. A wildcard endpoint round-trips as itself (`"from": "lane1.*"`).

**Gate — T1 + T2.**
- Resolver goldens for every corpus document, committed, byte-exact.
- **The round-trip property:** `resolve(parse(toJson(m))).model ≡ m` (ignoring spans) for the whole
  corpus. Use `fast-check` to shuffle top-level declaration order and assert the model is unchanged
  (DD-09 §3.3 invariants 1 and 2).
- Each `corpus/unresolved/*.sgl` **whose expected code `resolve()` can actually emit** does so exactly.
  Eight of the existing fixtures name `SGL2001`, `SGL2003` or an `SGL3xxx` code — DD-02 §8 is explicit
  that the first two, despite the `2xxx` range, are DD-03's (they need the whole tree), and the rest are
  `3xxx` by definition. `resolve()` never touches path resolution or wildcard expansion, so it cannot
  emit any of the eight; they stay in the corpus for Stage C to pick up unchanged.
- Double-run identical.

**Out of scope.** Path resolution (Stage C). Imports. Variable substitution.

---

### Stage C — Compiler · `feat/compiler`

**Goal.** `compile(model)` produces the `SemanticGraph` — the IR every downstream package consumes.

**Depends on.** Stage B merged.

**Read.** DD-03 (all, especially §3.1 wildcard expansion and §5 edge IDs) · language spec §3 ·
`packages/core/src/graph.ts` · `matchesWildcard` in `ast.ts`

**Frozen.** `SemanticGraph`, `GraphNode`, `GraphEdge`, `LabelSpec`, `PortSpec`. The `EdgeId` formula
in DD-03 §5 — it is a compatibility surface, because edge IDs appear in exported SVG.

**Tasks.**
1. Flatten the tree into the node map; `NodeId` = path segments joined by `.` with `.` and `\` escaped.
2. Endpoint resolution (DD-03 §3): `root`/`parents`/`segments`, `SGL2001` on a miss with the edge
   dropped and everything else intact.
3. **Wildcard expansion (DD-03 §3.1)** — the part to get exactly right:
   - expand **before** ID allocation, so an expanded edge is indistinguishable from a hand-written one
   - `*` = direct children, `**` = descendants in pre-order including containers, glob filtered by
     `matchesWildcard`
   - hidden nodes never match; empty match is `SGL3003`; a non-final wildcard is `SGL3004`
   - both sides wildcarded is a cross product with self-pairs excluded; over `MAX_EDGE_EXPANSION` is
     `SGL3005` and the statement is skipped
4. Edge IDs and `parallelIndex` per DD-03 §5. Labels, ports, shape resolution (`SGL3001`), hidden
   propagation (`SGL3002`), pre-order `order`.

**Gate — T1 + T2 + the diagnostics coverage gate.**
- IR goldens for every corpus document, committed, byte-exact.
- **ID stability:** shuffle a document's declarations at random; assert the node and edge ID *sets* are
  identical. Then add a child at the **front** of a wildcarded container and assert every pre-existing
  edge ID survives (DD-03 §5).
- `corpus/wildcards.sgl` and `corpus/wildcard-globs.sgl` produce exactly the expansions their comments
  describe, including every near-miss that must **not** match.
- **Diagnostics coverage gate (DD-09 §3.4), enabled here and enforced from now on:** a table test that
  every code in `CATALOGUE` has ≥1 corpus fixture emitting it and ≥1 that does not. Codes not yet
  reachable get an explicit allowlist with a reason, and the allowlist must shrink over time.
- Double-run identical.

---

> ### ▛ Gate 1 — the front end is real
>
> `.sgl` text in, `SemanticGraph` out, for every document in the corpus, with goldens committed and
> the diagnostics coverage table enforced.
>
> **After this point no stage hand-builds a `SemanticGraph`.** Everything tests against the corpus.

---

### Stage D — Re-base theme and measure on the corpus · `feat/corpus-fixtures`

**Goal.** Delete the hand-built graph literals in the theme and measure tests and drive them from real
compiled documents.

**Depends on.** Gate 1.

**Why this is a stage and not a chore.** A hand-built fixture asserts what its author believed the IR
looks like. Two of those already exist, written by agents who could not run `compile`. Until they are
replaced, the theme and measure suites are green against a graph shape that may not be the one the
compiler emits, and the first real integration will find it the hard way.

**Tasks.**
1. Add a test helper — `corpus/` document name → `StyledGraph` — living somewhere both packages can
   use without breaking the import boundaries (a dev-only fixture module, not a shipped export).
2. Re-point `packages/theme/test/cascade.test.ts` and `packages/measure/test/measure.test.ts` at it.
   Keep the hand-built literals **only** where the test needs a shape the corpus does not contain, and
   comment why.
3. Fix whatever this uncovers. Expect it to uncover something.

**Gate — T1 + T2.** Both suites pass against corpus-derived graphs. `premeasure` covers **100% of
labels in the corpus** with zero table misses — the stated exit criterion in DD-00 §6.

---

### Stage E — Grid engine and host gap-fillers · `feat/grid-engine`

**Goal.** `grid` lays out a real compiled graph; the host fills the gaps the engine declares it does
not cover.

**Depends on.** Gate 1 + Stage D. Branch carries a salvaged `anchor.ts`.

**Read.** DD-06 §2, §4, §7 · Architecture §4 · ADR-0002 · ADR-0004 ·
`packages/layout-api/src/contract.ts`

**Frozen.** `LayoutEngine`, `LayoutInput`, `LayoutContext`, `LayoutResult` and everything in
`contract.ts`. This is the project's main external surface — a third party writes against it. If
something in it is unworkable, **report it loudly** rather than working around it quietly.

**Tasks.**
1. `grid` (DD-06 §7): deterministic row/column packing, `columns`/`gap`/`align` options, `@layout.columns`
   hint, recursive container packing with `contentFrame` set and room for the title band.
2. Leave `labelPlacement: false` and `edgeRouting: 'straight'` **as declared**. Do not let the engine
   place its own labels — the whole point is to exercise the negotiation path that makes a small
   third-party engine viable.
3. `validateResult` (DD-06 §4): reject NaN/Infinity, unknown node IDs, missing entries, each with a
   precise `SGL4002`. A buggy engine must never corrupt the renderer.
4. `quantize` per the engine's declared determinism class (ADR-0004).
5. Host fallbacks (DD-06 §2): `placeLabels` and `routeStraight`, the latter clipping at node boundaries
   using the salvaged anchors, with a real arc for a self-loop.
6. **F1 (§2.1).** `GraphNode.children` and `rootChildren` are **unfiltered** — they list hidden nodes,
   and only `order` leaves them out. Task 1 packs containers recursively over `children`, so it must
   test `node.hidden` itself. Both `GraphNode` and `GraphEdge` carry the flag, already resolved to
   *effectively* hidden (own `@hidden`, or an ancestor's, or for an edge either endpoint's), so this
   is one comparison and never an ancestor walk. Clear F1 when the filter is in and asserted.

**Gate — T1 + T2.**
- **Bitwise determinism** — `grid` declares `'bitwise'`, the strictest class in ADR-0004. Lay out every
  corpus document twice; assert byte-identical. This is the engine's exit criterion in DD-00 §6.
- Every non-hidden node and edge has geometry and every number is finite (DD-09 §3.3 invariant 5).
- `validateResult` rejects each malformed shape with the right code.
- Layout goldens for the corpus, committed.

**Out of scope.** The worker host (Stage H). The elk adapter (Stage K). Ports — `grid` declares
`ports: false`.

---

### Stage F — Renderer verification · `feat/renderer`

**Goal.** Prove the renderer. The implementation exists on the branch and is untested.

**Depends on.** Stage E.

**Read.** DD-07 (all) · DD-09 §1, §3.3 · the existing code on the branch

**Tasks.**
1. Golden SVGs for every corpus document, committed, byte-exact.
2. **The injection suite.** Parse each rendered SVG as XML with `fast-xml-parser` and assert: no
   `script` element, no `on*` attribute, every `href` on the allowlist (DD-09 §3.3 invariant 6). Drive
   it from `corpus/injection/*.sgl` — which is now possible, because the parser exists.
3. Shape maths: for each of the seven, a ray from outside hits the boundary; the degenerate centre case
   returns the centre; an ellipse anchor actually lies on the ellipse. **Check the formulas against
   DD-07 §4 rather than assuming the code transcribed them correctly.**
4. Accessibility: `role`, `<title>`, `<desc>`, per-element `aria-label`, document order equal to
   `graph.order` — which is the *only* filtered traversal; `children`/`rootChildren` include hidden
   nodes (F1, §2.1).
5. **F4 (§2.1) — decide the one-sided wildcard self-loop.** `x -> /**` expands to include `x`, so it
   emits `x -> x`. DD-03 §3.1 excludes self-pairs only when both sides are wildcarded; you are the
   first stage that can *see* the result. Either confirm it (and add the corpus fixture that is
   missing either way) or change DD-03 §3.1 and `compile()` together. Self-loop routing is already
   the host fallback's job (DD-06 §4.5), so this is about authoring intent, not renderability.
6. Reconcile two known discrepancies with DD-07 §8 and update the document: the implementation collapses
   `escText`/`escAttr` into one function, and allows only `https:`/`mailto:` where §8 also lists `http:`
   and in-document `#n-…`. Decide which is right; the language spec §4 currently agrees with the code.
7. Double-run identical.

**You may assume** `GraphNode.shape` is always one of the seven DD-07 §4 draws — Stage C guarantees
it, falling back to `rect` with `SGL3001` or `SGL3006` (DD-03 §4). The shape table needs no fallback
branch of its own.

**Gate — T1 + T2.**

---

### Stage G — The end-to-end seam · `feat/pipeline`

**Goal.** One function, `source → RenderResult`, running synchronously in Node, plus goldens for the
whole corpus.

**Depends on.** Stages A–F merged.

**Why a stage of its own.** Every prior stage is verified in isolation. This is the first thing that
proves the *seams* line up — that the compiler's IR is the one the theme expects, that the measure
table's keys are the ones the engine looks up, that the renderer's structural `LayoutView` really is
satisfied by a `LayoutResult`. It is cheap to build and it is where integration bugs surface.

**Tasks.**
1. A test-only harness (not a shipped package export) composing
   `parse → resolve → compile → resolveTheme → styleGraph → premeasure → grid → render`, calling the
   engine **directly** — no worker, no async.
2. End-to-end goldens for the corpus under both built-in themes.
3. A `bench/generate.js` producing `corpus/n50.sgl`, `n500.sgl` and `n2000.sgl` deterministically, and
   a fixture that trips `SGL3005` — the one catalogue code still without coverage.

**Gate — T3.**
- Every corpus document goes source → SVG with no unexpected diagnostics.
- **Run the whole pipeline twice; byte-identical SVG.**
- **Switching `neutral-light` → `neutral-dark` changes `paintHash` and leaves `geometryHash` and the
  layout untouched** — the property MVP acceptance criterion 2 rests on, proven here before any UI
  exists to demonstrate it.

---

> ### ▛ Gate 2 — the pipeline closes
>
> This is the **phase-0 exit** from [Architecture §7](03-architecture.md): *"the pipeline shape is
> right."* Text in, deterministic accessible SVG out, end to end, in CI.
>
> Everything after this is the product around a pipeline that already works.

---

### Stage H — Worker host · `feat/layout-host`

**Goal.** Layout runs off the main thread, with a timeout and cancellation.

**Depends on.** Gate 2.

**Read.** DD-06 §3 · Architecture §4.4 · 06 §4 pitfall 5 · `packages/layout-api/src/protocol.ts`

**Tasks.** `createWorkerHost`; the message protocol; a 10 s hard timeout that terminates and respawns
the worker with `SGL4001` while the previous layout stays on screen; `AbortSignal` cancelling a
superseded run; the `measure` RPC for a table miss; `SGL4011` for an engine that throws.

**Scope note.** MVP is a plain `Worker` + timeout + abort — the half that protects the *user* from a
hung layout. Cross-origin iframe isolation, which protects against *malicious code*, ships with B17
and is out of scope. The `LayoutHost` interface is the same either way.

**Gate — T1 + a browser test run.** Timeout terminates and respawns; abort cancels in flight;
malformed engine output is rejected with `SGL4002` and the previous layout survives; a table miss
round-trips through the RPC. Vitest browser mode (Chromium, Firefox) starts here — wire it into
`vitest.config.ts` and CI.

---

### Stage I — Application shell · `feat/app-editor`

**Goal.** The editor loop: type on the left, see the diagram on the right.

**Depends on.** Stage H.

**Read.** DD-08 §1–§6 · 06 §5 (technology choices)

**Tasks.** The signal graph and pipeline orchestration (§2–§3); CodeMirror 6 driven by the same Lezer
grammar via `@sgl/core/editor` (§4); inline diagnostics at exact spans (§5); the canvas with
`innerHTML` swap, pan/zoom and the interaction overlay as a **sibling** of the exported tree (§6);
**last-good-render** — a document with errors never blanks the canvas (FR-E4).

**F2 (§2.1) while wiring §5's inline diagnostics.** One bad value in a class body produces one
diagnostic *per node using that class*, each spanned to the node and none to the class — so a single
typo in `@classes` lights up every node that extends it and points at none of the causes. `Diagnostic`
already carries `related`, and `resolve()` already keeps `classSpans`; this is where the gutter makes
the cost visible, so it is where the fix pays for itself. Clear F2 when a class-sourced `SGL3001`,
`SGL3006` or `SGL3007` carries a `related` span pointing at the class declaration.

**Gate — T1 + T4 (partial).** Playwright: MVP acceptance criteria **2 and 3**, and the single-engine
half of **1** (a 40-node three-level document renders under `grid`; switching engines waits for `elk`
in Stage K — orchestrator decision I1). Also measures `render()` + `innerHTML` swap against F9's
renegotiated budget. Criterion 2 is the
visible half of what Stage G already proved — assert that switching theme leaves *geometry* untouched:
same node frames, same edge route `d` attributes, same `viewBox`, while paint changes. **Do not assert
"the tree is untouched and only the `<style>` block changes"** — that is what this gate said before
**F7**, when the property did not hold: paint class names embedded `paintHash` and a directed
edge's marker id its stroke colour, so a theme switch was a full re-render. (Stage L's re-baseline
made it hold in `render()`'s output, §2, and F9's swap made it hold on screen: criterion 2's test
now also asserts that only the `<style>` text changes.) Assert the geometry first.

---

### Stage J — Files, share and offline · `feat/app-files`

**Goal.** Documents survive leaving the page.

**Depends on.** Stage I.

**Read.** DD-08 §7–§9 · DD-10 §5

**Tasks.** Open/save `.sgl`, `.sgl.json`, `.txt`; IndexedDB autosave with storage as a keyed list from
day one so multi-document (E17) is later UI only; URL-fragment share via
`CompressionStream('deflate-raw')` + base64url with a size cap; `vite-plugin-pwa` precaching the shell,
every registered engine (only `grid` until Stage K adds `elk`) and both themes; `file_handlers` for `.sgl`; the `_headers` CSP from DD-09 §1.2.

**Gate — T4 (single engine).** Playwright covers MVP criteria 2–6 with `grid` as the only engine,
including the offline run and a share link opening in a fresh browser context. Criterion 1 and the
engine-switch half of criterion 5 complete in Stage K, which now runs before Gate 3.

---

### Stage K — The elk adapter · `feat/layout-elk`

**Goal.** The default engine (ADR-0005), and the proof that two engines sit behind one interface.

**Depends on.** Stage J.

**Read.** DD-06 §6 · ADR-0005 · 06 §4 pitfalls 7 and 8

**Moved before Gate 3 (2026-09-23, human decision).** The plan previously ran this stage *after*
the MVP gate, while Gate 3's own acceptance criteria 1 (switching engines) and 5 (both engines
offline) cannot pass without `elk`, and [04](04-feature-backlog.md)'s phase-1 row already names elkjs
as an MVP engine. The stage letter is unchanged so existing references stay valid.

**Tasks.** Adapt `elk.bundled.js` — the **synchronous single-thread build**, because elkjs's own worker
build would nest a worker inside our worker and cost two serialisation hops. Pin
`org.eclipse.elk.randomSeed: 1`. Map the IR to ELK's graph and the result back, taking labels and
container titles **from ELK** rather than from the host fallback. Lazy-load it as its own chunk,
excluded from the core bundle budget. Register it in `apps/web/src/layout.worker.ts`, make
`sgl.elk` the app's default engine (undoing Stage I's interim `sgl.grid` default, decision I1), add its
chunk to the PWA precache Stage J set up, build the per-engine options form (**F11**, §2.1), and
complete the Playwright suite's engine-switch cases (DD-08 §14 test 4).

**Gate — T2 + T3 + a size check + T4 complete.**
- Every corpus document lays out; labels and container titles come from ELK, asserted, not from the
  fallback.
- MVP acceptance criterion 1: a 40-node three-level document renders under **both** engines and
  switching changes geometry only.
- `determinism: 'quantized'` — two runs identical *after* quantization (ADR-0004).
- Boundary-crossing edges from `corpus/containers-edges.sgl` render without artefacts. This is where
  ELK's own tracker is busiest; if `ORTHOGONAL` misbehaves, `POLYLINE` is one option away.
- `size-limit` on the core chunk: under 180 kB gz, hard ceiling 300. Wire it into CI here.
- **T4 complete:** Playwright covers all six MVP criteria with both engines registered, including
  switching engines offline (criterion 5).

---

> ### ▛ Gate 3 — MVP
>
> The six acceptance criteria in [06 §3](06-feasibility-and-mvp.md#mvp-acceptance), automated in CI,
> plus **T5** by hand once: a golden opened in Inkscape, Figma and Safari; the PWA installed; a `.sgl`
> opened from the OS.
>
> Deployable. This is the phase-1 exit in [04](04-feature-backlog.md).

---

### Stage L — The rest of Must · `feat/*` per item

**Depends on.** Gate 3. Individually orderable; each is its own branch and its own T1+T2 gate.

| Item | Notes |
|---|---|
| A8 variables, A9 imports | A8: **done, merged** (§2). **F3** (a visited-set guard in `compile()`'s `linearizeClasses`) was fixed with it, ahead of imports, the second way class tables get built. A9: **complete on `feat/imports`, awaiting orchestrator verification** (§2): relative paths against the user's stored documents, Share bundles them (`i=`), every import failure a warning, qualified names in the grammar; the import machinery is the lazy `imports` chunk. Remote imports and F5 `.sglpack` are not part of it. |
| **A18 markdown labels + `@sgl/text`** | The largest non-engine subsystem. The `Measurer` is run-based already, so this is an addition, not a rewrite. |
| B5 `fixed`, `tree`, `radial` | Design: [DD-12](detailed-design/12-engines.md), on `design/b5-engines`, with human decisions H1–H9 (2026-09-27). `fixed` first: 2–3 days (about a day was the first estimate), and the escape hatch people ask for. Then `tree` and `radial`, in a lazy `std-trees` chunk inside the worker. **`force` is cut from v1.0** (backlog B22, Could). Branches: `feat/b5-pin` → `feat/b5-fixed` → `fix/root-layout-options` → `feat/b5-tree` → `feat/b5-radial` (DD-12 §13). |
| C5 `high-contrast`, `print` themes | **Done, merged** (§2). Tokens only for metrics (every document's `geometryHash` is `neutral-light`'s; any switch among the four is paint only); `high-contrast` AAA text and 3:1 non-text over the rendered corpus; `print` white fills and black strokes and text, through the new paint-only theme `force` (DD-04 §4 step 7), which reaches the document's own colours. In the core bundle (+0.24 kB), not lazy. |
| D6/D7 PNG and clipboard export | **Done, merged at `4a908d6`** (§2). Save ▾ PNG at 1×/2×/3× (2× default) through a rasterisation-only copy of `lastGood.svg` with Inter embedded as `data:` fonts, since an `<img>` SVG cannot use the page's fonts. Capped at 16 384 px a side and 8192² px in all. Copy SVG (text) and Copy PNG (2×). No CSP change. D2 (fonts embedded in the exported SVG) is done on `feat/svg-fonts` (§2). |
| F2 drag-and-drop, F5 `.sglpack` | Conveniences on F1. |
| E17 multiple documents | Storage is already a list; this is UI. **Partly pulled into Stage J by human decision (2026-09-23):** Open creating a new local document, and a minimal Documents ▾ list (switch to any stored document, New document). **Remaining here:** delete, rename, search, tabs and multi-select. |
| D10 SVG export options UI | Background on/off and scale for Save ▾ SVG (DD-08 §7); today it saves the defaults, `render()`'s own output. |
| **F9 — the theme-switch budget** | **Met on a quiet machine, marginally at n2000; watch and re-measure before Gate 4** (`feat/theme-fast-path` and its fix round 1, §2; §2.1 **F9**). Measured end to end by `pnpm bench:theme` (a Theme ▾ pick made as the picker makes it, on the real editor, pipeline and canvas, until `getBBox()` after the paint, any pre-measure included); the gate takes three samples per point of the slower pick of a document without `@theme`: the best under the budget (n500 < 16 ms, n2000 < 50 ms, Chromium), the median under the hard ceiling (50 / 100 ms); `KNOWN_MISSES` is empty. The path: the picker as a view preference and one batch per pick (human decision P1, orchestrator P2), `styleGraph` once per cascade signature, `renderPaintOnly` and the canvas's `<style>` swap guarded by `structureHash` (P3), `lastGood.svg` derived when read (P4). The overlay stays a sibling of the exported tree. |

**Gate 4 — v1.0.** Every Must in [04](04-feature-backlog.md) done, all gates green, bench inside the
DD-09 §2 budgets on the 50/500/2000-node corpus.

---

### Stage M — Plugin surface · `feat/plugin-sdk`

**Depends on.** Gate 4.

`@sgl/plugin-sdk` with the scaffolder and test harness; the conformance suite at
`@sgl/layout-api/conformance` grown to ~40 graphs; the options-schema-driven settings UI; `@sgl/cli`;
B17 third-party engines behind the iframe sandbox that was deferred from the MVP.

**Gate 5.** A third party can write an engine against published docs, run the conformance suite, and
load it — demonstrated by writing one that is not `grid` or `elk`.

---

## 6. Agent brief template

Copy this, fill the bracketed parts from the stage above, and hand it to the agent. It starts cold: it
knows nothing that is not in the brief or the repo.

```markdown
You are implementing **Stage [X] — [name]** of SGL, a text-first diagramming language.

## First
1. Read `docs/07-execution-plan.md` §1 (standing rules) and §2 (state of the build). They override
   your defaults.
2. Read the stage entry for Stage [X] in §5.
3. Read, in this order: [the stage's Read list].
4. `git checkout -b [branch] main`

## The work
[Paste the stage's Tasks.]

## Do not change
[Paste the stage's Frozen list.] If one of these is wrong, implement around it and say so in your
report — do not edit it silently.

## Done when
[Paste the stage's Gate.]

Then `pnpm check`, commit to `[branch]`, and do not merge or push.

## Report back
- what you implemented, and any design decision you had to make that the documents did not settle
- anything in the design documents you found wrong, ambiguous or contradictory
- what you deliberately left out
- your final commit SHA
```

**Three failure modes to guard against**, learned from the first round of delegation:

- **Silent scope creep.** An agent that finds an adjacent gap tends to fill it. Name the out-of-scope
  items explicitly.
- **Fixture drift.** An agent that cannot run an upstream stage will invent its input shape. After
  Gate 1 this is never necessary — say so in the brief.
- **Quiet deviation.** An agent that finds a design document wrong tends to just write working code
  and not mention it. The report-back section is not a formality; it is how the documents stay true.

A fourth, learned from Stage F's review round: **the overclaimed write-up.** An agent's report — and
the §2 prose it writes — can say "all fixed" while whole findings went untouched. Every item in a
brief or fix list must name the file it has to change, so the claim can be checked against
`git diff --stat main...<branch>` rather than read.

### The loop around the brief

How a stage moves from brief to `main`. One orchestrator owns the loop, the decisions and every
merge; implementation and review are delegated.

1. **Preflight** (orchestrator). `git branch -vv`: the previous stage is actually merged, not just
   "done" in §2. `pnpm check` green on `main`. List the §2.1 rows this stage owns.
2. **Brief** (orchestrator). The template above, plus: an explicit out-of-scope list; the owned
   §2.1 rows; the known traps (a fresh worktree needs `pnpm install` and `pnpm build` before tests
   resolve cross-package imports; any new Lezer token needs `@precedence` and an audit of every
   production the token it shadows appears in).
3. **Implement** (one agent, own worktree, branch `feat/<stage>`). Commits; does not merge or push.
4. **Verify** (orchestrator), *before* reading the report's prose: map every task to a file in the
   diffstat, run `pnpm check` independently, map every gate bullet to a named test.
5. **Review** (two or three agents in parallel, fresh context, read-only, each one lens): design-doc
   conformance; gate falsifiability and test coverage — could this gate be green while something is
   visibly broken?; standing rules (§1: determinism, errors as values, dependency direction,
   diagnostics catalogue). The implementer's report is handed over as *claims to check*. Each finding
   carries a severity, a file/line, and whether it needs a decision.
6. **Triage** (orchestrator). Confirm each finding against the code, then: fix now; defer to §2.1
   with a named owner; reject with the reason recorded; or decide (below).
7. **Fix round** (the same implementer, context kept). A numbered list; each item names its file.
8. **Re-verify** (orchestrator). Diffstat per item, `pnpm check`, and §2's new prose read against
   the diff. **At most two fix rounds** — needing a third means the brief or the design is wrong,
   and that goes to a human rather than round four.
9. **Merge** (orchestrator). `git merge --no-ff`, `pnpm check` on `main`, §2 updated in a follow-up
   commit. Never push.

**Who decides.** The orchestrator decides — and records the decision in the commit message and §2
— anything reversible that does not change what the product promises: what the design documents
already settle; test structure, fixture placement, naming; filling an incomplete document the way the
surrounding design implies; which later stage owns a deferred finding; a reviewer disagreement where
one side is document-backed. **A human decides** anything that changes a promise: a DD-09 budget or
an MVP acceptance criterion (F9); a change that re-baselines every golden (F7); the language spec,
an ADR, a new runtime dependency, the security posture (CSP, sandboxing); dropping a Must; anything
outward-facing (push, PR, deploy); and any split between two defensible options with product
consequences. Escalations are batched, each with a recommendation, while work that does not depend
on the answer continues.

---

## 7. Keeping this document honest

Update §2 in the same commit that changes the state of the build. Add a stage when work appears that
does not fit one. When a gate turns out to be unfalsifiable — green while something is visibly broken —
fix the gate, in this document, before continuing.
