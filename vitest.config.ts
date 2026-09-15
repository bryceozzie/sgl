import { defineConfig } from 'vitest/config';

// DD-09 §3.1 — the unit/golden/property levels run under Node with no DOM shims,
// which is also the NFR-2 isomorphic-core check.
//
// ⟶ later: a `browser` project (Chromium + Firefox) covering CanvasMeasurer, the
// worker host and `grid` bitwise parity, and a Playwright e2e suite for apps/web.
// Both arrive with the code they test.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts'],
        },
      },
    ],
  },
});
