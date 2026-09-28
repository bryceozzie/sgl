# DD-10 — Build and Deploy

---

## 1. Repository layout

```
.
├── package.json                 # pnpm workspace root; scripts only
├── pnpm-workspace.yaml          # packages/*, apps/*
├── tsconfig.base.json           # strict, ES2022, moduleResolution bundler, isolatedModules
├── corpus/                      # shared fixtures (DD-09 §3.2)
├── bench/                       # perf harness
├── packages/
│   ├── core/                    # @sgl/core       — grammar, parser, resolver, IR, diagnostics, editor support
│   ├── theme/                   # @sgl/theme
│   ├── text/                    # @sgl/text       — runs, faces, the table key, the line models (A18, DD-11)
│   ├── measure/                 # @sgl/measure
│   ├── layout-api/              # @sgl/layout-api — contract, host, fallbacks, validation, conformance
│   ├── layout-elk/              # @sgl/layout-elk
│   ├── layout-std/              # @sgl/layout-std — grid (MVP)
│   └── render-svg/              # @sgl/render-svg
├── apps/
│   └── web/                     # the SPA
└── .github/workflows/ci.yml
```

`@sgl/plugin-sdk`, `@sgl/cli` and `apps/worker` are **⟶ later phases**; their directories are not created until they have code. (`@sgl/text` was listed here until A18 created it, DD-11 T2.)

---

## 2. Package build

Every `packages/*`:

- `tsdown` → `dist/index.js` (ESM) + `dist/index.d.ts`. No CJS. `"type": "module"`, `"exports": { ".": "./dist/index.js" }` plus subpath exports where a package has a second entry (`@sgl/core/editor`, `@sgl/layout-api/conformance`).
- `"sideEffects": false` so the app bundle tree-shakes.
- Workspace dependencies via `workspace:*`; the app consumes built `dist/` in CI and source via Vite aliases in dev for HMR.

`apps/web`: Vite, Preact preset, `vite-plugin-pwa`. Manual chunks: `elk`, `grid`, `editor` (CodeMirror), `app`. The layout worker is a `new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })` so Vite bundles it and dynamic `import()` of engine chunks inside it works.

**Settled by Stage K.** (1) **The `elk` chunk holds elkjs only**, not the "`@sgl/layout-elk` + `elkjs` pair": a manual chunk reached by a static import is loaded eagerly, and `@sgl/layout-elk`'s own code *is* imported statically — its descriptor by the main thread's pickers (`@sgl/layout-elk/descriptor`), its mapping by the worker. Only `elkEngine.layout()`'s dynamic `import('elkjs/lib/elk.bundled.js')` reaches elkjs, so the chunk stays lazy: 1 439.76 kB raw, ≈ 436.5 kB gzipped, imported only by the worker (`e2e/pwa.spec.ts` checks), and precached (J1). (2) **The worker builds as an ES module** (`worker: { format: 'es' }` in `vite.config.ts`, with the same elk-only manual chunk): Vite's default worker format, `iife`, cannot code-split, so elkjs would otherwise be inlined into the worker.

**Lazy chunks other than `elk`** (each a dynamic `import()`, named after its module, excluded from the core chunk by name in `.size-limit.js`, and precached like everything else): **`share-*.js`** (`state/share.ts` + `base64url.ts`, F9 fix round 1) — loaded by Share and by a link with a payload; **`file-actions-*.js`** (`toolbar/file-actions.tsx` + `state/files.ts` + `state/filename.ts` + `io/download.ts`, A8 follow-up, ≈ 4.6 kB raw, ≈ 2.2 kB gzipped) — the work behind Open, Save ▾ and Share. The toolbar's buttons, the hidden file input and the `Ctrl/⌘+O` binding stay in the boot path (`toolbar/FileMenu.tsx`), so the picker opens on the first press inside the user's gesture; Open and `Ctrl/⌘+O` start loading the chunk as the picker opens, the file is read with it once picked, Save ▾ and Share load it when used, and the launch queue loads it through the same Open path. What the boot path needs of file naming (`documentTitle`, `FALLBACK_TITLE`, `OPEN_ACCEPT`) is `state/title.ts`. **`engine-options-form-*.js`** (`toolbar/engine-options-form.tsx` + `state/engine-form.ts`, A8 fix round 2) — the Options ▾ form: fields, labels, edit rules; loaded the first time Options ▾ is opened and kept mounted. What boot needs of it — each engine's defaults and normalisation, `optionsForEngine` for every layout request, `defaultOptionsFor` on an engine switch — stays in `state/engine-options.ts`, and `toolbar/EngineOptions.tsx` is the disclosure shell. `e2e/offline.spec.ts` checks all three chunks come from the precache offline.

