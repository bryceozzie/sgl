import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, renderedSvg, saveAs, setSource, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

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
  // (That the faces are loaded before the runs are measured is
  // `test/rich-font-gate.browser.test.ts`'s: after the paint they always are.)
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

/**
 * Fix round 1, item 5: a document with no markup whose `@style` asks for weight
 * 700 (or italic) is drawn on screen in the same face its export embeds: the
 * real Inter 700, registered with the run faces, not Inter 600 by font
 * matching (which is what the screen drew while only markup loaded them).
 * The drawn advance is compared, in the drawn tree, with a clone set in Inter
 * 700 loaded independently under a probe name.
 */
test('a @style asking for weight 700 with no markup is drawn in the face its export embeds', async ({ page }) => {
  const LABEL = 'Hamburgefontsiv WAVE 0123';
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, `a: { @label: "${LABEL}", @style: { fontWeight: 700 } }\n`);
  await waitForExactNodeCount(page, 1);
  await expect(renderedSvg(page).locator('g[id="n-a"] text')).toHaveText(LABEL);
  // The shipped files, as the build emitted them.
  const assets = readdirSync(fileURLToPath(new URL('../dist/assets/', import.meta.url)));
  const asset = (re: RegExp): string => `/assets/${assets.find((f) => re.test(f))!}`;
  const urls = { bold: asset(/^inter-latin-700-normal-[\w-]+\.woff2$/), semibold: asset(/^inter-latin-600-normal-[\w-]+\.woff2$/) };
  const probe = (): Promise<{ drawn: number; bold: number; semibold: number } | null> =>
    page.evaluate(async (urls) => {
      const text = document.querySelector<SVGTextElement>('.canvas-host g.rendered[data-origin="live"] g[id="n-a"] text');
      if (text === null) return null;
      const w = window as unknown as { __probe?: boolean };
      if (!w.__probe) {
        document.fonts.add(await new FontFace('ProbeBold', `url(${urls.bold})`, { weight: '700' }).load());
        document.fonts.add(await new FontFace('ProbeSemibold', `url(${urls.semibold})`, { weight: '600' }).load());
        w.__probe = true;
      }
      const clone = (style: string): number => {
        const c = text.cloneNode(true) as SVGTextElement;
        c.setAttribute('style', style);
        text.parentNode!.append(c);
        const length = c.getComputedTextLength();
        c.remove();
        return length;
      };
      return { drawn: text.getComputedTextLength(), bold: clone("font-family: 'ProbeBold'; font-weight: 700"), semibold: clone("font-family: 'ProbeSemibold'; font-weight: 600") };
    }, urls);
  await expect
    .poll(async () => {
      const p = await probe();
      return p === null ? Infinity : Math.abs(p.drawn - p.bold);
    })
    .toBeLessThanOrEqual(0.05);
  const p = (await probe())!;
  expect(Math.abs(p.bold - p.semibold), JSON.stringify(p)).toBeGreaterThan(0.5);
  // …and the export embeds exactly that face.
  const saved = (await saveAs(page, 'svg')).text;
  expect([...saved.matchAll(/@font-face\{font-family:&apos;([^&]*)&apos;;font-style:(\w+);font-weight:(\d+)/g)].map((m) => m.slice(1).join(' '))).toEqual(['Inter normal 700']);
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
