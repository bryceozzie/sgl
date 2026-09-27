# DD-13 — In-app help: the Help drawer, the help page and the reference

**Feature:** E19 (in-app help and reference), **Must (human decision 2026-09-27)**; requirement
FR-E11. **Packages:** `apps/web` (the drawer, the page, the reference builder, the content
compiler, the previews), with small exports from `@sgl/core`, `@sgl/theme` and `@sgl/render-svg`.
**Inputs:** the compiler's own registries and catalogue, and hand-written Markdown in
`apps/web/help/`. **Outputs:** a Help drawer, a help page at `#help/…`, and a generated reference
module that E6 (autocomplete) can reuse later.

**Status: design only (2026-09-27), from `main` at `4432974`. No code is changed by this document.**
**Implementation:** branch 1, `feat/help-reference`, is implemented (§13, with its deviations).
**Human decisions (2026-09-27): every §14 recommendation was accepted, HD1–HD6.** The human also
settled §17: `@style` with a value that is not an object warns `SGL2011` (branch 0,
`fix/style-shorthand`, §13), and the spec and 01 were corrected to match the code on this branch.
The decisions are numbered **P1–P47**. Each has a recommendation and a one-line reason in italics.
Decisions marked **⚑** went to the human; §14 gives each one's options and the decision. Decisions D1–D4 below are
the human's and are binding. Where this document changes another document, the change is listed in
§16 and made by the branch that implements it. The exceptions are the new rows in 01 and 04, the
DD-00 index row and §15's factual fix, all made on this branch.

**The request, in the human's words:** "Need documentation in the browser to be able to lookup @
keys, see examples and lookup basic information."

**The human's decisions (2026-09-27), binding:**

- **D1, placement.** A Help drawer in the app for quick lookup, plus a separate help page in the
  app for more detail. No editor hover or tooltip integration.
- **D2, source.** Facts that live in code are generated from code: key names, types, where a key
  applies, defaults, allowed values, engines and their options, shapes, theme tokens, the
  diagnostics catalogue. Prose and examples are hand-written. Every example is checked by a test:
  it compiles with no unexpected diagnostics, and it renders.
- **D3, examples.** Short snippets per key and per topic, each with a rendered preview and an
  "Open as new document" action. "Insert" is optional (this document recommends against it, ⚑2).
- **D4, priority.** A Must for v1.0. Gate 4 requires it.

---

## 1. Summary

| Part | Recommendation | Where | Cost (gz, estimate) |
|---|---|---|---|
| Help button, `#help` route check, open-example callback | Boot path, the only boot cost | `App.tsx`, `toolbar/HelpButton.tsx` | **~0.4 kB** |
| Reference (generated facts) | Built at run time from the registries the app already bundles; no prose | lazy `reference` chunk | ~2–3 kB |
| Help UI: drawer, page, search, entry view, previews | Preact components; the preview runs the real pipeline in a second layout worker | lazy `help` chunk + `help-*.css` | ~8–10 kB JS, ~1.5 kB CSS |
| Prose and examples | Markdown in `apps/web/help/`, compiled at build time to a typed tree | lazy `help-content` chunk | ~20–40 kB |
| Help page | A view inside the SPA at `#help/<kind>/<name>`, not a second HTML entry (⚑1) | same chunks | 0 more |

The core bundle is **175.99 of 182 kB**. B5 plans to use ~3.2 kB of that (DD-12 §11), which leaves
~2.8 kB. Help's ~0.4 kB leaves ~2.4 kB. Every help chunk is precached, so help works offline. There
is **no CSP change** and **no new dependency**.

---

## 2. What is true today (found while designing this)

- **The registries exist and are mostly data.** `CONFIG_REGISTRY` (`packages/core/src/config-registry.ts`)
  holds each key's scope, type, enum and canonical order. DD-02 §7 already says it should drive
  "validation, autocomplete (E6), documentation, and `toJson` ordering". `CATALOGUE`
  (`diagnostics.ts`), `LAYOUT_CATALOGUE` and `IMPORT_CATALOGUE` hold every diagnostic's severity
  and template. The style-property `REGISTRY` (`@sgl/theme`) holds each property's type, enum,
  what it applies to and whether it affects geometry. `BUILT_IN` holds the four themes and their
  tokens. The engine descriptors (`@sgl/layout-elk/descriptor`, `@sgl/layout-std/descriptor`)
  carry `optionsSchema`, `hintsSchema` and defaults. The layout-api contract says hints are
  "declared so hints get validation, autocomplete and generated docs".
- **Some facts are in code but are not exported:** `CONFIG_REGISTRY` and `LANGUAGE_SHAPES` are
  not exported from `@sgl/core`. `DRAWABLE_SHAPES` is.
