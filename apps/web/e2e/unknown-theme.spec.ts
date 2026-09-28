import { expect, test } from '@playwright/test';
import { diagnosticCodes, EXAMPLE_NODE_COUNT, setSource, SMALL_SOURCE, visibleNodeCount, waitForExactNodeCount, waitForNodeCount, waitForTheme } from './helpers.js';

/** F31 (human decision 2026-09-27): a `@theme` that names no built-in theme
 *  is `SGL5007`, a warning at the key. The diagram still draws, in the
 *  default theme, as before; fixing the name clears the warning. */
test('a typo in @theme shows SGL5007 in the diagnostics panel, squiggles the key, and the diagram stays', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  const source = `@theme: "neutral-drak"\n${SMALL_SOURCE}`;
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL5007']);
  await expect(page.locator('.diagnostics-panel')).toContainText('Unknown theme `neutral-drak`; using the default.');
  const warned = page.locator('.cm-content .cm-lintRange-warning');
  await expect(warned).toHaveCount(1);
  await expect(warned).toHaveText('@theme');

  // Fixed, the warning goes and the named theme draws.
  const fixed = `@theme: "neutral-dark"\n${SMALL_SOURCE}`;
  await setSource(page, fixed);
  await waitForTheme(page, 'neutral-dark');
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
  await waitForExactNodeCount(page, visibleNodeCount(fixed));
});
