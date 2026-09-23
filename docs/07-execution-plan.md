# SGL — Execution Plan

How the delivery plan in [04 §Revised delivery plan](04-feature-backlog.md) actually gets built: the
order, the staging gates, and the context an agent needs to pick up any one stage cold.

This document is **operational**. [01](01-requirements.md)–[06](06-feasibility-and-mvp.md) and the
[detailed design](detailed-design/00-overview.md) say *what* to build and *why*. This says *in what
order*, and *how you know a stage is finished*.

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
core, theme  ←  measure, render-svg
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
`packages/core/src/diagnostics.ts`. Never hand-roll a message string. Adding a code means adding a
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

`check` builds before testing because a workspace package's cross-package `import`s resolve
through its published `exports`, which point at `dist/`. `tsc -b` (the typecheck step) only
compiles `.ts` files, so a package that re-exports a hand-generated `.js` asset — `@sgl/core`'s
Lezer parser, once Stage A wires `parse()` to it — needs its real build (`tsdown`, which bundles
everything into one file) before any other package's tests can import it.

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
| `apps/web` | **Not started**, except `layout.worker.ts` — the one real worker entry Stage H needed (registers `gridEngine`) | `main` |

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

**Gate 2 is cleared. No branch is now unmerged.** `feat/layout-host` cleared two review-fix rounds
and merged to `main` at `279d84b`; `pnpm check` is green there (1625 tests, unchanged from the
branch), so **Stages A–H are all on `main` and Stage I's stated dependency is satisfied**.
`feat/pipeline` merged at `ffff7de` before it (1553 tests), `feat/renderer` at `6d76e2c` (1453
tests), and `feat/grid-engine` at `fdff204` (757 tests). Each sat unmerged on their branch through review first, which is the documented
pattern, not the merge-gap failure mode — but it is worth noting for the next stage that this has now
happened five times in a row (Stages C, E, F, G, H), so **check `git branch -vv` before briefing stage
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

### 2.1 Open findings

Things a review has found, confirmed against running code, and deliberately **not** fixed yet —
each because the stage that can act on it has not been built. Every row names its owner; the owning
stage's entry in §5 repeats the detail. **Clear a row by fixing it and deleting it**, not by letting
it rot: a register that outlives its findings is the same failure as a stale §2.