- **Some facts are in code but not as data:**
  - the `@shape` default (`'rect'`, a literal in `compile.ts`);
  - the `@a11y` sub-keys the renderer reads (`label` and `description`, literals in
    `render-svg/src/index.ts`);
  - the port sides (`SGL3007`'s check);
  - `@extends` and `@edges`, which the resolver special-cases and which have no registry row.
- **Defaults for most keys are not facts at all.** "Absent" means "no effect" (`@hidden`,
  `@link`), or the default comes from the theme (`@style.*`) or the engine (`@direction`).
- **The layout host runs one request at a time.** A second `run()` supersedes the first
  (`createWorkerHost`, `host.ts`). A help preview therefore cannot share the editor's host
  without aborting the editor's layout (P25).
- **The app's hash is a share channel.** `watchShareLinks` handles every `hashchange` by loading
  the `share` chunk and decoding. `decodeShareFragment('#help/key/pin')` gives `none` (no `s=`),
  so a help hash is already harmless, but it costs a chunk load per navigation (P42).
- **The app never calls `parse` itself** (a lint rule, DD-08 §4). Only `pipeline.ts` may. A
  preview needs a pipeline that takes a source string, not an editor tree (P24).
- **A18's inline parser** (`@sgl/core/inline`, `parseInline`) reads `**bold**`, `*italic*`,
  `` `code` `` and line breaks, and nothing else. Help prose needs headings, paragraphs, lists,
  fenced code, tables and internal links too (P12).
- **Several spec examples did not do what they said** (§17). The worst: `@style: dashed` is accepted
  and silently ignored. It is in the app's own first-run example. By human decision it becomes
  `SGL2011` (§13, branch 0), and the spec examples are corrected on this branch.

---

## 3. Content model

### 3.1 What the reference contains

- **P1. Eight categories.** In drawer order:
  1. **Quick start.** One page: write a node, an edge, a container, a label, a class, pick an
     engine and a theme, share.
  2. **Language topics.** Nodes, edges, containers, paths, wildcards, strings, markdown labels,
     classes, variables, imports, layout and engines, themes and styling. Diagnostics get an
     overview topic too.
  3. **`@` keys.** Every registry row, plus `@extends` and `@edges`. When B5 lands, `@pin`.
  4. **Style properties.** Every `@style.*` property.
  5. **Shapes.** Every shape name, marked drawn or not drawn yet.
  6. **Layout engines.** Every registered engine, with its options and hints.
  7. **Themes and tokens.** Every built-in theme and every token.
  8. **Diagnostics.** Every code.

  *These are what a user types, and what the app says back.*
- **P2. Help documents only what this build does.** Spec §7 selectors (`@rules`), `@icon`
  (C10), `force` and anything else unimplemented get no entry. The drift test (§4) enforces this:
  an entry for a key the registry does not know fails. *A reference that describes the roadmap is
  wrong on the day it ships.*

### 3.2 Entry identity

- **P3. Every entry has an id `<kind>/<name>`.** The id is the deep-link path (§6), the join key
  (§3.5) and the search target:

  | Kind | Name | Example id |
  |---|---|---|
  | `topic` | a slug | `topic/wildcards` |
  | `key` | the key without `@`; a sub-key is dotted | `key/size.maxWidth`, `key/label` |
  | `style` | the property name | `style/strokeDash` |
  | `shape` | the shape name | `shape/cylinder` |
  | `engine` | the bare engine name (DD-12 N22) | `engine/elk` |
  | `option` | engine and option | `option/elk.direction` |
  | `theme` | the theme id | `theme/print` |
  | `token` | the token name | `token/surface.sunken` |
  | `diag` | the code | `diag/SGL2010` |

  *A key's name is already a dotted path in the language; reusing it keeps the link readable.*

### 3.3 What is generated, and from where

- **P4. The reference is built at run time, in the browser, from the modules the app already
  bundles.** `apps/web/src/reference/build.ts` exports `buildReference(engines)`: a pure,
  DOM-free function with no prose. It returns a `Reference` (P6). It is the lazy `reference`
  chunk. *Importing the registries themselves means the facts cannot drift: there is no copy to
  go stale. Nearly all of the data is already in the boot bundle, so the chunk holds only the
  builder.*

  | Generated fact | Source module | Field |
  |---|---|---|
  | Keys: name, scopes, type, enum, canonical order | `@sgl/core` `config-registry.ts` | `CONFIG_REGISTRY[].key/scope/type/enum/order` (**export needed**) |
  | Structural keys `@extends` (class), `@edges` (canonical JSON) | `@sgl/core` | new `STRUCTURAL_KEYS` (P5) |
  | `@size` sub-keys | `@sgl/core` | `SIZE_KEYS` |
  | `@style` sub-keys: type, enum, applies to, geometry or paint, inherits | `@sgl/theme` `registry.ts` | `REGISTRY[]` |
  | Dash keywords for `strokeDash` | `@sgl/theme` `cascade.ts` | `DASH_PATTERNS` (keys only) |
  | Style defaults per role (node, container, edge, text) | `@sgl/theme` | `BUILT_IN[DEFAULT_THEME_ID].rules` and `.byShape` |
  | `@a11y` sub-keys | `@sgl/render-svg` | new `A11Y_KEYS` (P5) |
  | Port sides | `@sgl/core` | new `PORT_SIDES` (P5) |
  | `@shape` default | `@sgl/core` | new `DEFAULT_SHAPE` (P5) |
  | Shapes; drawn or not drawn yet | `@sgl/core` | `LANGUAGE_SHAPES` (**export needed**), `DRAWABLE_SHAPES` |
  | Engines: id, bare name, name, determinism, capabilities | the descriptors, through `REGISTERED_ENGINES` (`io/app-boot.ts`) | `id`, `name`, `capabilities` |
  | Engine options: name, type, enum, minimum, default | the same | `optionsSchema.properties`, `defaults` |
  | Engine hints (`@layout.<hint>` on a node) | the same | `hintsSchema.properties` |
  | Themes: id, name, `extends`, `force` | `@sgl/theme` | `BUILT_IN` |
  | Tokens and each theme's value | `@sgl/theme` | `BUILT_IN[id].tokens`, following `extends` |
  | Diagnostics: code, severity, template, stage (from the range) | `@sgl/core` | `CATALOGUE`, `IMPORT_CATALOGUE` |

  The engine list is passed in, not imported, because which engines exist is the app's choice
  (`REGISTERED_ENGINES`). *This keeps the builder portable to a CLI or an LSP (G12) later.*
- **P5. Five small exports make facts that are in code into data.**
  - `@sgl/core`:
    - export `CONFIG_REGISTRY` and `LANGUAGE_SHAPES`;
    - add `DEFAULT_SHAPE = 'rect'` and use it in `compile.ts`;
    - add `PORT_SIDES` and use it in `SGL3007`'s check;
    - add `STRUCTURAL_KEYS`: `[{ key: 'extends', scope: ['class'], type: 'array' }, { key: 'edges', scope: ['node'], type: 'array', canonicalOnly: true }]`, beside the registry.
  - `@sgl/render-svg`: add `A11Y_KEYS = ['label', 'description']` and use it in `a11yLabel` and
    `a11yDescription`.

  Each constant is used by the code that already holds the literal. *A constant the code does not
  use would be a copy, and a copy can drift. Together they cost a few bytes at boot (§9).*
- **P6. The generated shape.** One immutable, sorted object, for help and for E6 (§10):

  ```ts
  interface Reference {
    readonly keys: readonly KeyFact[];         // registry rows + structural keys, sorted by canonical order
    readonly styles: readonly StyleFact[];     // REGISTRY order
    readonly shapes: readonly ShapeFact[];     // { name, drawn, themeDefaults? }
    readonly engines: readonly EngineFact[];   // { id, bareName, name, determinism, capabilities, options: OptionFact[], hints: OptionFact[] }
    readonly themes: readonly ThemeFact[];     // { id, name, extends, forces }
    readonly tokens: readonly TokenFact[];     // { name, values: Record<themeId, string> }
    readonly diagnostics: readonly DiagFact[]; // { code, severity, template, stage }
  }
  interface KeyFact {
    readonly id: string;                        // 'key/size.maxWidth'
    readonly key: string;                       // 'size.maxWidth' (written '@size.maxWidth')
    readonly scopes: readonly ('root' | 'node' | 'edge' | 'class')[];
    readonly type: ConfigKeySpec['type'];
    readonly values?: readonly string[];        // enum, dash keywords, port sides, engine names
    readonly default?: string | number | boolean; // only where code holds one (P7)
    readonly subKeys?: readonly string[];       // ids of the sub-key entries
  }
  ```

  Sub-keys are entries of their own: `key/size.maxWidth`, `key/a11y.label` and `key/style.fill`,
  where the last is the same entry as `style/fill`, under two ids. *People search for
  `maxWidth`, not for "the size object".*
- **P7. A default is shown only where code holds one.** Examples: `@shape`'s `DEFAULT_SHAPE`, an
  engine option's schema `default`, a style property's value in the default theme's rules (shown
  as "neutral-light: node `strokeWidth` 1.5"). Elsewhere the prose says what "absent" means, and
  no test checks it. *A default typed into prose is exactly what D2 forbids.*
