import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { editorText, EXAMPLE_NODE_COUNT, setSource, SMALL_SOURCE, toastMessages, visibleNodeCount, waitForExactNodeCount, waitForNodeCount } from './helpers.js';
import { serveDist } from './static-server.js';

/**
 * F12 (DD-08 §12): an update accepted in one tab must not leave another tab
 * running old code whose lazy chunks the new service worker has dropped.
 *
 * A real update needs two builds. The first is the suite's own `dist/`. The
 * second is the same source built again with every JS file named
 * `*-v2-[hash].js` (Vite's JS API with the app's own `vite.config.ts`, the
 * output file names overridden), so every chunk URL of the first build is
 * gone from the second one's precache — which is what an ordinary release
 * does to any chunk whose code changed. A server of the test's own serves
 * the first build, then (`setRoot`) the second; `registration.update()` in
 * one tab finds the new `sw.js`.
 *
 * Three tabs: A accepts the update; B (IndexedDB) must reload itself onto
 * the new version, keep its own document and its last edit, and then load a
 * lazy chunk offline; C (IndexedDB unavailable: its documents live only in
 * the page) must *not* reload, and says why.
 *
 * Chromium only: the suite's only browser here, and `setOffline` with a
 * service worker is what the offline spec already relies on in Chromium.
 */

test.use({ serviceWorkers: 'allow' });

const APP = fileURLToPath(new URL('../', import.meta.url));
/** The second build, one per worker (a repeated run builds in parallel). */
let V2 = '';

test.beforeAll(async ({ browserName }, workerInfo) => {
  if (browserName !== 'chromium') return;
  test.setTimeout(240_000);
  V2 = fileURLToPath(new URL(`../node_modules/.sgl-e2e-update/${workerInfo.parallelIndex}/`, import.meta.url));
  const { build } = await import('vite');
  await build({
    root: APP,
    configFile: `${APP}vite.config.ts`,
    logLevel: 'warn',
    build: {
      outDir: V2,
      emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: 'assets/[name]-v2-[hash].js', chunkFileNames: 'assets/[name]-v2-[hash].js' } },
    },
  });
  expect(existsSync(`${V2}sw.js`)).toBe(true);
});

/** The page's entry script: which build it is running. */
const entry = (page: Page) =>
  page
    .evaluate(() => document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? '')
    // Mid-reload: no page to ask yet.
    .catch(() => '');

async function controlled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

test('F12: an update accepted in one tab reloads the others onto it, saved first; a tab kept only in memory is not reloaded', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only (see the file comment)');
  test.setTimeout(180_000);
  const server = await serveDist({ noStore: true });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    // A installs the service worker; it controls pages loaded after that.
    const a = await context.newPage();
    await a.goto(`${server.origin}/`);
    await waitForNodeCount(a, EXAMPLE_NODE_COUNT);
    await a.evaluate(async () => void (await navigator.serviceWorker.ready));
    await a.reload();
    await controlled(a);
    await waitForNodeCount(a, EXAMPLE_NODE_COUNT);

    // B: a document of its own, and an edit.
    const b = await context.newPage();
    await b.goto(`${server.origin}/`);
    await controlled(b);
    await waitForNodeCount(b, EXAMPLE_NODE_COUNT);
    await b.locator('.docs-menu > summary').click();
    await b.locator('.docs-menu .docs-new').click();
    await setSource(b, SMALL_SOURCE);
    await waitForExactNodeCount(b, visibleNodeCount(SMALL_SOURCE));

    // C: IndexedDB unavailable, so the in-memory store (DD-08 §9).
    const c = await context.newPage();
    await c.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
    await c.goto(`${server.origin}/`);
    await controlled(c);
    await waitForNodeCount(c, EXAMPLE_NODE_COUNT);
    await setSource(c, SMALL_SOURCE);
    await waitForExactNodeCount(c, visibleNodeCount(SMALL_SOURCE));
    await c.evaluate(() => Object.assign(window, { sglSamePage: true }));

    const v1 = await entry(a);
    expect(v1).not.toMatch(/-v2-/);
    expect(await entry(b)).toBe(v1);

    // The new version is deployed; A finds it and accepts it.
    server.setRoot(V2);
    await a.evaluate(async () => void (await (await navigator.serviceWorker.getRegistration())?.update()));
    await a.locator('.update-reload').click();
    await expect.poll(() => entry(a), { timeout: 30_000 }).toMatch(/-v2-/);
    await waitForNodeCount(a, 1);
    // A reopened its own document, not B's (the last one opened anywhere).
    await waitForExactNodeCount(a, EXAMPLE_NODE_COUNT);

    // Offline from here: only the new precache can answer.
    await context.setOffline(true);

    // B reloaded itself onto the new version, with its own document and
    // its edit, and lazy chunks it had never loaded (Share's: `file-actions`
    // and `share`) load offline.
    await expect.poll(() => entry(b), { timeout: 30_000 }).toMatch(/-v2-/);
    await waitForExactNodeCount(b, visibleNodeCount(SMALL_SOURCE));
    expect(await editorText(b)).toBe(SMALL_SOURCE);
    await b.locator('.share-open').click();
    await expect(b.locator('.share-link')).toHaveValue(/#s=[A-Za-z0-9_-]+&e=/);

    // C was not reloaded — that would have lost its documents — and says so.
    await expect(toastMessages(c)).toContainText(['updated in another tab']);
    expect(await c.evaluate(() => (window as { sglSamePage?: boolean }).sglSamePage)).toBe(true);
    expect(await entry(c)).toBe(v1);
    expect(await editorText(c)).toBe(SMALL_SOURCE);
    // Nor did it offer the update itself: accepting it would reload it too.
    await expect(c.locator('.update-chip')).toHaveCount(0);
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await context.close();
    await server.close();
  }
});
