import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, layoutGeometryHash, nodeGeometry, openFile, pngSize, renderedSvg, saveAs, savePng, switchEngine, toastMessages, waitForExactNodeCount, waitForNodeCount } from './helpers.js';
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

/**
 * F9 fix round 1: `state/share.ts` (with `base64url.ts`) is a lazy chunk, so
 * the core bundle keeps within its 180 kB. Offline, from the precache alone,
 * both of its uses still work: Share makes a link, and opening a link
 * imports it. Chromium only: there every response can be proved to come
 * from the service worker (see the file comment).
 */
test('offline, the lazy share chunk comes from the precache: Share makes a link, and the link opens', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'fromServiceWorker() is proof only in Chromium');
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);
  await clearHttpCache(page, context, browserName);
  await context.setOffline(true);
  const responses: Response[] = [];
  const failed: string[] = [];
  context.on('response', (r) => {
    if (r.url().startsWith('http')) responses.push(r);
  });
  context.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  try {
    await page.reload();
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    await page.locator('.share-open').click();
    const link = await page.locator('.share-link').inputValue();
    expect(link).toMatch(/#s=[A-Za-z0-9_-]+&e=/);
    // Opening it: a navigation with the hash, which boot imports.
    await page.goto(`/${new URL(link).hash}`);
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect(toastMessages(page)).toContainText(['Opened the shared diagram']);
    const shareChunk = responses.filter((r) => /\/assets\/share-.*\.js$/.test(new URL(r.url()).pathname));
    expect(shareChunk.length).toBeGreaterThanOrEqual(2); // once per page load that used it
    expect(responses.filter((r) => !r.fromServiceWorker()).map((r) => r.url())).toEqual([]);
    expect(failed).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

/**
 * A8 follow-up: Open, Save ▾ and Share's work (`toolbar/file-actions.tsx`,
 * with `state/files.ts` and `state/filename.ts`) is the lazy `file-actions`
 * chunk, off the first paint. Offline, from the precache alone, it still
 * loads: the 2 MB refusal, an Open, a Save and a PNG export (D6, whose
 * embedded fonts are fetched from the precache too) all work, and the chunk
 * is answered by the service worker. Chromium only, as above.
 */
test('offline, the lazy file-actions chunk comes from the precache: Open, Save, PNG export and the 2 MB refusal work', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'fromServiceWorker() is proof only in Chromium');
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);
  await clearHttpCache(page, context, browserName);
  await context.setOffline(true);
  const responses: Response[] = [];
  const failed: string[] = [];
  context.on('response', (r) => {
    if (r.url().startsWith('http')) responses.push(r);
  });
  context.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  try {
    await page.reload();
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    // The first paint did not need it.
    const chunk = (): Response[] => responses.filter((r) => /\/assets\/file-actions-.*\.js$/.test(new URL(r.url()).pathname));
    expect(chunk()).toEqual([]);

    await openFile(page, 'huge.sgl', Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await expect(toastMessages(page)).toContainText(['over 2 MB']);
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);

    const source = 'a: "A"\nb: "B"\na -> b\n';
    await openFile(page, 'o.sgl', source);
    await waitForExactNodeCount(page, 2);

    const saved = await saveAs(page, 'sgl');
    expect(saved).toEqual({ name: 'a.sgl', text: source });

    // D6: PNG export too. It fetches the Inter WOFF2 files to embed them in
    // the rasterisation-only SVG, and those must come from the precache.
    const fonts = (): Response[] => responses.filter((r) => /\/assets\/inter-latin-\d+-normal-.*\.woff2$/.test(new URL(r.url()).pathname));
    const fontsBefore = fonts().length;
    const png = await savePng(page, 2);
    expect(png.name).toBe('a.png');
    const width = Number(await renderedSvg(page).getAttribute('width'));
    expect(pngSize(png.bytes).width).toBe(Math.round(width * 2));
    expect(fonts().length).toBeGreaterThan(fontsBefore);

    expect(chunk().length).toBe(1);
    expect(chunk().every((r) => r.fromServiceWorker())).toBe(true);
    expect(responses.filter((r) => !r.fromServiceWorker()).map((r) => r.url())).toEqual([]);
    expect(failed).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

/**
 * A8 fix round 2: the Options ▾ form (`toolbar/engine-options-form.tsx`, with
 * `state/engine-form.ts`) is the lazy `engine-options-form` chunk, loaded when
 * Options ▾ is first opened. Offline, from the precache alone, it still loads
 * and an option still re-lays out the diagram, and the chunk is answered by
 * the service worker. Chromium only, as above.
 */
test('offline, the lazy engine-options-form chunk comes from the precache: Options ▾ opens and re-lays out', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'fromServiceWorker() is proof only in Chromium');
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);
  await clearHttpCache(page, context, browserName);
  await context.setOffline(true);
  const responses: Response[] = [];
  const failed: string[] = [];
  context.on('response', (r) => {
    if (r.url().startsWith('http')) responses.push(r);
  });
  context.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  try {
    await page.reload();
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    // The first paint did not need it.
    const chunk = (): Response[] => responses.filter((r) => /\/assets\/engine-options-form-.*\.js$/.test(new URL(r.url()).pathname));
    expect(chunk()).toEqual([]);

    const before = await layoutGeometryHash(page);
    await page.locator('.engine-options summary').click();
    await expect(page.locator('.engine-options form')).toBeVisible();
    await expect(page.getByLabel('Direction')).toHaveValue('down');
    await page.getByLabel('Direction').selectOption('right');
    await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(before);

    expect(chunk().length).toBe(1);
    expect(chunk().every((r) => r.fromServiceWorker())).toBe(true);
    expect(responses.filter((r) => !r.fromServiceWorker()).map((r) => r.url())).toEqual([]);
    expect(failed).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
