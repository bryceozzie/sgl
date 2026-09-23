import { defineConfig } from 'vitest/config';

// DD-09 §3.1 — the unit/golden/property levels run under Node with no DOM shims,
// which is also the NFR-2 isomorphic-core check.
//
// The `browser` project (Stage H, decision D3) runs Chromium + Firefox via the
// Playwright provider, covering the worker host and worker runtime against a real
// `Worker` (DD-06 §10) — `CanvasMeasurer` and a Playwright e2e suite for apps/web
// still arrive with the code that needs them. `pnpm test:unit` stays Node-only by
// filtering to the `unit` project; plain `pnpm test`/`vitest run` runs both.
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
        test: {
          name: 'browser',
          include: ['packages/*/test/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }],
          },
        },
      },
    ],
  },
});
