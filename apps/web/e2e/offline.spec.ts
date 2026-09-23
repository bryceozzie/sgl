import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, nodeGeometry, openFile, waitForExactNodeCount, waitForNodeCount } from './helpers.js';
import { serveDist, type StaticServer } from './static-server.js';

/**
 * MVP acceptance criterion 5 (06 §3), DD-08 §14 test 7, single-engine half:
 * after the first load, with the network gone, a reload still gives the whole
 * app — shell, editor, fonts, the layout worker and `grid` — from the service
 * worker's precache (DD-08 §12). The engine-switch half waits for `elk`
 * (Stage K).
 *
 * "The network gone" is `context.setOffline(true)` in Chromium and Firefox.
 * Playwright's WebKit fails an offline navigation itself ("WebKit encountered
 * an internal error") before the service worker can answer it, and its
 * request routing likewise sees — and blocks — requests the service worker
 * would have served; so there the build is served by a server of the test's
 * own (`static-server.ts`), and the network is taken away by stopping it.
 */

// The service worker is the thing under test here (the suite blocks it
// elsewhere; see playwright.config.ts).
test.use({ serviceWorkers: 'allow' });

/** Either way, nothing reaches a server any more. */
async function goOffline(context: BrowserContext, server: StaticServer | null): Promise<void> {
  if (server !== null) await server.close();
  else await context.setOffline(true);
}

async function exerciseOffline(page: Page, online: Record<string, string>): Promise<void> {
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // A live render (the pipeline with its worker), not just a stored picture.
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(await nodeGeometry(page)).toEqual(online); // fonts too: same label metrics
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.grid');

  // Editing still lays out.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('offline: "Offline"\npsp -> offline\n');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT + 1);

  // And Open works: nothing it does touches the network.
  await openFile(page, 'o.sgl', 'a: "A"\nb: "B"\na -> b\n');
  await waitForExactNodeCount(page, 2);
}

test('criterion 5: reload offline — the app and grid work fully', async ({ page, context, browserName }) => {
  const server = browserName === 'webkit' ? await serveDist() : null;
  try {
    await page.goto(server === null ? '/' : `${server.origin}/`);
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const online = await nodeGeometry(page);
    // `ready` resolves once a worker is active, i.e. after install, which is
    // when the precache has been filled.
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active))).toBe(true);

    await goOffline(context, server);
    try {
      await page.reload();
      await exerciseOffline(page, online);
    } finally {
      if (server === null) await context.setOffline(false);
    }
  } finally {
    await server?.close().catch(() => undefined);
  }
});
