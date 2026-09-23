import { defineConfig, devices } from '@playwright/test';

/**
 * DD-08 §14's Playwright suite, against a **production build** (`vite build`
 * + `vite preview`) — not the dev server, so what is tested is what actually
 * ships (Stage I part 2 decision, brief item 9).
 *
 * `pnpm check` (root) runs this project list filtered to `chromium` only, so
 * a contributor's machine does not need Firefox/WebKit installed for the
 * repo to stay green end to end. CI's own `test:e2e:all-browsers` script runs
 * all three (DD-10 §4) — `pnpm exec playwright install webkit firefox` is a
 * one-time per-machine step for that, the same as the existing README note
 * for `chromium`/`firefox` (Vitest's browser project, DD-09).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'vite build && vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
