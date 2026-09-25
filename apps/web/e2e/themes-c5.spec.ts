import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  EXAMPLE_NODE_COUNT,
  editorText,
  layoutGeometryHash,
  renderedSvg,
  setSource,
  storedOpenDocument,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
  waitForTheme,
} from './helpers.js';

/**
 * C5 (DD-04 §7, DD-08 §10): Theme ▾ lists the four built-in themes, and a pick
 * of any of them is paint only — the source untouched, the geometry the same,
 * only the `<style>` text different. `print` paints every shape white with a
 * black outline and every text black; `high-contrast` is black on white.
 */

const withoutStyle = (markup: string): string => markup.replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
const styleText = (markup: string): string => /<style>[\s\S]*?<\/style>/.exec(markup)?.[0] ?? '';

/** Computed paint of the rendered canvas, the node shapes, the node titles and the edges. */
async function computedPaint(page: Page): Promise<{ readonly canvas: string; readonly fills: string[]; readonly strokes: string[]; readonly texts: string[]; readonly edges: string[] }> {
  return renderedSvg(page).evaluate((svg) => {
    const all = (sel: string, prop: 'fill' | 'stroke'): string[] => [...new Set([...svg.querySelectorAll(sel)].map((el) => getComputedStyle(el)[prop]))].sort();
    return {
      canvas: getComputedStyle(svg.querySelector('rect.canvas')!).fill,
      fills: all('.n-shape, .c-shape', 'fill'),
      strokes: all('.n-shape, .c-shape', 'stroke'),
      texts: all('.n-title, .c-title, .el-text', 'fill'),
      edges: all('.e-path', 'stroke'),
    };
  });
}

const WHITE = 'rgb(255, 255, 255)';
const BLACK = 'rgb(0, 0, 0)';

test('Theme ▾ lists all four built-in themes with a swatch', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect(page.locator('.theme-picker select option')).toHaveText(['High Contrast', 'Neutral Dark', 'Neutral Light', 'Print']);
  await page.locator('.theme-picker select').selectOption('high-contrast');
  await waitForTheme(page, 'high-contrast');
  const swatch = await page.locator('.theme-picker .swatch i').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(swatch).toEqual([WHITE, WHITE, BLACK, 'rgb(0, 51, 184)']);
});

test('picking each theme changes the paint only: the source is untouched and the geometry the same', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await waitForTheme(page, 'neutral-light');
  const text = await editorText(page);
  const geometry = await layoutGeometryHash(page);
  let previous = await renderedSvg(page).innerHTML();

  for (const id of ['high-contrast', 'print', 'neutral-dark', 'print', 'high-contrast', 'neutral-light']) {
    await page.locator('.theme-picker select').selectOption(id);
    await waitForTheme(page, id);
    const now = await renderedSvg(page).innerHTML();
    expect(styleText(now), `${id}: the paint changed`).not.toBe(styleText(previous));
    expect(withoutStyle(now), `${id}: the same tree`).toBe(withoutStyle(previous));
    expect(await layoutGeometryHash(page), `${id}: the same geometry`).toBe(geometry);
    expect(await editorText(page), `${id}: the source untouched`).toBe(text);

    const paint = await computedPaint(page);
    if (id === 'print') {
      // The example's own colour (the api's red stroke) is lost by design.
      expect(paint).toEqual({ canvas: WHITE, fills: [WHITE], strokes: [BLACK], texts: [BLACK], edges: [BLACK] });
    } else if (id === 'high-contrast') {
      expect(paint.canvas).toBe(WHITE);
      expect(paint.edges).toEqual([BLACK]);
      expect(paint.texts).toContain(BLACK);
    }
    previous = now;
  }
  await expect.poll(async () => (await storedOpenDocument(page))?.themeId).toBe('neutral-light');
});

test('a stored record whose theme is print or high-contrast boots in it, and a share link carries t= for either', async ({ page, browser }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  for (const id of ['print', 'high-contrast']) {
    await page.locator('.theme-picker select').selectOption(id);
    await waitForTheme(page, id);
    const painted = await renderedSvg(page).innerHTML();
    await expect.poll(async () => (await storedOpenDocument(page))?.themeId).toBe(id);
    await page.reload();
    await waitForTheme(page, id);
    await expect(page.locator('.theme-picker select')).toHaveValue(id);
    expect(await renderedSvg(page).innerHTML()).toBe(painted);
  }

  // A link made outside the app, with t=print, opens in print.
  const shared = 'a: "Alpha"\nb: "Beta"\na -> b: "link"\n';
  const hash = `#s=${deflateRawSync(Buffer.from(shared, 'utf8')).toString('base64url')}&e=sgl.grid&t=print`;
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await other.goto(`/${hash}`);
    await waitForExactNodeCount(other, visibleNodeCount(shared));
    await waitForTheme(other, 'print');
    await expect(other.locator('.theme-picker select')).toHaveValue('print');
    expect(await editorText(other)).toBe(shared);
    expect((await computedPaint(other)).fills).toEqual([WHITE]);
    await expect.poll(async () => (await storedOpenDocument(other))?.themeId).toBe('print');
  } finally {
    await context.close();
  }
});

test('a document\'s own @theme: "high-contrast" or "print" is honoured, and the pick edits it in place', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  const body = 'a: "Alpha"\nb: "Beta"\na -> b\n';
  await setSource(page, `@theme: "high-contrast"\n${body}`);
  await waitForExactNodeCount(page, 2);
  await waitForTheme(page, 'high-contrast');
  await page.locator('.theme-picker select').selectOption('print');
  await waitForTheme(page, 'print');
  expect(await editorText(page)).toBe(`@theme: "print"\n${body}`);
});