**A18's entries and chunk** (DD-11 T3, T53; `feat/a18-text` and `feat/a18-render`). `@sgl/text` has two entries: `.` (types, run faces, the table key, `labelBox`, `layoutLines`; on the boot path, imported by `@sgl/measure` and `@sgl/render-svg`) and **`./wrap`** (`layoutWrapped`, the word breaker). `@sgl/core` gains **`./inline`** (`parseInline`, the markdown parser). The two lazy halves make one chunk, **`rich-text-*.js`** (`state/rich-text.ts`), loaded for the first document with markup in a label or a label to wrap, excluded from the core chunk by name in `.size-limit.js`, checked by `check-core-chunks.mjs` not to be reachable from the entry, and precached. `@sgl/render-svg/fonts` (D2's `embedFonts`, with A18's per-element face selection, T50) stays in the lazy `file-actions` chunk. The seven run faces A18 ships (Inter 700, Inter italic 400–700, IBM Plex Mono 400/700, T26) are WOFF2 assets imported by URL from `src/io/run-faces.ts`, which the `rich-text` chunk registers with the Font Loading API and `file-actions` lists for export; it is a chunk of its own, **`run-faces-*.js`**, excluded by name like the others. The boot CSS declares none of them.

**`@sgl/core` entries** (tsdown, bundle mode): `.` (`src/index.ts`), `./editor` (Stage I; the CodeMirror language support) and, since A8 fix round 2, **`./json`** (`src/json.ts`: `toJson`, `fromJson` and the canonical-JSON writers, DD-02 §6). Code the entries share goes into shared chunks (`dist/resolve-*.js`, `dist/sgl.parser-*.js`), so the app bundler can leave `json.js` in the lazy `file-actions` chunk, its only importer; one `dist/index.js` had kept the writers in the boot chunk. Reading `.sgl.json` needs none of it: boot parses stored, opened and shared documents as source.

**The layout worker bundles only the `SGL4xxx` catalogue rows** (A8 follow-up). `@sgl/layout-api` builds its diagnostics with `layoutDiagnostic()`, which reads `LAYOUT_CATALOGUE` (`packages/core/src/layout-diagnostics.ts`) alone; `CATALOGUE` spreads those rows in, so `diagnostic()` is unchanged everywhere else. The worker used to carry the whole catalogue (≈ 1.1 kB gzipped) through `diagnostic()`. `check-core-chunks.mjs` fails if a catalogue row outside `SGL4xxx` reaches the worker chunk or its static imports.

**F20: no new chunk; the boot path lost grid's layout code, and terser minifies.** (1) **`@sgl/layout-std/descriptor`** (`gridDescriptor`: id, name, capabilities, schemas) is `@sgl/layout-std`'s second entry, as `@sgl/layout-elk/descriptor` is for elk; `gridEngine` spreads it. The page imports only the descriptor (`REGISTERED_ENGINES`), so grid's packing code is in the layout worker alone; `check-core-chunks.mjs` fails if a boot chunk carries it (signature: its `grid: unknown scope` error) or the worker does not. The `grid` manual chunk still exists (the descriptor matches `layout-std`); as before, Rollup also places much of `@sgl/core` in it, since `manualChunks` takes a manual chunk's otherwise unassigned dependencies with it. (2) **JS minification is terser, not esbuild** (`apps/web/build/minify.ts`, `sglMinify()`): a `renderChunk` hook ordered `post` on the page and worker builds, with `build.minify: false` (so esbuild does not minify first) and `build.cssMinify: 'esbuild'` (CSS as before); `module: true`, `ecma: 2020`, two compress passes. The lazy `elk` chunk is minified by esbuild as before (terser takes ~45 s on elkjs). `terser` is a devDependency of `@sgl/web`, build time only. Core bundle 181.97 → **175.99 kB** (−1.00 kB, then −4.98 kB).

