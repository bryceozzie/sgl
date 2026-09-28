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
  // parallel load has timed out in Firefox. Local runs keep 0 so a flake
  // stays loud.
  retries: process.env.CI ? 1 : 0,
  // …but a test that fails and then passes on its retry still fails the CI
  // run (fix round 1, item 16). A retry that silently turns red into green
  // hides exactly the timing races this suite exists to catch — an app race
  // looks like a flake. The retry stays for its trace and for the "flaky"
  // report, which names the test to look at.
  failOnFlakyTests: !!process.env.CI,
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
    // DD-13 HD6: a first visit opens the Help drawer at the quick start. Every
    // test starts in a fresh context, so every test would be a first visit;
    // the specs about something else start as a returning visitor, with the
    // flag already set (`src/state/first-visit.ts`). `e2e/help.spec.ts` clears
    // it for the first-visit case. A context on another origin (the specs'
    // own static servers) does not get this and must set the flag itself.
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${PORT}`, localStorage: [{ name: 'sgl-help-shown', value: '1' }] }] },
  },
  webServer: {
    command: `vite build && vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // At most four Firefox instances at once (Stage J). With the suite's
    // default parallelism, several Firefox browsers launching together (with
    // Chromium and WebKit still running) intermittently hung in context
    // set-up and teardown (`browserContext.close: Test ended`, juggler's
    // FrameTree errors) and timed out tests whose own steps had finished —
    // contention, not a test or app fault.
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, workers: 4 },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