- **P8. "Applies to" is generated from the registry's scopes, in the spec's words.** `root` is
  "the document root"; `node` is "nodes and containers"; `edge` is "edges"; `class` is "class
  bodies". Where the registry and spec §4's table disagree, help shows the registry, because that
  is what the build accepts. §17 lists the disagreements for the human.

### 3.4 What is hand-written, and where it lives

- **P9. Markdown files in `apps/web/help/`, compiled at build time.** The layout:

  ```
  apps/web/help/
    quickstart.md
    topics/<slug>.md            # one topic per file
    keys/<key>.md               # one per top-level key; its sub-keys are sections in it
    styles.md  shapes.md  themes.md
    engines/<bare-name>.md      # the engine, then one section per option and hint
    diagnostics/<n>xxx.md       # one file per range, one section per code
  ```

  *Files near what they describe keep reviews small. Diagnostics are one-liners, so sections
  suit them better than sixty files.*
- **P10. An entry is a heading carrying its id:** `## Maximum width {#key/size.maxWidth}`. Its
  body runs to the next heading of the same or a higher level that carries an id. Rules for a
  body:
  - The **first paragraph is the summary.** It is shown in search results and in the drawer's
    compact view, and it must be at most 200 characters (a test checks).
  - An optional `Aliases: dashed line, dash` line adds search terms.
  - An optional `See also:` line holds links.
  - A file may hold many entries.
- **P11. Examples are fenced blocks with an info string:**

  ````
  ```sgl example title="Wrap a long title" engine=elk expect=SGL3006 contains="<tspan"
  api: { @label: "A long title that wraps", @size: { maxWidth: 120 } }
  ```
  ````

  | Attribute | Meaning |
  |---|---|
  | `example` | A whole document. It is previewed and tested (§5). |
  | `snippet` | A fragment, shown without a preview. Tested to parse with no `SGL1xxx`. |
  | `title` | The caption; required on an `example`. |
  | `engine` | A bare engine name. Absent means the default engine, `elk` (P27). |
  | `expect` | Diagnostic codes the example must produce, a multiset; absent means none. |
  | `contains` | A string the rendered SVG must contain (P22). |
  | `preview=false` | No preview. Allowed only with an `expect` that says why. |

  The id is `<entry id>#<n>`: the example's position in its entry. *The example sits beside the
  prose it illustrates, where a reviewer reads both.*
- **P12. The Markdown subset, and what A18's parser lacks.** `parseInline` is reused **as is**
  for runs: bold, italic, code. This way help text follows exactly the rules users learn for
  labels. What help needs on top of it, all handled by the build-time compiler
  (`apps/web/build/help-content.ts`):
  - **Blocks:** headings `#` to `###` with `{#id}`; paragraphs, whose single newlines are joined
    into spaces before `parseInline` sees them, since for labels a newline is a break;
    unordered and ordered lists, two levels deep; fenced code; GFM pipe tables with no inline
    HTML; `> **Note.**` blocks.
  - **Links:** `[text](#help/<id>)` only. The compiler splits links out first and passes the
    text around them to `parseInline`. A link whose id does not exist fails the build.
  - **Everything else fails the build:** raw HTML, images, external or bare URLs, and a heading
    without an id deeper than `###`. It is never passed through as literal text.

  *A build error is better than a quietly literal `<b>`. Unlike labels, this text is ours.*
- **P13. The compiler's output is a typed tree, not HTML.** A `HelpDoc` holds entries of
  `{ id, title, summary, aliases, seeAlso, blocks }`. Each block is one of `heading`,
  `paragraph(runs)`, `list(items)`, `code(lang, tokens)`, `table(rows)`, `note(blocks)` or
  `example(ExampleSpec)`, and a run is `TextRun | { link: id, runs }`. It is emitted as a virtual
  module, `virtual:sgl-help-content`, imported only by the `help-content` chunk. *Preact renders
  a tree as elements; nothing is ever parsed as markup at run time (§11).*
- **P14. Code is highlighted at build time.** The compiler parses each `sgl` fence with
  `@sgl/core`'s grammar and `@lezer/highlight`'s `highlightTree`, with the same tags as the
  editor. It stores `[class, text]` tokens. *Nothing about parsing runs at run time, so the lint
  rule "the app never calls parse" (DD-08 §4) holds, and no code runs per render.*

### 3.5 How the two are joined

- **P15. `joinHelp(reference, content)`** (in the `help` chunk) returns the entry table.
  - **Generated only:** a `Reference` fact with no hand-written entry. For kinds where prose is
    required, this is a test failure (§4). It never happens in a build that passed its tests.
  - **Hand-written only:** a `topic` entry, or the quick start.
  - **Both:** a fact with its prose. The view shows the generated facts panel first (P16), then
    the prose and examples.
- **P16. The facts panel is generated, always.** For a key, it shows: written as (`@size.maxWidth`),
  applies to, type, values, default, sub-keys, and the diagnostics it can cause. That last list
  is hand-written as a `Diagnostics:` line and checked (P19). The prose never repeats a fact in
  the panel; a test rejects a key entry whose prose contains a table titled "Values". *The
  panel is what cannot drift; the prose is what explains.*

---

## 4. The no-drift guarantee

All in Node, under the `unit` project, in `apps/web/test/`. They run `joinHelp(buildReference(REGISTERED_ENGINES), compileHelp(files))`,
the same functions the app runs.

- **P17. Coverage, `help-drift.test.ts`.**
  1. Every generated fact of kind `key`, `style`, `shape`, `engine`, `option`, `theme` and `diag`
     has a hand-written entry (⚑4 decides `diag`). The failure names each missing id and the file
     it belongs in. Tokens and hints need no prose: they are listed in their theme or engine
     entry.
  2. Every hand-written entry of a generated kind names a fact that exists. So an entry for
     `@icon`, for a removed key or for a renamed option fails.
  3. Every link target, `See also:` target and `Diagnostics:` code exists.
  4. Every inline code span in prose that looks like a key (`` `@name` `` or `` `@a.b` ``) is a
     known key or a known token (tokens are written `@accent` too). Spans inside a `> **Wrong.**`
     note are exempt, for deliberate counter-examples.
  5. No two entries share an id, and every summary is at most 200 characters.
