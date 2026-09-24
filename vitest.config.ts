import { defineConfig } from 'vitest/config';

// DD-09 §3.1 — the unit/golden/property levels run under Node with no DOM shims,
// which is also the NFR-2 isomorphic-core check.
//
// The `browser` project (Stage H, decision D3) runs Chromium + Firefox via the
// Playwright provider, covering the worker host and worker runtime against a real
// `Worker` (DD-06 §10) — `CanvasMeasurer` and a Playwright e2e suite for apps/web
// still arrive with the code that needs them. `pnpm test:unit` stays Node-only by
// filtering to the `unit` project; `pnpm test` and `pnpm test:watch` name `unit`
// and `browser`. The third project, `bench` (F9), runs only by name, through
// `pnpm bench:theme`: a bare `vitest run` would run all three.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // apps/web/test (Stage I, I3): the signal graph and pipeline
          // orchestration are plain TypeScript with the layout host, measurer and
          // debounce clock injected, so they run here too — DOM-free and fast —
          // rather than only under Playwright.
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          // `*.browser.test.ts` needs a real `Worker`/DOM and belongs to the
          // `browser` project below; without this it also matches `*.test.ts`
          // and fails under Node with `Worker is not defined`.
          exclude: ['**/*.browser.test.ts'],
        },
      },
      {
        // `apps/web/test/canvas.browser.test.ts` mounts the Preact `Canvas`.
        esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
        // The dependency scan must see the JSX runtime import esbuild injects
        // into `.tsx`: discovered mid-run instead (a cold `node_modules/.vite`,
        // as after the standard clean command), Vite re-optimises and reloads
        // the page under the running tests. (`include` cannot name Preact
        // here: it resolves from the repo root, where Preact is not installed.)
        optimizeDeps: {
          esbuildOptions: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: true },
        },
        test: {
          name: 'browser',
          // apps/web/test's browser tests (F9 P3): the canvas's paint-only DOM
          // swap, checked against a full render's DOM in a real browser.
          include: ['packages/*/test/**/*.browser.test.ts', 'apps/web/test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }],
          },
        },
      },
      {
        // F9's end-to-end theme-switch bench (execution plan §2.1): the real
        // `apps/web` pipeline and canvas in Chromium, where DD-09 §2's budget
        // is defined. Minutes long and timing-bound, so it is not part of
        // `pnpm test`/`pnpm check`: run it with `pnpm bench:theme`.
        // Rooted in the app so its own dependencies (Preact, signals) resolve.
        root: 'apps/web',
        esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
        // Pre-bundled up front: discovered mid-run (a cold `node_modules/.vite`,
        // as after the standard clean command), Vite reloads the page under
        // the running test and the first render never lands.
        optimizeDeps: {
          include: [
            'preact',
            'preact/hooks',
            'preact/jsx-dev-runtime',
            'preact/jsx-runtime',
            '@preact/signals',
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/lint',
            '@codemirror/state',
            '@codemirror/view',
            '@lezer/common',
            '@lezer/highlight',
            '@sgl/layout-elk > elkjs/lib/elk.bundled.js',
          ],
        },
        test: {
          name: 'bench',
          include: ['bench/**/*.bench.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
