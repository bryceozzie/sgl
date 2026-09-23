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
/** `SGL_E2E_PORT` picks another port when 4173 is taken (a second checkout's
 *  preview, say). The server is never reused (Stage J): a preview already
 *  listening on the port may be serving a different or stale build, and the
 *  suite would then pass against the wrong code. `--strictPort` fails loudly
 *  instead. */
const PORT = Number(process.env.SGL_E2E_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // J5 (Stage J): one retry on CI only, where an all-browser run under
  // parallel load has timed out in Firefox; the list reporter still names
  // every test that needed it as "flaky". Local runs keep 0 so a flake stays
  // loud.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Stage J: the service worker is blocked except in the specs that are
    // about it (`offline.spec.ts`, `csp.spec.ts`), which opt back in. Every
    // context otherwise installs it and fills a ~560 KB precache; with ten
    // parallel Firefox workers that load alone pushed unrelated tests past
    // their timeouts (context set-up and teardown both), and blocking it
    // made the same Firefox run clean. Measured, not assumed.
    serviceWorkers: 'block',
  },
  webServer: {
    command: `vite build && vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
