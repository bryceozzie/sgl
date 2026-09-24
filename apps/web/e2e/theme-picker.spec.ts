import { expect, test, type Page } from '@playwright/test';
import {
  EXAMPLE_NODE_COUNT,
  editorText,
  renderedSvg,
  setSource,
  SMALL_SOURCE,
  storedOpenDocument,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
  waitForTheme,
} from './helpers.js';

/**
 * Theme ▾ (DD-08 §10) since F9: a view preference (P1, human decision
 * 2026-09-24) whose switch is a paint-only swap of the `<style>` text (P3),
 * with the stored picture still exactly a full render's (P4).
 */

const label = (page: Page) => page.locator('.theme-picker .picker-label');
const withoutStyle = (markup: string): string => markup.replace(/<style>[\s\S]*?<\/style>/, '<style></style>');

/** `svg` (a `render()` output, as stored) parsed the way the canvas parses
 *  it, and serialised the way `renderedSvg(page).innerHTML()` reads it. */
async function asCanvasDom(page: Page, svg: string): Promise<string> {
  return page.evaluate((text) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = text;
    return g.firstElementChild!.innerHTML;
  }, svg);
}

test('with no @theme the pick changes only the view: the source is untouched, the choice is stored and survives a reload, and the swapped DOM is exactly a fresh render', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await waitForTheme(page, 'neutral-light');
  const text = await editorText(page);
  expect(text).not.toContain('@theme'); // the example leaves the theme to the picker
  const light = await renderedSvg(page).innerHTML();

  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  await expect(label(page)).toHaveText('Theme'); // not "(set by document)"
  expect(await editorText(page)).toBe(text);
  const dark = await renderedSvg(page).innerHTML();
  expect(dark).not.toBe(light);
  expect(withoutStyle(dark)).toBe(withoutStyle(light)); // the same tree: only the <style> text was swapped

  // Autosave stores the view choice, and the picture the next boot paints
  // (J6) is exactly what is on screen.
  await expect.poll(async () => (await storedOpenDocument(page))?.themeId).toBe('neutral-dark');
  await expect.poll(async () => {
    const stored = (await storedOpenDocument(page))?.lastGoodSvg;
    return stored === undefined ? null : asCanvasDom(page, stored);
  }).toBe(dark);
  expect((await storedOpenDocument(page))?.source).toBe(text);

  // A reload renders the document afresh, in full, under the stored choice:
  // the very DOM the paint-only swap left.
  await page.reload();
  await waitForTheme(page, 'neutral-dark');
  await expect(page.locator('.theme-picker select')).toHaveValue('neutral-dark');
  await expect(label(page)).toHaveText('Theme');
  expect(await editorText(page)).toBe(text);
  expect(await renderedSvg(page).innerHTML()).toBe(dark);
});

test("with @theme the pick edits that entry in place, and the document's @theme still overrides the picker", async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = `@theme: "neutral-light"\n${SMALL_SOURCE}`;
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await waitForTheme(page, 'neutral-light');
  await expect(label(page)).toContainText('set by document');

  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  expect(await editorText(page)).toBe(`@theme: "neutral-dark"\n${SMALL_SOURCE}`); // in place, no second entry
  await expect(label(page)).toContainText('set by document');
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(`@theme: "neutral-dark"\n${SMALL_SOURCE}`);
});