- **P18. Examples, `help-examples.test.ts`.** For each `example`:
  - it runs through **the app's own pipeline** (`createHarness`, `apps/web/test/harness.ts`),
    extended to register every engine the worker registers, in process through
    `runHostSequence`, under its engine;
  - under each of the four built-in themes, the multiset of diagnostic codes equals `expect`;
  - `lastGood` is non-null (it rendered), unless `preview=false`;
  - `contains`, if given, is in the SVG;
  - a second run gives the same SVG (DD-00 §3);
  - an example with a root `@layout` must set `engine` (P27).

  Each `snippet` must parse with no `SGL1xxx`. *The pipeline the user sees, not a parallel one;
  `StaticMetricsMeasurer` makes it deterministic in Node, as for every golden.*
- **P19. Diagnostics cross-check.** A code listed in an entry's `Diagnostics:` line must be one
  that entry's examples, or the corpus, can emit: the test looks it up in the existing coverage
  gate's table (`diagnostics-coverage.test.ts`). Where ⚑4 applies, each `diag` entry for a code a
  document can cause (every code not in `NOT_YET_REACHABLE`) has an example whose `expect`
  includes it. *So the example for `SGL2010` is proved to cause `SGL2010`.*
- **P20. The generated shape, `reference.test.ts`.**
  - Every `CONFIG_REGISTRY` row appears once, and so does every structural key.
  - Every option default equals its descriptor's `defaults`.
  - `drawn` equals `DRAWABLE_SHAPES`.
  - The token table equals `resolveTheme` over `BUILT_IN`.
  - The diagnostic count equals `CATALOGUE` plus `IMPORT_CATALOGUE`.
  - The output is sorted and identical across two runs.
- **P21. Order with B5.** `feat/b5-pin` adds the `@pin` row, and `feat/b5-fixed`/`tree`/`radial`
  add engines. Whichever of help or B5 merges second writes the missing entries: P17 fails until
  it does. *That is the guarantee working.*
- **P22. What the tests cannot prove.** That a preview shows what the prose claims.
  Until branch 0, `@style: dashed` rendered cleanly and drew a solid line (§17 item 1). An example whose point
  is a visual effect should carry `contains=` (for example `contains="stroke-dasharray"`), and
  reviewers check the rest.

---

## 5. Examples and previews

- **P23. Rendered live, in the browser, under the current theme.** Not pre-rendered at build
  time. *A build-time SVG would be measured by a different measurer (Node has no canvas and no
  Inter) and would not follow the theme the user picked. A live preview is also the real
  pipeline, which D3 asks for.*
- **P24. The preview pipeline is `createPipeline`, the editor's own.** It gets the same
  measurer, the same `engineSchemas`, `loadRichText` and `loadImports`, `debounceMs: 0`, and its
  own host (P25). `Pipeline` gains **`loadSource(source)`**, which parses in `pipeline.ts`, the
  one module allowed to. It is fed one example at a time. The SVG is read from `lastGood`, and
  the preview's own diagnostics from `diags`. *It is the same code as the editor, so a preview
  cannot disagree with what "Open as new document" then shows.*
- **P25. A second layout worker, only for help.** `createAppWorkerHost(measurer)` is called again,
  lazily, on the first preview. It is disposed 60 s after the last help surface closes. *The
  host runs one request at a time and a new one supersedes the old (§2), so sharing it would
  abort the editor's layout. Multiplexing the host is a protocol change that nothing else needs.*
- **P26. Rendering is lazy and sequential.** An `IntersectionObserver` queues examples as they
  scroll into view. One renders at a time. Results are cached in memory by
  `(example id, effective theme, engine)`, least recently used, 64 entries. A theme switch
  re-renders visible previews: each is paint only, the fast path. *A topic may hold a dozen
  examples, and the user sees two.*
- **P27. The engine of a preview** is the example's own, from `@layout.engine` or the `engine=`
  attribute, which must agree. Otherwise it is **`elk`, the default engine**, and never the
  picker's current engine. The caption names it: "elk · neutral-dark". *Examples are tested
  under one engine; under `fixed` every unpinned example would warn (SGL4020, DD-12 H1), and
  under `grid` an `@layout` option would warn (SGL4010).*
- **P28. What a preview shows.** A `<figure>` holding the SVG, fitted to the column (at most
  240 px high in the drawer, 480 px on the page), with `<figcaption>`: the title, the engine and
  theme, and a count of the preview's diagnostics if any (expected ones are labelled
  "expected"). The code sits above it, with **Copy** and **Open as new document**. The SVG goes
  in through `innerHTML` of a wrapper: it is `render()` output, the trust DD-09 §1.1 already
  grants `lastGood.svg`. While it renders, a fixed-size placeholder shows, so nothing shifts.
- **P29. Cost** (estimates, to be measured by the drawer branch; F15 has yet to measure elk in the
  browser):
  - a small example (up to 15 nodes): parse to style under 1 ms, pre-measure 1–3 ms, layout
    2 ms under `grid` and 10–40 ms under `elk`, render and `innerHTML` about 1 ms;
  - the first preview spawns the worker (~30–50 ms);
  - the first `elk` preview loads elkjs into it (~300–600 ms, from the precache);
  - the second worker's memory is ~30–60 MB with elkjs loaded; it is freed by the disposal in
    P25.

  The main thread is busy only for pre-measure and `innerHTML`, a few ms per example, so typing
  in the editor is unaffected.
- **P30. "Open as new document"** calls `openExample(source, engineId)`, a callback `App` passes
  in. It is `openRecord(view, newRecord(source), true)` with `engineId` set to the preview's
  engine and `themeId` set to the current theme. That is DD-08 §7's path for Open: the open
  document's pending autosave is flushed, a new record is stored and made `lastOpenDocId`, and the
  editor gets a fresh undo history. The toast reads "Opened the example as a new document. Your
  previous document is in Documents." The source is the example **verbatim**, with no comment or
  `@title` added. *What the test checked is what the user gets; the title comes from the first
  key as for any document.* From the drawer, the drawer stays open and focus stays on the button.
  From the page, the page closes and focus goes to the editor, since the user asked to go there.
- **P31. Copy** writes the source to the clipboard with `navigator.clipboard.writeText` on the
  click, and toasts. *The clipboard is already written to on a click (D7); this adds no
  capability.*
- **P32. ⚑2 "Insert": recommend no, for v1.0.**
  - An example is a whole document. Its root keys (`@layout`, `@classes`, `@vars`) pasted into
    the middle of a container become `SGL2012` warnings, and a second `@classes` merges
    (`SGL2005`). So "Insert" would need rules for where things go, and those would be a feature
    of their own.
  - It is the editor integration D1 excluded, by another route.
  - Copy plus paste does the same with the user in charge of where the text lands, and editor
    undo covers it.

---

## 6. The Help drawer

- **P33. Opening it.** A **Help** button at the right end of the toolbar (`?` glyph plus the text
  "Help"), with `aria-expanded` and `aria-controls`. It toggles the drawer. The first open loads
  the `reference`, `help` and `help-content` chunks together; a spinner shows until they land
  (they are precached, so it is milliseconds). There is no global keyboard shortcut (⚑5).
