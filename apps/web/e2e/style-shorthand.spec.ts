import { expect, test } from '@playwright/test';
import { diagnosticCodes, EXAMPLE_NODE_COUNT, renderedSvg, waitForNodeCount } from './helpers.js';

/** DD-13 §13 branch 0 (`fix/style-shorthand`, human decision 2026-09-27): a
 *  `@style` that is not an object is `SGL2011` and ignored, so the first-run
 *  example writes its dashed edge as `@style: { strokeDash: "6 3" }`. Until
 *  then it wrote `@style: dashed`, which drew a solid line and said nothing. */
test('the first-run example has no diagnostics and draws its async edge dashed', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);

  const asyncEdge = renderedSvg(page).locator('g.e[aria-label="payments.api to payments.outbox: async"] path.e-path');
  await expect(asyncEdge).toHaveCount(1);
  const dash = await asyncEdge.evaluate((el) => getComputedStyle(el).strokeDasharray);
  expect(dash.replace(/px/g, '').replace(/,\s*/g, ' ')).toBe('6 3');

  expect(await diagnosticCodes(page)).toEqual([]);
});
