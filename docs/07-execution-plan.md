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
order dependence, anywhere below `apps/web`. Lint bans the first two. **Every stage that produces
output adds a double-run test**: run twice, assert byte-identical `JSON.stringify` or string output.

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
| `@sgl/theme` — `resolveTheme`, `styleGraph`, geometry/paint hashes | **Done**, tested against hand-built fixtures | `main` |
| `@sgl/measure` — `premeasure`, three `Measurer`s, run keys | **Done**, tested against hand-built fixtures | `main` |
| `@sgl/render-svg` — shapes, style block, markers, text, `render()` | **Implementation only, no tests** | `feat/renderer` |
| `@sgl/core` — `parse()`, `buildAst`, grammar fixes | **Done**, T1+T2 gate green | `main` |
| `@sgl/core` — `resolve()`, `toJson`/`fromJson`, config-key registry | **Done**, T1+T2 gate green | `feat/resolver` |
| `@sgl/layout-api` — shape anchors for the routing fallback | **Fragment only** | `feat/grid-engine` |
| `compile`, `grid`, worker host, `apps/web` | **Not started** | — |

Both grammar defects tracked in the README (quoted `@`-keys, `$name` as a
`Variable` token) are fixed and Stage A's gate passed on `main`. Stage B found
one more, upstream of the resolver: `build-ast.ts` had a `ConfigEntry`/`Property`
value-builder switch with no `'Variable'` case, so `$name` lexed as a
`Variable` token but was silently **dropped** rather than reaching the AST —
`@style.stroke: $hot` resolved to no `style` key at all, not to a value worth
a diagnostic. Fixed on `feat/resolver` (`buildValue`/`buildVariable` in
`build-ast.ts`) since Stage B's own gate needs it; `feat/parser`'s original
gate still passes unchanged, as it never asserted on this path.

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

**Gate — T1 + T2.**
- **Bitwise determinism** — `grid` declares `'bitwise'`, the strictest class in ADR-0004. Lay out every
  corpus document twice; assert byte-identical. This is the engine's exit criterion in DD-00 §6.
- Every non-hidden node and edge has geometry and every number is finite (DD-09 §3.3 invariant 5).
- `validateResult` rejects each malformed shape with the right code.
- Layout goldens for the corpus, committed.

**Out of scope.** The worker host (Stage G). The elk adapter (Stage J). Ports — `grid` declares
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
   `graph.order`.
5. Reconcile two known discrepancies with DD-07 §8 and update the document: the implementation collapses
   `escText`/`escAttr` into one function, and allows only `https:`/`mailto:` where §8 also lists `http:`
   and in-document `#n-…`. Decide which is right; the language spec §4 currently agrees with the code.
6. Double-run identical.

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

**Gate — T1 + T4 (partial).** Playwright: MVP acceptance criteria **1, 2 and 3**. Criterion 2 is the
visible half of what Stage G already proved — assert the SVG tree is untouched and only the `<style>`
block changes.

---

### Stage J — Files, share and offline · `feat/app-files`

**Goal.** Documents survive leaving the page.

**Depends on.** Stage I.

**Read.** DD-08 §7–§9 · DD-10 §5

**Tasks.** Open/save `.sgl`, `.sgl.json`, `.txt`; IndexedDB autosave with storage as a keyed list from
day one so multi-document (E17) is later UI only; URL-fragment share via
`CompressionStream('deflate-raw')` + base64url with a size cap; `vite-plugin-pwa` precaching the shell,
both engines and both themes; `file_handlers` for `.sgl`; the `_headers` CSP from DD-09 §1.2.

**Gate — T4 complete.** Playwright covers all six MVP criteria, including the offline run and a share
link opening in a fresh browser context.

---

> ### ▛ Gate 3 — MVP
>
> The six acceptance criteria in [06 §3](06-feasibility-and-mvp.md#mvp-acceptance), automated in CI,
> plus **T5** by hand once: a golden opened in Inkscape, Figma and Safari; the PWA installed; a `.sgl`
> opened from the OS.
>
> Deployable. This is the phase-1 exit in [04](04-feature-backlog.md).

---

### Stage K — The elk adapter · `feat/layout-elk`

**Goal.** The default engine (ADR-0005), and the proof that two engines sit behind one interface.

**Depends on.** Gate 3.

**Read.** DD-06 §6 · ADR-0005 · 06 §4 pitfalls 7 and 8

**Tasks.** Adapt `elk.bundled.js` — the **synchronous single-thread build**, because elkjs's own worker
build would nest a worker inside our worker and cost two serialisation hops. Pin
`org.eclipse.elk.randomSeed: 1`. Map the IR to ELK's graph and the result back, taking labels and
container titles **from ELK** rather than from the host fallback. Lazy-load it as its own chunk,
excluded from the core bundle budget.

**Gate — T2 + T3 + a size check.**
- Every corpus document lays out; labels and container titles come from ELK, asserted, not from the
  fallback.
- MVP acceptance criterion 1: a 40-node three-level document renders under **both** engines and
  switching changes geometry only.
- `determinism: 'quantized'` — two runs identical *after* quantization (ADR-0004).
- Boundary-crossing edges from `corpus/containers-edges.sgl` render without artefacts. This is where
  ELK's own tracker is busiest; if `ORTHOGONAL` misbehaves, `POLYLINE` is one option away.
- `size-limit` on the core chunk: under 180 kB gz, hard ceiling 300. Wire it into CI here.

---

### Stage L — The rest of Must · `feat/*` per item

**Depends on.** Gate 3. Individually orderable; each is its own branch and its own T1+T2 gate.

| Item | Notes |
|---|---|
| A8 variables, A9 imports | Pure resolver work. Replaces the Stage B placeholder diagnostic. Cycle detection for imports. |
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

---

## 7. Keeping this document honest

Update §2 in the same commit that changes the state of the build. Add a stage when work appears that
does not fit one. When a gate turns out to be unfalsifiable — green while something is visibly broken —
fix the gate, in this document, before continuing.