- **P34. Where it sits.** A third column to the right of the canvas, 380 px wide. The canvas
  narrows and keeps its viewport; Fit is not re-run. Below 900 px, where the panes stack
  (DD-08 §2), the drawer overlays the lower pane at full width. It is an `<aside
  aria-labelledby>` (a complementary landmark), **not a dialog**, and it is not modal.
- **P35. Home view.** A search box. Under it, while the query is empty, the eight categories
  (P1) as collapsible sections of entry links, with Quick start first and open.
- **P36. Search.** Fuzzy, in-house, with no dependency. The index is built once from the joined
  entries: each id's name, its written form (`@size.maxWidth`), the title, aliases, summary words
  and the diagnostic code.
  - **Scoring:** a case-insensitive subsequence match, which must match. Bonuses: an exact
    match, a prefix, a match at a word boundary (after `.`, `@`, `-`, a digit run or a camelCase
    hump), and consecutive characters. Summary words weigh less. A leading `@` in the query is
    ignored, so `maxw` finds `@size.maxWidth` and `2010` finds `SGL2010`.
  - **Results:** grouped by category, best first, at most 50, updated on every input (a few
    hundred entries score in well under 1 ms). A polite `role="status"` line says "12 results",
    or "No results for …".
- **P37. Keyboard.** The pattern is Save ▾'s: plain controls, no ARIA roles the controls don't
  implement (DD-08 §7).
  - Results are a `<ul>` of buttons. Down from the search box moves to the first result, Up and
    Down move between results, and Up from the first returns to the box. This is roving focus
    only, with no listbox or combobox roles.
  - Enter or click opens the entry in the drawer. Its heading takes focus (`tabindex="-1"`). A
    "← Results" button goes back and restores the query and the focused result.
  - Escape in a non-empty search box clears it. Escape anywhere else in the drawer closes the
    drawer, and focus returns to the Help button.
  - The × button closes it too.
- **P38. One entry, compact.** The drawer shows the title, the facts panel (P16), the summary,
  the first example with its preview, and **"More in the help page →"** (`#help/<id>`). The
  whole prose and every example are on the page. *Quick lookup in the drawer, detail on the
  page, as D1 asks.* A topic in the drawer shows its prose in full: topics are short by content
  rule (at most about 600 words; a test warns, it does not fail).
- **P39. Never steal focus.**
  - Focus moves only because of a user action in help (a click, Enter or Escape there), or when
    the Help button opens the drawer. Nothing else moves it: not a chunk loading, not results
    updating, not a preview finishing, not a theme switch.
  - A pointer-down outside the drawer does **not** close it, unlike the disclosures, so the user
    can click into the editor and type with help open.
  - Opening the drawer never scrolls or resizes the editor.
  - `e2e/help.spec.ts` types in the editor while previews render and asserts that focus and the
    text are unchanged.
- **P40. Stays open across document switches.** The drawer is app state, not document state. It is
  not stored: a reload starts it closed, unless ⚑6 applies.

---

## 7. The help page

- **P41. ⚑1 A view inside the SPA, at `#help/<id>`.** When `location.hash` starts with `#help`,
  `App` renders `<HelpPage>` in place of the panes and the diagnostics panel. The editor and the
  canvas stay mounted but `hidden`, so undo history, the viewport and the pipeline are untouched.
  The toolbar stays.
  - `#help` alone is the page's home: the categories in full, and an A–Z index.
  - Inside the page, every link pushes a history entry, so the browser's Back works within
    help. **Back to editor** returns to where the user came from: `history.back()` when the page
    was opened from inside the app, otherwise `replaceState` to the bare path.

  The alternative weighed, a second HTML entry (`help.html`), is rejected:
  - it needs its own copy of the pipeline bootstrap, measurer and worker wiring for previews;
  - "Open as new document" from another tab would write to storage behind the open app's back,
    the multi-tab problem F12 is about;
  - D1 says "in the app".
- **P42. Deep links.** The grammar is `#help(/<kind>/<name>)?`, for example `#help/key/pin`,
  `#help/diag/SGL2010`, `#help/topic/wildcards`. `<name>` is percent-decoded and matched against
  the id table only. It is never rendered as markup. An unknown id shows the home with the notice
  "No help entry `key/nope`", as a text node.
  - **Coexistence with share links:** a help hash has no `s=`, so `decodeShareFragment` gives
    `none` (a test pins it). `watchShareLinks` gets a one-line prefix check that skips `#help`
    before importing the `share` chunk.
  - A share link opened while the help page is showing reloads and imports exactly as today.
- **P43. The page view of an entry.** A left column with the category tree (sticky, collapsible
  under 900 px). The main column holds the facts panel, all the prose, and every example with its
  preview. The breadcrumb is category › entry, and "See also" follows. Focus goes to the page's
  `<h1>` (`tabindex="-1"`) when the page opens or its entry changes: the editor is hidden then,
  so this takes nothing from it. The page's top-level landmark is `<main>`.
- **P44. Printing.** A print stylesheet in `help-*.css`, active while the page shows: the toolbar,
  the side tree, buttons and placeholders are hidden; previews print as vector SVG;
  `break-inside: avoid` applies on examples; links print their title only. Two index entries,
  `#help/keys` and `#help/diagnostics`, show every key or every code in full on one page, for
  printing the reference. A **Print** button calls `window.print()`.
- **P45. Offline.** The page is the SPA, so `navigateFallback: 'index.html'` already serves it,
  and the hash never reaches the network. The three help chunks and `help-*.css` are precached by
  the existing `globPatterns` (DD-08 §12). Previews use the precached worker, `elk`, `std-trees`
  and `rich-text` chunks.

---

## 8. What is in the boot path

- `toolbar/HelpButton.tsx`: the button, the lazy import of the `help` chunk (which imports
  `reference` and `help-content`), and the mount point.
- In `App.tsx`:
  - the `#help` check at boot and on `hashchange`, which renders `<HelpPage>`;
  - the `openExample` callback (§5);
  - the P42 prefix check in `watchShareLinks`.
- If ⚑3 is accepted, a "Help" link on each diagnostics-panel row (`#help/diag/<code>`).
- If ⚑6 is accepted, the first-visit check.

Nothing else. The reference builder, the search, the entry views, the previews and all content
are lazy.

---

## 9. Bundling and budget