**B5's lazy `std-trees` chunk** (DD-12 N52, H9; `feat/b5-tree`). `@sgl/layout-std` has a third tsdown entry, `src/std-trees.ts` (`dist/std-trees.js`, not in `exports`): the layout code of `tree` (and of `radial` when it lands), with the spanning forest they share. Only `treeEngine.layout()`'s dynamic `import('./std-trees.js')` reaches it, and only the layout worker registers `treeEngine` (the page lists `treeDescriptor`), so the worker build emits it as **`std-trees-*.js`**, fetched on the first tree request. It is named after its module, like the page's lazy chunks, with **no `manualChunks` rule**: Rollup moves a manual chunk's static dependencies into it, so `@sgl/layout-api` followed and the worker imported the chunk statically (tried). `.size-limit.js` excludes it by name; `check-core-chunks.mjs` requires exactly one, holding tree's code (its `tree: unknown scope` error), not reachable from the page entry or the worker's static imports, not referenced by a boot chunk, and referenced by the worker. **Fix round 1:** that signature is one string of `tree.ts`, so a static import of `forest.ts` by the worker passed. The page and worker builds now record each chunk's modules (`apps/web/build/chunk-modules.ts`, written to `apps/web/node_modules/.sgl-build/chunk-modules.json`, outside `dist`); the check maps them to source files through the packages' `dist` source maps and requires every module of `STD_TREES_MODULES` (`forest.ts`, `tree.ts`; `radial` adds its own) in the `std-trees` chunk and every module that chunk carries in no other chunk. A graph whose chunk list is not `dist/assets`'s JS files is refused as stale. `generateSW` precaches it like every emitted chunk; `e2e/offline.spec.ts`'s criterion 5 switches to `tree` offline and requires the chunk from the service worker. 3.17 kB gzipped (7.32 kB raw); the boot cost of `tree` is its descriptor on the page and in the worker, the F11 rules and `lazyEngine` (+0.41 kB when measured on `9f47545`; +385 B over `main` at `9c543c8`, core 179.98 kB). **B5 branch 5 (`feat/b5-radial`)** puts `radial`'s layout code in the same chunk: `std-trees.ts` re-exports `layoutRadial`, and `radialEngine.layout()` imports the same module, so the worker still emits one `std-trees-*.js`. `STD_TREES_MODULES` adds `radial.ts` and `trig.ts`, and the check also requires radial's code in the chunk (its `radial: unknown scope` error) and in no boot or worker chunk. The chunk is now 4.71 kB gzipped (12.06 kB raw, Node's zlib; 3.67 kB for `tree` alone by that measure). `radial`'s boot cost is its descriptor on the page and in the worker, its F11 rules and its timeout row: +120 B (core 180.15 kB of 184; 180.18 kB after `main` at `707dd0c` was merged in). `e2e/offline.spec.ts`'s criterion 5 switches to `radial` offline too.

**B8's lazy `compose` chunk** (DD-14 C47; `feat/b8-wire`). The composer, `@sgl/layout-api/compose` (its own tsdown entry since `feat/b8-compose`), is loaded by the layout worker alone: `layout.worker.ts` passes `createWorkerRuntime` a loader, `() => import('@sgl/layout-api/compose')`, which runs on the first request whose document names a container engine, so the worker build emits it as **`compose-*.js`** (named after its module, no `manualChunks` rule, as `std-trees`). Keeping the composer's own dependencies off the worker's boot path took two changes in `@sgl/layout-api`, because Rollup assigns a whole module to one chunk: `describeShapeError`, which the runtime needs, moved out of `validate.ts` into `shape.ts` (re-exported), and a fourth tsdown entry, `@sgl/layout-api/worker` (the runtime and the registry), which the worker imports, makes tsdown put `validate.ts`, `bounds.ts` and `host.ts` in a dist chunk the worker's entry does not reach; the composer checks a box's result with `checkResult`, which builds no message, so neither the worker nor the compose chunk carries a catalogue row. Without these the worker grew 2.1 kB with nine rows. `.size-limit.js` excludes `compose-*.js`; `check-core-chunks.mjs` requires exactly one, holding the composer (its "resized by its parent's engine" detail), with no catalogue row, not reachable from the page entry or the worker's static imports, not referenced by a boot chunk, and referenced by the worker; and, from the module graph, `compose.ts` carried by that chunk and no other, and none of the chunk's modules (`compose.ts`, `validate.ts`, which the page's own chunks also carry, for the host's validation) carried by the worker's static chunks (a worker statically using `checkResult` fails it). `generateSW` precaches it; `e2e/offline.spec.ts` reloads a document with a container engine offline and requires the chunk from the service worker. 3.68 kB gzipped; the boot cost of B8 is `layoutPlan`, the scope-aware `@layout` checks, the `SGL4012` row and the plan's plumbing on the page, and the plan branch and the loader in the worker: +753 B over `main` at `707dd0c` (page +618 B, worker +135 B; core 180.82 kB of 184).

**The precache across an update (F12).** `vite-plugin-pwa`'s `generateSW` stays as configured (`registerType: 'prompt'`, `skipWaiting: false`, `clientsClaim: false`, `cleanupOutdatedCaches: true`): no Workbox option changed. Every emitted JS file has a content hash in its name, so a release that changes a chunk's code renames it, and the new worker's activation deletes the old name from the precache. The app handles that, not the build: an open tab on the old build follows the update by saving and reloading (DD-08 §12). Keeping old entries until no page uses them would need `injectManifest` and a hand-written worker; not done (DD-08 §12 says why).

---

## 3. Grammar generation

`packages/core/src/grammar/sgl.grammar` → `sgl.parser.js` + `sgl.parser.terms.js` via `@lezer/generator`, run as a `prebuild` script with `--strict` so grammar conflicts fail the build (DD-01 §8). The generated files are **committed** (so `git blame` and diffs on the parser are meaningful and so a checkout builds without the generator), and CI regenerates and fails if the committed output differs.

---

## 4. CI (`ci.yml`)

On every push and pull request:

```
install (pnpm, frozen lockfile)
lint         eslint + import-boundary rules (DD-00 §2) + sgl/no-nondeterminism
typecheck    tsc -b across the workspace
grammar      regenerate, diff must be empty
test:unit    vitest (Node) — core, theme, layout-api, render-svg, layout-std
test:browser vitest browser mode (Chromium, Firefox) — measure, layout-elk, host
test:e2e     playwright (Chromium, Firefox, WebKit) — apps/web
size         size-limit on the core chunk (< 184 kB gz since 2026-09-28, hard 300)       — implemented, Stage K
build        packages then app
audit        pnpm audit --prod (fails on high)
```

Nightly: `bench` against the targets in DD-09 §2, posting a comment on regressions over the hard ceiling.

**`size` (Stage K, K6).** `.size-limit.js` with `size-limit` + `@size-limit/file`; root script `pnpm size`, CI step right after `build`. "The core chunk" is the JS and CSS the initial page load fetches: the entry chunk and every chunk it imports statically (`editor`, `grid`), the CSS, and the layout-worker entry with its static imports — every emitted `assets/*.js`/`*.css` except `elk-*.js` — each gzipped and summed. Limit **182 kB** since 2026-09-26 (human decision, with A9: raised from 180 kB); the 300 kB hard ceiling is unchanged and not encoded; raising the limit is a human decision. Measured at Stage K: **174.63 kB**; after fix round 1: **175.33 kB**. A8 (variables) and F3 on `feat/variables`: `main` 179.76 kB → 181.40 kB with them → 179.22 kB after the worker's catalogue split (−0.86 kB) and the lazy `file-actions` chunk (−1.32 kB); A8 fix round 1 → 180.17 kB; fix round 2 → 179.72 kB with `@sgl/core/json` (−0.45 kB) → **178.63 kB** with the lazy `engine-options-form` chunk (−1.09 kB). A18 branch 2 (DD-11 T53): 180.38 → **181.22 kB**; its `rich-text-*.js` chunk (`@sgl/core/inline` and `@sgl/text/wrap`, 2.01 kB) is excluded as lazy, and `check-core-chunks.mjs` fails if the entry reaches it. New package entries: `@sgl/text` (`.` and `./wrap`) and `@sgl/core/inline`.

**Fix round 1.** (1) `size-limit` and `@size-limit/file` are pinned to **12.1.0**: 13.x declares Node `^22.18`, 14.x `^22.19 || ^24.5 || >=26` and uses `fs/promises`'s `glob`, and CI runs Node 20.19.0 (`.nvmrc`) with `engine-strict=true`; 12.1.0 (`^20 || ^22 || >=24`) was run under Node 20.19.0 itself (`npx -y node@20.19.0`) and passes, while 14.0.0 fails there with "does not provide an export named 'glob'". (2) A glob cannot see elkjs creeping into the boot path, so `pnpm size` then runs `apps/web/scripts/check-core-chunks.mjs`: it walks `index.html`'s entry by *static* imports and fails if any chunk it reaches references an `elk-*.js` chunk or contains elkjs's code, or if elkjs was emitted more than once (importing `@sgl/layout-elk` rather than `/descriptor` on the main thread does exactly that — measured: size-limit alone still passed at 178.71 kB). Since A8's follow-up it also walks the layout worker's chunk and fails if it carries any catalogue row outside `SGL4xxx`, or none at all (the pattern no longer matching). (3) Root `check` runs `pnpm size` after `build`, as CI does.

**The update e2e builds the app a second time (F12).** `apps/web/e2e/sw-update.spec.ts` needs two builds to test a service-worker update. The first is the suite's own `dist/` (`webServer`); in its `beforeAll` the spec runs Vite's JS `build()` with the app's own `vite.config.ts`, only the output names overridden (`assets/[name]-v2-[hash].js` for entries and chunks), into `apps/web/node_modules/.sgl-e2e-update/<worker>/`. That makes every page-side chunk URL of the first build disappear (the worker's build, with elk, is not renamed) from the second's precache, as a release does to any chunk whose code changed. The spec's own server (`e2e/static-server.ts`, `setRoot`) serves the first build, then the second. It adds about 25 s to the suite, runs in Chromium only, and needs no change to the production configuration.

