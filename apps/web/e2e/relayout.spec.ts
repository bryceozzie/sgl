import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, renderedSvg, saveAs, setSource, storedOpenDocument, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/**
 * Fix round 1, item 1 (a blocker found on `main`): editing a label's text
 * must lay the diagram out again. The layout skip used to compare only the
 * styles' geometry, the engine and its options, so `a: "short"` edited into
 * a long label kept its 72 px box around ~260 px of text, on screen, in
 * Save ▾ SVG and in the stored picture.
 */

async function boxAndText(page: Page): Promise<{ readonly box: number; readonly text: number }> {
  return renderedSvg(page).evaluate((svg) => {
    const g = svg.querySelector('g.L-nodes > g.n')!;
    return { box: (g.querySelector('path.n-shape') as SVGGraphicsElement).getBBox().width, text: (g.querySelector('text') as SVGGraphicsElement).getBBox().width };
  });
}

/** The first node's shape width in a stored or saved SVG string, as the browser draws it. */
async function boxIn(page: Page, svgText: string): Promise<number> {
  return page.evaluate((text) => {
    const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.append(host);
    host.innerHTML = text;
    const width = (host.querySelector('g.L-nodes > g.n path.n-shape') as SVGGraphicsElement).getBBox().width;
    host.remove();
    return width;
  }, svgText);
}

test('a label text edit lays out again: the box grows around the new text, on screen, in Save ▾ SVG and in storage', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, 'a: "short"\n');
  await waitForExactNodeCount(page, 1);
  await expect.poll(async () => (await renderedSvg(page).locator('text').textContent())?.trim()).toBe('short');
  const short = await boxAndText(page);
  expect(short.box).toBeGreaterThan(short.text);

  const long = 'a much much much longer label text here';
  await setSource(page, `a: "${long}"\n`);
  await expect.poll(async () => (await boxAndText(page)).box, { timeout: 10_000 }).toBeGreaterThan(short.box + 100);
  const now = await boxAndText(page);
  expect(now.box).toBeGreaterThan(now.text);

  const saved = await saveAs(page, 'svg');
  expect(saved.text).toContain(long);
  expect(await boxIn(page, saved.text)).toBeCloseTo(now.box, 3);
  await expect.poll(async () => {
    const stored = (await storedOpenDocument(page))?.lastGoodSvg;
    return stored === undefined || !stored.includes(long) ? 0 : boxIn(page, stored);
  }).toBeCloseTo(now.box, 3);
});