| # | Finding | Owner |
|---|---|---|
| **F2** | One bad value in a class body yields one diagnostic **per node using the class** — three nodes extending a class with `@shape: trapezoid` give three `SGL3001`s, each spanned to a node, none to the class. Same for `SGL3007`. Correct but noisy; wants a `related` span on the class declaration. | Stage I |
| **F3** | `linearizeClasses` recurses `@extends` with no visited-set guard. Safe **only** because `resolve()` splices every cycle's back-edge first, so no `DocumentModel` reaching `compile()` can contain one. A second producer of class tables would turn bad input into a stack overflow — which §1 reserves for invariant violations. | Stage L (A9) |
| **F6** | `renderNode`'s port-circle template (DD-07 §3) is live, correctly `aria-hidden`, and unit-tested directly — but unreachable through the real pipeline: `grid` declares `capabilities.ports: false` and no host fallback places ports (DD-06 §4 covers labels and routing, not ports), so `LayoutResult.nodes[id].ports` is never populated end to end. Found during Stage F's accessibility pass. | unassigned — whichever stage next reconsiders `ports: false` for `grid`, or ships a port-aware engine |
| **F7** | The paint-only `<style>`-swap property (DD-07 §11, DD-08 §3) does not hold, for two independent reasons verified against the committed goldens. (a) `s-`/`t-`/`p-{paintHash}` class names (`style.ts`) embed the paint hash, so a paint change changes every referencing element's `class` attribute, not just the `<style>` block — fixable by keying the class name on something theme-invariant instead, which is a DD-07 §6 class-naming-scheme change (would churn every golden), not pulled here. (b) independently, a directed edge's arrowhead marker bakes its stroke colour into a `<defs>` `fill` and into the marker's own `id` (`markers.ts`), so `marker-end`/`marker-start` references change too — this needs a different marker strategy or a `context-stroke` rewrite (both currently rejected: resvg lacks `context-stroke`, Safari support arrived late), not just a class rename. DD-08 §3 is corrected to describe a full re-render instead of a `<style>`-only swap; the code is unchanged. | Stage I |
| **F8** | `<style>` content is XML-escaped by `render()` (every golden carries `&apos;Segoe UI&apos;` in the font stack). For a standalone `.svg` this is verified correct — XML parses style content as character data and decodes entities, confirmed by the injection suite. For DD-08 §6's `innerHTML` path it should *also* be correct — `style` is not in HTML's foreign-content breakout list, so inside `<svg>` the parser treats it as a foreign element and never enters the RAWTEXT state, meaning entities decode there too — but that is spec reading, not a live-browser result, and no browser target exists yet (`apps/web` is not started) to prove it. If the reading is wrong, every multi-word font family silently degrades in the live view only, not in exports. | Stage I, to verify once `apps/web` runs |
| **F9** | The paint-only theme-switch budget. **Renegotiated 2026-09-23 (human decision):** from a flat `< 16 ms` to **`< 16 ms` up to 500 nodes and `< 50 ms` at 2 000 nodes, measured in Chromium** (hard ceilings 50 / 100 ms), in [01 §4.1](01-requirements.md) and DD-09 §2 together. The basis: Stage H measured `render()` alone (`packages/render-svg/test/browser/render.bench.browser.test.ts`, median of 15, Chromium / Firefox) at n50 **1.1 / 2.0 ms**, n500 **8.9 / 15–16 ms**, n2000 **33.8–41.3 / 54 ms** — a flat 16 ms held only at the small end, because F7 makes a theme toggle a full `render()` plus `innerHTML` swap. **Still open:** the `innerHTML` swap on top of `render()` is unmeasured. Clear this row when Stage I measures `render()` + swap at 50/500/2 000 nodes in Chromium and it fits the new budget; if it does not, that is a new escalation, not a silent re-negotiation. Firefox at 2 000 nodes (54 ms for `render()` alone) is a watch item. | Stage I (part 2) |
| **F10** | `ctx.random`'s seed (`host.ts`'s `SEED = 1`) is one fixed constant, shared by every request for every document — `LayoutHost.run()`'s frozen signature has no per-call seed parameter, so Stage H could not add one unilaterally (DD-06 §3). Where a per-document seed should come from — a new `run()` parameter, or something content-addressed from a graph hash so the same document always seeds the same way without threading a value through every call site — is undecided, and is an orchestrator/design decision to make, not Stage H's to settle unilaterally. No engine shipped so far reads `ctx.random` at all (`grid` is fully deterministic; `elk` is unbuilt), so nothing depends on the answer yet. | Stage L (B5 `radial`/`force`, the first seed-consuming engines) |

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
**F7** (§2.1), and the property does not hold: paint class names embed `paintHash` and a directed
edge's marker id embeds its stroke colour, so a theme switch is a full re-render. Assert the geometry,
not the bytes.

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
| A8 variables, A9 imports | Pure resolver work. Replaces the Stage B placeholder diagnostic. Cycle detection for imports. **F3 (§2.1):** `compile()`'s `linearizeClasses` has no visited-set guard and relies entirely on `resolve()` having spliced every `@extends` back-edge first. Imports introduce a second way class tables get built — add the guard before, not after. |
| **A18 markdown labels + `@sgl/text`** | The largest non-engine subsystem. The `Measurer` is run-based already, so this is an addition, not a rewrite. |
| B5 `fixed`, `tree`, `radial`, `force` | `fixed` first — about a day, and the escape hatch people ask for. `force` last, and it is the first thing to cut. |
| C5 `high-contrast`, `print` themes | Tokens only. |
| D6/D7 PNG and clipboard export | Canvas `drawImage` of the SVG blob. |
| F2 drag-and-drop, F5 `.sglpack` | Conveniences on F1. |
| E17 multiple documents | Storage is already a list; this is UI. |

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
