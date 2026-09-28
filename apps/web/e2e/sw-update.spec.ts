import { existsSync, readFileSync } from 'node:fs';
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
 * Four tabs: A accepts the update; B (IndexedDB, a slow disk) must reload
 * itself onto the new version, keep its own document and what it typed
 * while saving, and then load a lazy chunk offline; C (IndexedDB
 * unavailable: its documents live only in the page) and D (IndexedDB whose
 * writes fail) must *not* reload, say why, and still save their work
 * through Save ▾ offline (F12/F13 fix round 1, items 1–3).
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

/** Holds a `readwrite` transaction on `documents` for `ms` from another
 *  connection, so the app's next put waits behind it: a slow disk. */
async function holdDocumentsStore(page: Page, ms: number): Promise<void> {
  await page.evaluate(
    (hold) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('sgl');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('documents', 'readwrite');
          const store = tx.objectStore('documents');
          const until = Date.now() + hold;
          const spin = (): void => {
            if (Date.now() < until) store.count().onsuccess = spin;
          };
          spin();
          tx.oncomplete = () => db.close();
          resolve();
        };
      }),
    ms,
  );
}

/** Save ▾ → SGL source: the downloaded text. */
async function saveSgl(page: Page): Promise<string> {
  await page.locator('.save-menu > summary').click();
  const download = page.waitForEvent('download');
  await page.locator('.save-menu .save-sgl').click();
  return readFileSync(await (await download).path(), 'utf8');
}

const B_LATE = 'late: "Typed while B was saving"\n';

test('F12: an update accepted in one tab reloads the others onto it, saved first; a tab that cannot save everything is not reloaded, and can still save', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only (see the file comment)');
  test.setTimeout(240_000);
  const server = await serveDist({ noStore: true });
  const context = await browser.newContext({ serviceWorkers: 'allow', acceptDownloads: true });
  // A returning visitor (DD-13 HD6): this server's origin is not the one the config seeds.
  await context.addInitScript(() => localStorage.setItem('sgl-help-shown', '1'));
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
    await b.evaluate(() =>
      navigator.serviceWorker.addEventListener('controllerchange', () => Object.assign(window, { sglControllerChanged: true })),
    );

    // C: IndexedDB unavailable, so the in-memory store (DD-08 §9).
    const c = await context.newPage();
    await c.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
    await c.goto(`${server.origin}/`);
    await controlled(c);
    await waitForNodeCount(c, EXAMPLE_NODE_COUNT);
    await setSource(c, SMALL_SOURCE);
    await waitForExactNodeCount(c, visibleNodeCount(SMALL_SOURCE));
    await c.evaluate(() => Object.assign(window, { sglSamePage: true }));

    // D: IndexedDB, but every document write fails from now on (a full or
    // broken disk): its edit exists only in the page.
    const d = await context.newPage();
    await d.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if ((window as { sglFailPut?: boolean }).sglFailPut === true && this.name === 'documents') throw new DOMException('Simulated disk failure', 'UnknownError');
        return put.apply(this, args);
      };
    });
    await d.goto(`${server.origin}/`);
    await controlled(d);
    await waitForNodeCount(d, 1);
    await d.evaluate(() => Object.assign(window, { sglFailPut: true, sglSamePage: true }));
    const D_TEXT = 'unsaved: "Only in this page"\n';
    await setSource(d, D_TEXT);
    await expect(toastMessages(d)).toContainText(["Couldn't save to this browser's storage"]);

    const v1 = await entry(a);
    expect(v1).not.toMatch(/-v2-/);
    expect(await entry(b)).toBe(v1);

    // The new version is deployed; A finds it.
    server.setRoot(V2);
    await a.evaluate(async () => void (await (await navigator.serviceWorker.getRegistration())?.update()));
    await expect(a.locator('.update-reload')).toBeVisible({ timeout: 30_000 });

    // B's disk is slow (round 1, item 3): its next write waits 12 s. It edits,
    // A accepts the update, and B types again while it is still saving.
    await holdDocumentsStore(b, 12_000);
    await setSource(b, SMALL_SOURCE.replace('API', 'API two'));
    await a.locator('.update-reload').click();
    await expect.poll(() => b.evaluate(() => (window as { sglControllerChanged?: boolean }).sglControllerChanged === true).catch(() => true), { timeout: 30_000 }).toBe(true);
    await setSource(b, B_LATE);

    await expect.poll(() => entry(a), { timeout: 30_000 }).toMatch(/-v2-/);
    await waitForNodeCount(a, 1);
    // A reopened its own document, not B's (the last one opened anywhere).
    await waitForExactNodeCount(a, EXAMPLE_NODE_COUNT);

    // B reloaded itself onto the new version, with its own document and
    // what it typed while saving.
    await expect.poll(() => entry(b), { timeout: 30_000 }).toMatch(/-v2-/);
    await waitForExactNodeCount(b, visibleNodeCount(B_LATE));
    expect(await editorText(b)).toBe(B_LATE);

    // Offline from here: only the new precache can answer.
    await context.setOffline(true);

    // B's lazy chunks it had never loaded (Share's: `file-actions` and
    // `share`) load offline.
    await b.locator('.share-open').click();
    await expect(b.locator('.share-link')).toHaveValue(/#s=[A-Za-z0-9_-]+&e=/);

    // C was not reloaded — that would have lost its documents — says so,
    // and can still save its work (round 1, item 2).
    await expect(toastMessages(c)).toContainText(['updated in another tab']);
    expect(await c.evaluate(() => (window as { sglSamePage?: boolean }).sglSamePage)).toBe(true);
    expect(await entry(c)).toBe(v1);
    expect(await editorText(c)).toBe(SMALL_SOURCE);
    // Nor did it offer the update itself: accepting it would reload it too.
    await expect(c.locator('.update-chip')).toHaveCount(0);
    expect(await saveSgl(c)).toBe(SMALL_SOURCE);

    // D, whose write failed, likewise (round 1, item 1): not reloaded, told
    // once, and it can save.
    await expect(toastMessages(d).filter({ hasText: 'updated in another tab' })).toHaveCount(1);
    expect(await d.evaluate(() => (window as { sglSamePage?: boolean }).sglSamePage)).toBe(true);
    expect(await entry(d)).toBe(v1);
    expect(await saveSgl(d)).toBe(D_TEXT);
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await context.close();
    await server.close();
  }
});
