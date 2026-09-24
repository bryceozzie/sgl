import { expect, test } from '@playwright/test';
import {
  diagnosticCodes,
  editorText,
  EXAMPLE_NODE_COUNT,
  renderedSvg,
  setSource,
  sourceDiagnostics,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/** Wildcards in parent path segments (language spec §3, human decision
 *  2026-09-24), end to end in the app: typing `store*.api* -> payments.api`
 *  into a document with two `store*` containers renders one edge per match
 *  and reports nothing. */
test('typing `store*.api* -> payments.api` renders one edge per match and no diagnostics', async ({ page }) => {
  const base = 'payments: { api: {} }\nstore1: { api: {} apiV2: {} db: {} }\nstore2: { api: {} cache: {} }\n';
  const edge = 'store*.api* -> payments.api';
  const finalSource = base + edge;
  // store1.api, store1.apiV2, store2.api — pinned against the real compiler.
  expect(sourceDiagnostics(finalSource)).toEqual([]);

  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, base);
  await waitForExactNodeCount(page, visibleNodeCount(base));
  await expect(renderedSvg(page).locator('g.L-edges path.e-path')).toHaveCount(0);

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(edge);
  expect(await editorText(page)).toBe(finalSource);

  await expect(renderedSvg(page).locator('g.L-edges path.e-path')).toHaveCount(3);
  await expect.poll(() => diagnosticCodes(page)).toEqual([]);
  await waitForExactNodeCount(page, visibleNodeCount(base));
});