Node LTS pinned in `.nvmrc`; browsers from Playwright's pinned set.

---

## 5. Deploy

**Cloudflare Workers with static assets** (ADR/06 §5), via `wrangler`:

```toml
# apps/web/wrangler.toml
name = "sgl-worker"
compatibility_date = "2026-09-01"
[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

`_headers` in `dist/`:

```
/*
  Content-Security-Policy: <DD-09 §1.2>
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/sw.js
  Cache-Control: no-cache
```

**Implemented (Stage J)**: `vite build` writes this file into `apps/web/dist/` from `apps/web/build/headers.ts` (held to the block above by `apps/web/test/headers.test.ts`), and `vite preview` serves the build with the headers it declares, so the e2e suite runs under them. **`wrangler.toml` is in place** (`apps/web/wrangler.toml`, the block above verbatim; `apps/web/test/headers.test.ts` holds it there too). The deploy itself is still a human step (decision J4): `wrangler login` once, then `pnpm cf:deploy` from the root, which builds the workspace and runs `wrangler deploy` in `apps/web`. `pnpm cf:dev` serves the same build under `wrangler dev` (workerd, `_headers` and the SPA fallback as deployed) on `http://localhost:8787`. **wrangler is not a workspace dependency**: 4.x declares Node `>=22`, and the workspace runs Node 20.19.0 (`.nvmrc`) with `engine-strict=true`, so a devDependency would fail `pnpm install` in CI. The `cf:*` scripts run it with `pnpm dlx`, pinned to an exact version (`apps/web/package.json`), and so need Node 22+ on the machine that deploys; CI and the lockfile are untouched. `.github/workflows/main.yml` is the production half of the pipeline below: it runs when CI completes green on `main` (or by hand), builds, and runs `pnpm --filter @sgl/web cf:deploy` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. The pull-request preview (`wrangler versions upload`) is not set up.

Pipeline: `main` → CI green → `wrangler deploy` to production. Pull requests → `wrangler versions upload` preview URL posted on the PR. No server-side code exists in MVP, so there is no second deployment unit; **⟶ G5** adds routes to the same Worker.

Cost at MVP: the free tier covers it entirely (static requests are unmetered).

---

## 6. Versioning and release

- `changesets` for package versions; all `@sgl/*` packages version in lockstep for MVP (one `major.minor.patch` across the workspace) — independent versioning starts when a third party depends on one of them.
- Release = tag + CI build + deploy + the manual gate from DD-09 §3.1 (Inkscape/Figma/Safari open, PWA install, OS file open).
- The `@sgl` language version (`"@sgl": "1.0"`) is **independent** of package versions and changes only on a breaking change to the document model (NFR-6).

---

## 7. Local development

```
pnpm i
pnpm dev            # vite dev server for apps/web, packages via source aliases
pnpm test           # unit + browser
pnpm e2e            # playwright
pnpm bench          # perf harness
```

`.claude/launch.json` carries the `dev` configuration for the in-app browser preview.
