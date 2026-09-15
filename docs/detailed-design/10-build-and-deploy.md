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

`apps/web`: Vite, Preact preset, `vite-plugin-pwa`. Manual chunks: `elk` (the `@sgl/layout-elk` + `elkjs` pair), `grid`, `editor` (CodeMirror), `app`. The layout worker is a `new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })` so Vite bundles it and dynamic `import()` of engine chunks inside it works.

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
size         size-limit on the core chunk (< 180 kB gz, hard 300)
build        packages then app
audit        pnpm audit --prod (fails on high)
```

Nightly: `bench` against the targets in DD-09 §2, posting a comment on regressions over the hard ceiling.

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
