import { expect, test, type Page, type Request } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, renderedSvg, setSource, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/**
 * A18 branch 2 (DD-11 T53): the lazy `rich-text` chunk — the inline parser and
 * the word breaker — and its two boot-path gates, in the real app. The offline
 * case (the chunk answered by the service worker) is in `offline.spec.ts`.
 */

const isRichText = (r: Request): boolean => /\/assets\/rich-text-[^/]*\.js$/.test(new URL(r.url()).pathname);
/** One of A18's seven run faces (DD-11 T26): Inter 700, an Inter italic, IBM Plex Mono. */
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

test('markup in a label loads the chunk, and each mark is drawn in its own face: bold 700, italic, IBM Plex Mono (DD-11 T43, T44)', async ({ page }) => {
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
  // Computed on the drawn tspans: the run rules beat what <text> inherits.
  const computed = (selector: string) =>
    renderedSvg(page)
      .locator(selector)
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { weight: s.fontWeight, style: s.fontStyle, family: s.fontFamily };
      });
  expect(await computed('g[id="n-api"] tspan.r-strong')).toMatchObject({ weight: '700', style: 'normal' });
  expect((await computed('g[id="n-api"] tspan.r-strong')).family).toMatch(/^Inter/);
  expect(await computed('g[id="n-api"] tspan.r-code')).toMatchObject({ weight: '400', style: 'normal' });
  expect((await computed('g[id="n-api"] tspan.r-code')).family).toMatch(/^"IBM Plex Mono"/);
  expect(await computed('g.el tspan.r-em')).toMatchObject({ weight: '400', style: 'italic' });
  expect(await renderedSvg(page).locator('g[id="n-calc"] tspan[class]').count()).toBe(0);
  // The faces themselves arrived: the real Inter 700, Inter Italic 400 and Plex Mono 400, not synthesised ones.
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')} ${f.style} ${f.weight}`).sort());
  expect(loaded).toEqual(expect.arrayContaining(['IBM Plex Mono normal 400', 'Inter italic 400', 'Inter normal 700']));
});

test('code is never italic, as the browser computes it: `b` inside *a `b`* is upright Plex (DD-11 T25, T44)', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, 'a: "*a `b`*"\n');
  await waitForExactNodeCount(page, 1);
  const code = renderedSvg(page).locator('g[id="n-a"] tspan.r-code');
  await expect(code).toHaveText('b');
  expect(await code.getAttribute('class')).toBe('r-em r-code');
  const style = await code.evaluate((el) => ({ style: getComputedStyle(el).fontStyle, family: getComputedStyle(el).fontFamily }));
  expect(style.style).toBe('normal');
  expect(style.family).toMatch(/^"IBM Plex Mono"/);
  expect(await renderedSvg(page).locator('g[id="n-a"] tspan.r-em:not(.r-code)').evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
});

test('typing **x** gives a tspan with computed font-weight 700 (DD-11 T60)', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, 'a: "**x**"\n');
  await waitForExactNodeCount(page, 1);
  const tspan = renderedSvg(page).locator('g[id="n-a"] tspan.r-strong');
  await expect(tspan).toHaveText('x');
  expect(await tspan.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
});

test('a wrapped label is drawn on its measured lines, each within the wrap width (no overflow)', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, 'a: { @label: "Payments **ledger** reconciliation *service* for `EU`", @size: { maxWidth: 150 } }\n');
  await waitForExactNodeCount(page, 1);
  const lines = renderedSvg(page).locator('g[id="n-a"] text > tspan');
  await expect.poll(() => lines.count()).toBeGreaterThan(1);
  const shape = await shapeWidth(page, 'a');
  expect(shape).toBeLessThanOrEqual(150);
  // Every drawn line is narrower than its node, as the browser lays the glyphs out.
  const widths = await lines.evaluateAll((els) => els.map((el) => (el as SVGTextContentElement).getComputedTextLength()));
  for (const w of widths) expect(w).toBeLessThanOrEqual(shape);
});
