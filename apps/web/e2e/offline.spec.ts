import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, layoutGeometryHash, nodeGeometry, openFile, switchEngine, waitForExactNodeCount, waitForNodeCount } from './helpers.js';
import { serveDist, type StaticServer } from './static-server.js';

/**
 * MVP acceptance criterion 5 (06 §3) and DD-08 §14 test 7: after the first
 * load, with the network gone, a reload still gives the whole app — shell,
 * editor, fonts, the layout worker and **both engines** — from the service
 * worker's precache (DD-08 §12). Stage K (K8): `elk` is the default, so its
 * lazy chunk loads online at boot; after the offline reload (HTTP cache
 * emptied first) the elk chunk must come from the service worker, and
 * rendering under elk, switching to grid and back to elk all work offline,
 * with no failed request.
 *
 * "The network gone" is `context.setOffline(true)` in Chromium and Firefox.
 * Playwright's WebKit fails an offline navigation itself ("WebKit encountered
 * an internal error") before the service worker can answer it, and its
 * request routing likewise sees — and blocks — requests the service worker
 * would have served; so there the build is served by a server of the test's
 * own (`static-server.ts`), and the network is taken away by stopping it.
 *
 * **Only the service worker may answer** (fix round 1, item 1). Taking the
 * network away is not enough on its own: the first load left every
 * `/assets/*` file in the HTTP cache (`_headers` makes them immutable), so a
 * service worker that precached only `index.html` would still pass — its
 * missing routes fall through to "the network", which the HTTP cache answers
 * offline. So the HTTP cache is emptied first, per browser:
 *
 * - **Chromium**: `Network.clearBrowserCache` over CDP, and then every
 *   response of the offline reload must be `fromServiceWorker()` (Playwright
 *   documents that for Chromium). Verified to fail with `globPatterns:
 *   ['**\/*.html']`.
 * - **WebKit**: the test's own server sends `Cache-Control: no-store`, so the
 *   HTTP cache never holds anything to answer from once the server stops.
 * - **Firefox**: Playwright has neither a cache-clearing call nor a reliable
 *   `fromServiceWorker()` there, so this half is not falsifiable in Firefox;
 *   Chromium and WebKit carry it.
 */

// The service worker is the thing under test here (the suite blocks it
// elsewhere; see playwright.config.ts).
test.use({ serviceWorkers: 'allow' });

/** Either way, nothing reaches a server any more. */
async function goOffline(context: BrowserContext, server: StaticServer | null): Promise<void> {
  if (server !== null) await server.close();
  else await context.setOffline(true);
}

/** Empties the HTTP cache where the browser lets a test do that (Chromium). */
async function clearHttpCache(page: Page, context: BrowserContext, browserName: string): Promise<void> {
  if (browserName !== 'chromium') return;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
}

/** Every response the offline reload got, and that each came from the
 *  service worker (Chromium: see the file comment). Also asserts that each
 *  kind of file the app needs was actually requested and seen, so an empty
 *  or partial list cannot pass by accident. */
function assertAllFromServiceWorker(responses: readonly Response[], browserName: string): void {
  const urls = responses.map((r) => new URL(r.url()).pathname);
  expect(urls).toContain('/');
  for (const kind of [/\/assets\/index-.*\.js$/, /\/assets\/editor-.*\.js$/, /\/assets\/grid-.*\.js$/, /\/assets\/elk-.*\.js$/, /\.css$/, /\.woff2$/, /layout\.worker-.*\.js$/]) {
    expect(urls.some((u) => kind.test(u)), `a response matching ${String(kind)}`).toBe(true);
  }
  if (browserName !== 'chromium') return;
  const notFromWorker = responses.filter((r) => !r.fromServiceWorker()).map((r) => r.url());
  expect(notFromWorker).toEqual([]);
}

async function exerciseOffline(page: Page, online: Record<string, string>): Promise<void> {
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // A live render (the pipeline with its worker), not just a stored picture.
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await nodeGeometry(page)).toEqual(online); // fonts too: same label metrics
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');

  // Both engines, offline (K8): elk → grid → elk, each a real render.
  const elkGeometry = await layoutGeometryHash(page);
  await switchEngine(page, 'sgl.grid', elkGeometry);
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await switchEngine(page, 'sgl.elk', await layoutGeometryHash(page));
  expect(await layoutGeometryHash(page)).toBe(elkGeometry);

  // Editing still lays out.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('offline: "Offline"\npsp -> offline\n');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT + 1);

  // And Open works: nothing it does touches the network.
  await openFile(page, 'o.sgl', 'a: "A"\nb: "B"\na -> b\n');
  await waitForExactNodeCount(page, 2);
}

test('criterion 5: reload offline — the app and both engines work fully, switching included', async ({ page, context, browserName }) => {
  const server = browserName === 'webkit' ? await serveDist({ noStore: true }) : null;
  try {
    await page.goto(server === null ? '/' : `${server.origin}/`);
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const online = await nodeGeometry(page);
    // `ready` resolves once a worker is active, i.e. after install, which is
    // when the precache has been filled.
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);

    await clearHttpCache(page, context, browserName);
    await goOffline(context, server);
    // The context, not the page: the elk chunk is fetched by the layout
    // worker, whose requests Playwright reports on the context.
    const responses: Response[] = [];
    const failed: string[] = [];
    context.on('response', (r) => {
      if (r.url().startsWith('http')) responses.push(r);
    });
    context.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
    try {
      await page.reload();
      await exerciseOffline(page, online);
      assertAllFromServiceWorker(responses, browserName);
      expect(failed).toEqual([]);
    } finally {
      if (server === null) await context.setOffline(false);
    }
  } finally {
    await server?.close().catch(() => undefined);
  }
});