- **P46. Four new lazy files, all precached, all excluded by name in `.size-limit.js`:**
  `reference-*.js`, `help-*.js`, `help-content-*.js` and `help-*.css`.
  - `check-core-chunks.mjs` fails if any of them is reachable from the entry.
  - It also fails if the boot chunk contains a sentinel string: the quick start's first heading.
  - `e2e/pwa.spec.ts` already fails if an emitted file is missing from the precache.
  - `e2e/offline.spec.ts` gains a help case.

  Estimates, gzipped. Each branch measures its real cost and stops if a line is more than 50%
  over.

  | Item | Boot | Lazy |
  |---|---|---|
  | Help button, lazy import, mount point | ~0.20 | — |
  | `#help` route check, `openExample`, share prefix check | ~0.12 | — |
  | P5 exports and constants (export names; the constants replace literals) | ~0.03 | — |
  | ⚑3 diagnostics-row link | ~0.05 | — |
  | ⚑6 first-visit check | ~0.03 | — |
  | **Boot total** | **~0.4 (stop at 0.6)** | |
  | `reference`: the builder | | ~1.5–2 |
  | `IMPORT_CATALOGUE` rows (shared with `imports`, or duplicated) | | ~1 |
  | `help`: drawer, page, search, markdown tree renderer, previews, actions | | ~8–10 |
  | `help-*.css`, with print | | ~1.5 |
  | `help-content`: ~25 key files, ~12 topics, ~60 codes, ~80 examples (~120 kB raw) | | ~20–40 |

  Core: 175.99 now, ~179.2 after B5, **~179.6 of 182 after help**, which leaves ~2.4 kB. The
  precache grows by ~35–55 kB compressed (~180 kB raw). The limit is the human's; this plan fits
  under it without asking for a raise.

---

## 10. Shared data with E6 (autocomplete)

- **P47. `Reference` is E6's data, as is.** A future completion source (a lazy `autocomplete`
  chunk; E6 is Should) imports `buildReference` from the `reference` chunk and never the prose.
  From it:
  - `keys[].scopes` filters by where the cursor is: root, node, edge or class body;
  - `values` completes enums, shapes, dash keywords and engine names;
  - `engines[].options` completes `@layout` keys for the effective engine;
  - `tokens` completes `"@…"` strings;
  - `styles` completes `@style.*`.

  A completion's `info` can link to `#help/<id>`. The summaries (P10) are in `help-content`, so
  E6 decides later whether to load that chunk for completion details. *One generated source, two
  consumers. This is DD-02 §7's intent.* **Not designed here:** E6's trigger rules, ranking,
  paths from the `DocumentModel`, and the CodeMirror extension.

---

## 11. Security

- **Help prose is our own text, compiled at build time into a typed tree and rendered by Preact
  as text nodes and elements.** There is no `innerHTML`, no `dangerouslySetInnerHTML` and no
  run-time Markdown parser. Raw HTML, images and external URLs in the Markdown fail the build
  (P12).
- **Links are internal only** (`#help/<id>`, checked at build time). There are no `href`s to
  other origins, so nothing needs `rel` hygiene. If external links are ever wanted, that means an
  `https:` allowlist and `rel="noopener noreferrer"`, and it is a new decision.
- **Previews** put `render()` output into a wrapper with `innerHTML`, exactly as the canvas does
  with `lastGood.svg` (DD-09 §1.1, first row). The source is a first-party example, and it goes
  through the same escaping path as any document.
- **Deep-link names** are matched against the id table and never rendered as markup (P42). A
  crafted `#help/<script>…` shows the home and a text notice.
- **"Open as new document"** stores only first-party example text, through the Open path.
  **Copy** writes to the clipboard only on a click.
- **CSP: no change.**
  - The chunks are `'self'` scripts.
  - The second worker is the same `'self'` worker script (`worker-src 'self' blob:`).
  - Previews are inline SVG, whose `<style>` needs the `'unsafe-inline'` that the canvas
    already has.
  - Nothing is fetched cross-origin.

  `e2e/csp.spec.ts` opens the drawer and the page, and renders previews, with no violation. No
  CSP change is needed, so none is flagged.
- **DD-09 §1.1 gains one row** (§16): help content and previews add no capability beyond the
  canvas's.

---

## 12. Tests

- **Unit (Node, `apps/web/test/`):**
  - `help-content.test.ts`, for the compiler:
    - every block and inline form;
    - runs equal `parseInline`'s for the same text;
    - soft line joins;
    - build errors for HTML, images, external or bare URLs, an unknown or duplicate id, an
      unclosed fence, and an unknown fence attribute;
    - highlight tokens for an `sgl` fence;
  - `reference.test.ts` (P20);
  - `help-drift.test.ts` (P17, P19);
  - `help-examples.test.ts` (P18);
  - `help-search.test.ts`:
    - `pin` puts `key/pin` first, `maxw` gives `key/size.maxWidth`, `2010` gives
      `diag/SGL2010` and `dash` gives `style/strokeDash`;
    - a leading `@` is ignored;
    - an empty query shows the categories;
    - results are stable for equal scores (sorted by id);
  - `help-route.test.ts`: parsing and formatting `#help/…`; percent-decoding; unknown ids;
    `decodeShareFragment('#help/key/pin')` is `none`;
  - `pipeline.test.ts`: `loadSource` renders like `setDocument` with the same text, and the
    lint rule still holds.
- **Browser (`help-preview.browser.test.ts`, Chromium):** a preview through the real
  `CanvasMeasurer` and a real second worker gives the same SVG as the main pipeline for the same
  source, engine and theme.
- **End to end (`e2e/help.spec.ts`, Chromium):**
  1. Help opens the drawer and focus is in search. Escape closes it and focus is on Help.
  2. With the drawer open, typing in the editor keeps focus and text while previews render
     (P39), and a click in the editor does not close the drawer.
  3. Search `maxw`, then Down and Enter, opens `@size.maxWidth`, and the facts panel shows its
     type and where it applies.
  4. The entry's preview renders an SVG. A theme switch re-renders it in the new theme.
  5. Open as new document:
     - Documents ▾ lists a new document;
     - the editor holds the example exactly;
     - the toast shows;
     - the previous document is unchanged.
  6. A deep link to `/#help/key/label` in a fresh context shows the page. Back to editor shows
     the editor with the last document. The browser's Back from an in-page link returns to the
     previous entry.
  7. An unknown deep link shows the home and the notice.
  8. Print: `emulateMedia({ media: 'print' })` hides the toolbar and shows the entry and its SVG.
  9. A share link opened while the help page shows still imports as today.
- **Existing specs extended:**
  - `offline.spec.ts`: with the HTTP cache emptied, reload `/#help/topic/wildcards` offline; the
    page and a preview render, and the help chunks come from the service worker.
  - `csp.spec.ts`: the drawer, the page and previews, with no violation.
  - `pwa.spec.ts`: covered already.
- **Size:** `pnpm size` passes. `check-core-chunks.mjs` enforces P46.

---

## 13. Implementation plan

Reviewable branches, in order. Each is one reviewer's work, and each passes the full clean check.

