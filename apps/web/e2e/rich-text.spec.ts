import { expect, test, type Page, type Request } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, renderedSvg, setSource, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/**
 * A18 branch 2 (DD-11 T53): the lazy `rich-text` chunk — the inline parser and
 * the word breaker — and its two boot-path gates, in the real app. The offline
 * case (the chunk answered by the service worker) is in `offline.spec.ts`.
 */

const isRichText = (r: Request): boolean => /\/assets\/rich-text-[^/]*\.js$/.test(new URL(r.url()).pathname);

/** The width of a node's own shape, as drawn. */
async function shapeWidth(page: Page, id: string): Promise<number> {
  return renderedSvg(page)
    .locator(`g[id="n-${id}"] > path.n-shape`)
    .evaluate((p) => (p as SVGGraphicsElement).getBBox().width);
}

test('a document without markup in a label or a label to wrap never fetches the chunk, across boot and edits', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (isRichText(r)) fetched.push(r.url());
  });
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  // snake_case, a lone arithmetic minus, a fixed height and a min width: none of them
  // is markup or a box to wrap in.
  await setSource(page, 'api: { @label: "order_service v2", @size: { height: 60, minWidth: 90 } }\ndb: "Ledger - EU"\napi -> db: "writes"\n');
  await waitForExactNodeCount(page, 2);
  await page.waitForTimeout(500);
  expect(fetched).toEqual([]);
});

test('a label to wrap loads the chunk, and its node is laid out within @size.maxWidth', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (isRichText(r)) fetched.push(r.url());
  });
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, 'a: { @label: "Payments ledger reconciliation service", @size: { maxWidth: 150 } }\nb: "Payments ledger reconciliation service"\na -> b\n');
  await waitForExactNodeCount(page, 2);
  await expect.poll(() => shapeWidth(page, 'a')).toBeLessThanOrEqual(150);
  expect(await shapeWidth(page, 'b')).toBeGreaterThan(150);
  expect(fetched).toHaveLength(1);
});
