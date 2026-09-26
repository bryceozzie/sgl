import { expect, test, type Page, type Request } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, renderedSvg, setSource, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/**
 * A18 branch 2 (DD-11 T53): the lazy `rich-text` chunk — the inline parser and
 * the word breaker — and its two boot-path gates, in the real app. The offline
 * case (the chunk answered by the service worker) is in `offline.spec.ts`.
 */

const isRichText = (r: Request): boolean => /\/assets\/rich-text-[^/]*\.js$/.test(new URL(r.url()).pathname);
/** One of A18's eight faces (DD-11 T26): Inter 700, an Inter italic, IBM Plex Mono. */
const isRunFace = (r: Request): boolean => /\/assets\/(inter-latin-700-normal|inter-latin-\d+-italic|ibm-plex-mono-latin-\d+-normal)-[^/]*\.woff2$/.test(new URL(r.url()).pathname);

/** The width of a node's own shape, as drawn. */
async function shapeWidth(page: Page, id: string): Promise<number> {
  return renderedSvg(page)
    .locator(`g[id="n-${id}"] > path.n-shape`)
    .evaluate((p) => (p as SVGGraphicsElement).getBBox().width);
}

test('a document without markup in a label or a label to wrap never fetches the chunk or a run face, across boot and edits', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (isRichText(r) || isRunFace(r)) fetched.push(r.url());
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

test('markup in a label loads the chunk; until the render branch the runs are drawn as plain text, markers removed', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (isRichText(r)) fetched.push(r.url());
  });
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, 'api: "**Payments** API `v2`"\ncalc: "2*3*4 and a * b"\napi -> calc: "*async*"\n');
  await waitForExactNodeCount(page, 2);
  const text = (id: string) => renderedSvg(page).locator(`g[id="${id}"] text`);
  await expect(text('n-api')).toHaveText('Payments API v2');
  await expect(text('n-calc')).toHaveText('2*3*4 and a * b');
  await expect(renderedSvg(page).locator('g.el text')).toHaveText('async');
  expect(fetched).toHaveLength(1);
});