0. **`fix/style-shorthand`** (human decision 2026-09-27, §17 item 1). Small, and independent of
   the rest.
   - `CONFIG_REGISTRY`'s `style` row: type `any` → `object`. A `@style` that is not an object (a
     bareword, a string, a number, an array, or a `$var` holding one) is then `SGL2011`
     ("`@style` expects object; ignored.") and is dropped. Dotted keys (`@style.fill: …`) are
     unchanged. The comment in `config-registry.ts` that calls `dashed` a valid shorthand is
     rewritten.
   - `corpus/checkout.sgl`, `corpus/chains.sgl` and `apps/web/src/examples/checkout.sgl`:
     `@style: dashed` → `@style: { strokeDash: "6 3" }` (`6 3` is `DASH_PATTERNS.dashed`).
   - A corpus fixture that emits `SGL2011` for `@style: dashed`, so the code has a document that
     reaches it (Gate 1's rule).
   - Goldens: the `checkout` and `chains` render goldens are **re-baselined** under all four
     themes, because those edges now draw dashed, as intended. Their AST, resolve and compile
     goldens change only where the source text changed. No other golden may move.
   - An e2e check that the first-run example shows no diagnostics and that its `async` edge has
     a `stroke-dasharray`.
   - DD-02 §7: the `style` row's type, and the paragraph that calls `dashed` a bareword
     shorthand.
1. **`feat/help-reference`.**
   - The P5 exports and constants, each used by the code that held the literal. No behaviour
     changes, and no golden moves.
   - `apps/web/src/reference/` (`buildReference`, types).
   - `reference.test.ts`.
   - Boot delta measured (~0.03 kB).

   **Implemented** on `feat/help-reference` (from `main` at `ca9956e`). No golden moved; boot
   +54 B gzipped (176.05 kB of 182). The builder is imported by nothing yet;
   `apps/web/test/reference-boot.test.ts` fails if the entry or the layout worker reaches
   `src/reference/` by static imports, until branch 4 names `reference-*.js` in `.size-limit.js`
   and `check-core-chunks.mjs` takes over. `reference.test.ts` covers P20, plus a test that
   building never freezes the source tables. Deviations and gaps filled:
   - **`STRUCTURAL_KEYS` is its own module**, `packages/core/src/structural-keys.ts`, not rows in
     `config-registry.ts`, so B5's registry rows cannot conflict with it. `resolve.ts` matches on
     its `EXTENDS_KEY` and `EDGES_KEY`.
   - **`@edges`' scope is `['root', 'node']`,** not `['node']`: the resolver accepts it at the root,
     where `toJson` writes the root's edges.
   - **`DEFAULT_SHAPE` lives in `ids.ts`** beside `DRAWABLE_SHAPES`; `@sgl/render-svg` already had
     one, which is now a re-export of core's rather than a second copy.
   - **`REGISTERED_ENGINES` gains `capabilities`** (P4 names them; the list lacked them).
   - **An `EngineFact`'s `id` is the help id** (`engine/elk`), like every other fact's; the engine id
     is `engineId` (`sgl.elk`).
   - **Hints have ids `hint/<engine>.<name>`,** a kind P3 lacks: `grid` has `columns` both as an
     option and as a hint. Hints need no prose (P17), so the drift test can ignore the kind.
   - **`key/layout.engine` is a sub-key fact** whose values are the registered engine ids, the one
     `@layout` key the app reads itself. When `feat/b5-pin` makes bare names valid there, its
     values should follow.
   - **`@style`'s `subKeys` are the `style/<name>` ids.** P6's second id, `key/style.fill`, is an
     alias for `joinHelp` (branch 2) to resolve, not a second fact.
   - **Additions to P6's types:** `written` (`@size.maxWidth`) on keys, styles, options and tokens;
     `parent`, `structural` and `canonicalOnly` on keys; `default` flags on the default shape and
     theme; `@theme`'s values are the built-in theme ids; style facts carry the default theme's
     values per role (P7) as `defaults`; options carry `types`, `values`, `minimum` and `default`.
2. **`feat/help-content`.**
   - The compiler (`apps/web/build/help-content.ts`) and the `virtual:sgl-help-content` Vite
     plugin.
   - `joinHelp`.
   - `help-content.test.ts`, `help-drift.test.ts` and `help-examples.test.ts`, with the harness
     extended to every registered engine.
   - Content for `key`, and the quick start.

   The drift test's enforced kinds start as `key`.
3. **`feat/help-content-2`.**
   - Content for `style`, `shape`, `engine` and `option`, `theme`, and `diag` (per HD4); all the
     topics.
   - The enforced kinds become all of them.

   Prose only, plus tests, so it is easy to review by reading.
4. **`feat/help-drawer`.**
   - `HelpButton`, the drawer, search, the entry view, `Pipeline.loadSource`, the preview host
     and queue, Copy, Open as new document.
   - `.size-limit.js`, `check-core-chunks.mjs`.
   - `help-search.test.ts`, `help-preview.browser.test.ts`, e2e 1–5, the CSP and offline cases.
   - HD3's diagnostics-row link and HD6's first visit.
5. **`feat/help-page`.**
   - The `#help` route and the page view, deep links, Back, print CSS, and the `#help/keys` and
     `#help/diagnostics` indexes.
   - The `watchShareLinks` prefix check.
   - `help-route.test.ts`, e2e 6–9.
6. **`docs/help`.**
   - The §16 changes to DD-08, DD-09, DD-10 and 07.

B5's branches and these can interleave. Whichever merges second writes the missing entries
(P21).

---

## 14. ⚑ Decisions for the human (all accepted, 2026-09-27: HD1–HD6)

Only choices D1–D4 did not settle. Every recommendation was accepted; each item records the
decision.

- **⚑1. What the help page is.**
  - (a) A view inside the SPA at `#help/<kind>/<name>` (**recommended**).
  - (b) A separate `help.html` entry with its own bundle.

  *(a) shares the pipeline, the precache and the Open path, and keeps "Open as new document" in
  the same tab. The URL format becomes a promise: links into help should keep working.*

  **HD1. Human decision 2026-09-27:** (a), an in-app view at `#help/<kind>/<name>`.
- **⚑2. "Insert".**
  - (a) No; offer Copy instead (**recommended**, P32).
  - (b) Yes: insert at the cursor as one undoable transaction.

  *An example is a whole document, so inserting its root keys mid-document causes warnings and
  merges. Insert is also editor integration, which D1 excluded.*

  **HD2. Human decision 2026-09-27:** (a), Copy, not Insert.
- **⚑3. A "Help" link on each diagnostics-panel row** (`#help/diag/<code>`), opening the drawer
  at that code.
  - (a) Yes (**recommended**).
  - (b) No.

  *It is the moment a user most needs help. It is a link in the panel, not an editor hover, and
  costs ~0.05 kB at boot.*

  **HD3. Human decision 2026-09-27:** (a), a Help link on each diagnostics row.
- **⚑4. How much each diagnostic gets.**
  - (a) Required prose for every code: what it means and how to fix it. For every code a
    document can cause, an example that is proved to cause it (**recommended**, P19).
  - (b) Generated only: the severity and message template.

  *(a) is about 60 short entries of work. The message templates already say what happened, but
  rarely what to do next.*

  **HD4. Human decision 2026-09-27:** (a), prose for every diagnostic code, plus a proved example for each code a document can cause.
- **⚑5. A keyboard shortcut to open help.**
  - (a) None in v1.0; the Help button is in the tab order (**recommended**).
  - (b) F1, which Chrome and Firefox bind to their own help and which cannot be reliably
    overridden.
  - (c) A chord such as Alt+Shift+H.

  *Every free chord collides with a browser, an OS or CodeMirror somewhere. Add one when users
  ask for it.*

  **HD5. Human decision 2026-09-27:** (a), no keyboard shortcut.
- **⚑6. First visit.**
  - (a) On a first visit only (no stored documents), open the drawer at Quick start without
    moving focus, and remember that it was shown (**recommended**).
  - (b) Never open it by itself.

  *Lee, the casual user, meets the language first. Focus stays where the page put it, so nothing
  is stolen. It costs ~0.03 kB at boot and one lazy load on first visit only.*

  **HD6. Human decision 2026-09-27:** (a), a first visit opens the drawer at Quick start without moving focus.

---

## 15. Factual fixes made in other documents on this branch

1. **DD-08 §12, "What the list above names, concretely":** "Both themes and the example
   document" now reads "The four built-in themes and the example document". C5 made it four.

**Spec and 01 corrections, by human decision 2026-09-27 (§17 items 1–7).** Made on this branch:

2. **Spec §3 and §9:**
   - every `@style: dashed` → `@style: { strokeDash: "6 3" }`;
   - §3's edge `@width: 2` → `strokeWidth: 2` inside that `@style`;
   - §9's canonical `"strokeDash": "4 3"` → `"6 3"`.
3. **Spec §4, the `@style.*` row:** a `@style` that is not an object is `SGL2011` and ignored.
   The row also names the dash keywords.
4. **Spec §6:** `"@surface.raised"` → `"@surface"`, a token every built-in theme has.
5. **Spec §4, "Applies to":** follows the registry for `@hidden`, `@a11y.*`, `@meta.*`, `@label`,
   `@shape`, `@ports` and `@layout.*`. A new sentence says the column follows the registry.
6. **Spec §4:** `@a11y.role` and `@icon` are marked **not in v1.0**.
7. **01:** FR-Y8's `layered` → `elk`. §6 criterion 1 now says five built-in engines.

---

## 16. Changes to other documents (made by the implementing branches)

- **01 §3.6** FR-E11 and **04 §E** E19: added on this branch, marked "Must (human decision
  2026-09-27)". The DD-00 index row too.
