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
│   ├── measure/                 # @sgl/measure
│   ├── layout-api/              # @sgl/layout-api — contract, host, fallbacks, validation, conformance
│   ├── layout-elk/              # @sgl/layout-elk
│   ├── layout-std/              # @sgl/layout-std — grid (MVP)
│   └── render-svg/              # @sgl/render-svg
├── apps/
│   └── web/                     # the SPA
└── .github/workflows/ci.yml
```

`@sgl/plugin-sdk`, `@sgl/cli`, `@sgl/text` and `apps/worker` are **⟶ later phases**; their directories are not created until they have code.

---

## 2. Package build

Every `packages/*`:

- `tsdown` → `dist/index.js` (ESM) + `dist/index.d.ts`. No CJS. `"type": "module"`, `"exports": { ".": "./dist/index.js" }` plus subpath exports where a package has a second entry (`@sgl/core/editor`, `@sgl/layout-api/conformance`).
- `"sideEffects": false` so the app bundle tree-shakes.
- Workspace dependencies via `workspace:*`; the app consumes built `dist/` in CI and source via Vite aliases in dev for HMR.

`apps/web`: Vite, Preact preset, `vite-plugin-pwa`. Manual chunks: `elk`, `grid`, `editor` (CodeMirror), `app`. The layout worker is a `new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })` so Vite bundles it and dynamic `import()` of engine chunks inside it works.

**Settled by Stage K.** (1) **The `elk` chunk holds elkjs only**, not the "`@sgl/layout-elk` + `elkjs` pair": a manual chunk reached by a static import is loaded eagerly, and `@sgl/layout-elk`'s own code *is* imported statically — its descriptor by the main thread's pickers (`@sgl/layout-elk/descriptor`), its mapping by the worker. Only `elkEngine.layout()`'s dynamic `import('elkjs/lib/elk.bundled.js')` reaches elkjs, so the chunk stays lazy: 1 439.76 kB raw, ≈ 436.5 kB gzipped, imported only by the worker (`e2e/pwa.spec.ts` checks), and precached (J1). (2) **The worker builds as an ES module** (`worker: { format: 'es' }` in `vite.config.ts`, with the same elk-only manual chunk): Vite's default worker format, `iife`, cannot code-split, so elkjs would otherwise be inlined into the worker.

**Lazy chunks other than `elk`** (each a dynamic `import()`, named after its module, excluded from the core chunk by name in `.size-limit.js`, and precached like everything else): **`share-*.js`** (`state/share.ts` + `base64url.ts`, F9 fix round 1) — loaded by Share and by a link with a payload; **`file-actions-*.js`** (`toolbar/file-actions.tsx` + `state/files.ts` + `state/filename.ts` + `io/download.ts`, A8 follow-up, ≈ 4.6 kB raw, ≈ 2.2 kB gzipped) — the work behind Open, Save ▾ and Share. The toolbar's buttons, the hidden file input and the `Ctrl/⌘+O` binding stay in the boot path (`toolbar/FileMenu.tsx`), so the picker opens on the first press inside the user's gesture; Open and `Ctrl/⌘+O` start loading the chunk as the picker opens, the file is read with it once picked, Save ▾ and Share load it when used, and the launch queue loads it through the same Open path. What the boot path needs of file naming (`documentTitle`, `FALLBACK_TITLE`, `OPEN_ACCEPT`) is `state/title.ts`. **`engine-options-form-*.js`** (`toolbar/engine-options-form.tsx` + `state/engine-form.ts`, A8 fix round 2) — the Options ▾ form: fields, labels, edit rules; loaded the first time Options ▾ is opened and kept mounted. What boot needs of it — each engine's defaults and normalisation, `optionsForEngine` for every layout request, `defaultOptionsFor` on an engine switch — stays in `state/engine-options.ts`, and `toolbar/EngineOptions.tsx` is the disclosure shell. `e2e/offline.spec.ts` checks all three chunks come from the precache offline.

**`@sgl/core` entries** (tsdown, bundle mode): `.` (`src/index.ts`), `./editor` (Stage I; the CodeMirror language support) and, since A8 fix round 2, **`./json`** (`src/json.ts`: `toJson`, `fromJson` and the canonical-JSON writers, DD-02 §6). Code the entries share goes into shared chunks (`dist/resolve-*.js`, `dist/sgl.parser-*.js`), so the app bundler can leave `json.js` in the lazy `file-actions` chunk, its only importer; one `dist/index.js` had kept the writers in the boot chunk. Reading `.sgl.json` needs none of it: boot parses stored, opened and shared documents as source.

**The layout worker bundles only the `SGL4xxx` catalogue rows** (A8 follow-up). `@sgl/layout-api` builds its diagnostics with `layoutDiagnostic()`, which reads `LAYOUT_CATALOGUE` (`packages/core/src/layout-diagnostics.ts`) alone; `CATALOGUE` spreads those rows in, so `diagnostic()` is unchanged everywhere else. The worker used to carry the whole catalogue (≈ 1.1 kB gzipped) through `diagnostic()`. `check-core-chunks.mjs` fails if a catalogue row outside `SGL4xxx` reaches the worker chunk or its static imports.

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
size         size-limit on the core chunk (< 182 kB gz, hard 300)       — implemented, Stage K
build        packages then app
audit        pnpm audit --prod (fails on high)
```

Nightly: `bench` against the targets in DD-09 §2, posting a comment on regressions over the hard ceiling.

**`size` (Stage K, K6).** `.size-limit.js` with `size-limit` + `@size-limit/file`; root script `pnpm size`, CI step right after `build`. "The core chunk" is the JS and CSS the initial page load fetches: the entry chunk and every chunk it imports statically (`editor`, `grid`), the CSS, and the layout-worker entry with its static imports — every emitted `assets/*.js`/`*.css` except `elk-*.js` — each gzipped and summed. Limit **182 kB** since 2026-09-26 (human decision, with A9: raised from 180 kB); the 300 kB hard ceiling is unchanged and not encoded; raising the limit is a human decision. Measured at Stage K: **174.63 kB**; after fix round 1: **175.33 kB**. A8 (variables) and F3 on `feat/variables`: `main` 179.76 kB → 181.40 kB with them → 179.22 kB after the worker's catalogue split (−0.86 kB) and the lazy `file-actions` chunk (−1.32 kB); A8 fix round 1 → 180.17 kB; fix round 2 → 179.72 kB with `@sgl/core/json` (−0.45 kB) → **178.63 kB** with the lazy `engine-options-form` chunk (−1.09 kB). A18 branch 2 (DD-11 T53): 180.38 → **181.22 kB**; its `rich-text-*.js` chunk (`@sgl/core/inline` and `@sgl/text/wrap`, 2.01 kB) is excluded as lazy, and `check-core-chunks.mjs` fails if the entry reaches it. New package entries: `@sgl/text` (`.` and `./wrap`) and `@sgl/core/inline`.

**Fix round 1.** (1) `size-limit` and `@size-limit/file` are pinned to **12.1.0**: 13.x declares Node `^22.18`, 14.x `^22.19 || ^24.5 || >=26` and uses `fs/promises`'s `glob`, and CI runs Node 20.19.0 (`.nvmrc`) with `engine-strict=true`; 12.1.0 (`^20 || ^22 || >=24`) was run under Node 20.19.0 itself (`npx -y node@20.19.0`) and passes, while 14.0.0 fails there with "does not provide an export named 'glob'". (2) A glob cannot see elkjs creeping into the boot path, so `pnpm size` then runs `apps/web/scripts/check-core-chunks.mjs`: it walks `index.html`'s entry by *static* imports and fails if any chunk it reaches references an `elk-*.js` chunk or contains elkjs's code, or if elkjs was emitted more than once (importing `@sgl/layout-elk` rather than `/descriptor` on the main thread does exactly that — measured: size-limit alone still passed at 178.71 kB). Since A8's follow-up it also walks the layout worker's chunk and fails if it carries any catalogue row outside `SGL4xxx`, or none at all (the pattern no longer matching). (3) Root `check` runs `pnpm size` after `build`, as CI does.

Node LTS pinned in `.nvmrc`; browsers from Playwright's pinned set.

---

## 5. Deploy

**Cloudflare Workers with static assets** (ADR/06 §5), via `wrangler`:

```toml
# apps/web/wrangler.toml
name = "sgl"
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

**Implemented (Stage J)**: `vite build` writes this file into `apps/web/dist/` from `apps/web/build/headers.ts` (held to the block above by `apps/web/test/headers.test.ts`), and `vite preview` serves the build with the headers it declares, so the e2e suite runs under them. `wrangler.toml` and the deploy itself are not set up: publishing is a human step (decision J4).

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
