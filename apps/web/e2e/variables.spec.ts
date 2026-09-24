import { expect, test } from '@playwright/test';
import {
  diagnosticCodes,
  EXAMPLE_NODE_COUNT,
  renderedSvg,
  setSource,
  sourceDiagnostics,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/** A8, variables (language spec §5), end to end in the app: a `$name` stroke
 *  paints the node with the variable's colour, live, and nothing reports the
 *  retired SGL2009. Before the `@vars` exists the reference is SGL2013. */
test('`@style.stroke: $c` paints the node with `@vars.c`, and no SGL2009 appears', async ({ page }) => {
  const use = 'a: { @style.stroke: $c }\n';
  const withVars = `@vars: { c: "#DC2626" }\n${use}`;
  expect(sourceDiagnostics(use).map((d) => d.code)).toEqual(['SGL2013']);
  expect(sourceDiagnostics(withVars)).toEqual([]);

  const stroke = () =>
    renderedSvg(page)
      .locator('g.L-nodes > g.n > path.n-shape')
      .first()
      .evaluate((el) => getComputedStyle(el).stroke);

  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);

  // An error-carrying document keeps the last good picture up (FR-E4, DD-08), so
  // only the panel is checked here.
  await setSource(page, use);
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL2013']);

  await setSource(page, withVars);
  await waitForExactNodeCount(page, 1);
  await expect.poll(() => diagnosticCodes(page)).toEqual([]);
  await expect.poll(stroke).toBe('rgb(220, 38, 38)');
  expect(await diagnosticCodes(page)).not.toContain('SGL2009');
});