- **DD-08:**
  - §2 sketch: the Help button and the drawer column;
  - §3: `Pipeline.loadSource`;
  - a new §16, "Help", pointing here;
  - §12 precache list: the help chunks.
- **DD-09:**
  - §1.1: one row. Help content and previews add no capability beyond the canvas's.
  - §2 core bundle row: the four help files join the list of lazy chunks.
- **DD-10 §2:** the lazy help chunks and the `virtual:sgl-help-content` plugin.
- **DD-02 §7:** "documentation" now names DD-13's `buildReference`, and the P5 constants. Branch 0
  changes the `style` row's type to `object` and drops the paragraph calling `dashed` a
  shorthand.
- **07:** a Stage L row for E19, with branches as §13; the orchestrator's to add.

---

## 17. Contradictions found while designing this

**The human resolved all of them on 2026-09-27.** Items 1–7 are fixed in the spec and 01 on this
branch (§15). Item 1's code, corpus, example and goldens are branch 0 (§13).

1. **`@style: <keyword>` does nothing.**
   - These treat `@style: dashed` as valid: spec §3 (`api -> db: { …, @style: dashed, … }`),
     spec §9's worked example and its canonical form, `corpus/checkout.sgl`, `corpus/chains.sgl`,
     the app's first-run example (`apps/web/src/examples/checkout.sgl`) and the comment in
     `config-registry.ts` ("a bareword like `dashed` is a valid shorthand").
   - The cascade ignores any `@style` that is not an object (`styleSetFromConfig`, `cascade.ts`)
     and gives no diagnostic. The registry types `style` as `any`, so there is no `SGL2011`.
     `checkout.sgl`'s render golden draws the `async` edge solid.
   - Spec §9's canonical form also shows `"strokeDash": "4 3"`. That is neither what
     canonicalisation does (it leaves values as written) nor the `dashed` pattern (`6 3`).
   - **For the human (spec):** either (a) make `@style: <dash keyword>` mean
     `@style.strokeDash: <keyword>`, or (b) warn with `SGL2011` and fix the spec, the corpus and
     the example. Until then, help documents only the object form.
   - **Human decision 2026-09-27: (b), warn and fix the docs.** A `@style` that is not an object
     is `SGL2011` and ignored, and every example becomes `@style: { strokeDash: "6 3" }`.
2. **Spec §3, `@width: 2` on an edge,** is not a key: it is `SGL2010`. It should be
   `@style.strokeWidth`.
3. **Spec §6 uses the token `"@surface.raised"`.** No built-in theme defines it: it gives
   `SGL5005` and the magenta fallback. The built-in tokens are `bg`, `surface`, `surface.sunken`,
   `ink`, `ink.muted`, `line`, `accent`, `danger` and `font.sans`.
4. **Spec §4's "Applies to" disagrees with the registry.** Help follows the registry (P8).

   | Key | Spec §4 | Registry |
   |---|---|---|
   | `@hidden` | any | node, edge |
   | `@a11y.*` | any | node, edge |
   | `@meta.*` | any, which the spec says excludes the root | every scope including the root |
   | `@label` | node, edge, container | also class |
   | `@shape`, `@ports` | node | also class |
   | `@layout.*` | any | `layout`: root, node; `layout.*`: node, edge |
5. **Spec §4 lists `@a11y.role`,** but the renderer reads only `label` and `description`.
6. **Spec §4 lists `@icon`** ("see backlog"; C10 is a Should) as a key. The registry has no row,
   so it is `SGL2010`. Help leaves it out (P2).
7. **01 FR-Y8 still names `layered`,** which H7 renamed `elk`. **01 §6 criterion 1** still says
   "all six built-in engines", although `force` is cut (B22). **Fixed on this branch (human
   decision 2026-09-27).**
8. **DD-02 §7 says the registry drives "documentation",** but it has no defaults, sub-keys or
   descriptions. P5 and P7 say where each of those comes from. This is not a conflict, only a gap
   that this document fills.
