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
size         size-limit on the core chunk (< 180 kB gz, hard 300)       — implemented, Stage K
build        packages then app
audit        pnpm audit --prod (fails on high)
```

Nightly: `bench` against the targets in DD-09 §2, posting a comment on regressions over the hard ceiling.

**`size` (Stage K, K6).** `.size-limit.js` with `size-limit` + `@size-limit/file`; root script `pnpm size`, CI step right after `build`. "The core chunk" is the JS and CSS the initial page load fetches: the entry chunk and every chunk it imports statically (`editor`, `grid`), the CSS, and the layout-worker entry with its static imports — every emitted `assets/*.js`/`*.css` except `elk-*.js` — each gzipped and summed. Limit 180 kB (the 300 kB hard ceiling is not encoded; raising the limit is a human decision). Measured at Stage K: **174.63 kB**.

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
