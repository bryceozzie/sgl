import { expect, test, type Route } from '@playwright/test';
import {
  EXAMPLE_NODE_COUNT,
  nodeGeometry,
  readStorage,
  renderedSvg,
  setSource,
  SMALL_SOURCE,
  storedOpenDocument,
  storedSvg,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/** DD-08 §9 (autosave, boot) and §5 (J6: the stored last-good SVG painted at
 *  boot, before fonts or the worker are ready). */

test('autosave survives a reload: same document, same text, same diagram', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  const { lastOpenDocId } = await readStorage(page);
  expect(lastOpenDocId).toBeTruthy(); // the example was stored as a document at first boot

  await setSource(page, SMALL_SOURCE);
  await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
  const before = await nodeGeometry(page);
  // Autosave is 500 ms after the last change; wait on the stored record
  // itself, including the SVG the next boot will paint.
  await expect
    .poll(async () => {
      const doc = await storedOpenDocument(page);
      return doc?.source === SMALL_SOURCE && doc.lastGoodSvg !== undefined && doc.title === 'checkout';
    })
    .toBe(true);

  await page.reload();
  await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
  expect(await nodeGeometry(page)).toEqual(before);
  const after = await readStorage(page);
  expect(after.lastOpenDocId).toBe(lastOpenDocId);
  expect(after.documents).toHaveLength(1);
});

test.describe('J6: the stored picture paints before fonts or the worker are ready', () => {
  // Requests are intercepted below; a service worker would answer them from
  // its cache first, out of the route's reach.
  test.use({ serviceWorkers: 'block' });

  test('a reload paints lastGoodSvg from IndexedDB, then the live render replaces it', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect.poll(async () => (await storedOpenDocument(page))?.lastGoodSvg !== undefined).toBe(true);
    const stored = (await storedOpenDocument(page))!.lastGoodSvg!;
    const liveGeometry = await nodeGeometry(page);

    // Hold the layout worker and every font: nothing live can render.
    const held: Route[] = [];
    let holding = true;
    await page.route(/layout\.worker-.*\.js$|\.woff2$/, (route) => (holding ? void held.push(route) : route.continue()));
    // Not "load": that waits for the held fonts.
    await page.reload({ waitUntil: 'commit' });

    await expect(storedSvg(page).locator('g.L-nodes > g.n, g.L-containers > g.c')).toHaveCount(EXAMPLE_NODE_COUNT);
    expect(await renderedSvg(page).count()).toBe(0); // nothing live yet…
    expect(held.length).toBeGreaterThan(0); // …because what it needs is still held.
    const painted = await storedSvg(page).evaluate((svg) => svg.getAttribute('viewBox'));
    expect(stored).toContain(`viewBox="${painted}"`);
    // Fitted, not dumped at scale 1 in the corner.
    await expect(page.locator('.canvas-host g.viewport')).toHaveAttribute('transform', /scale\((?!1\))/);

    // Let fonts and the worker through: the live render takes over.
    holding = false;
    for (const route of held) await route.continue();
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect(storedSvg(page)).toHaveCount(0);
    expect(await nodeGeometry(page)).toEqual(liveGeometry);
  });
});
