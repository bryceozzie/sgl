import { expect, test, type Page } from '@playwright/test';
import { corpusDoc, EXAMPLE_NODE_COUNT, renderedSvg, setSource, storedOpenDocument, visibleNodeCount, waitForExactNodeCount } from './helpers.js';

/**
 * DD-12 H6 (N40) end to end: the root `@layout` options reach the engine.
 * `corpus/checkout.sgl` says `@layout: { engine: "elk", direction: right }`,
 * so under `elk` every edge elk lays out runs left to right; Options ▾ shows
 * Direction as the document's, disabled, and the stored options are not
 * touched. Since B8 (DD-14) `payments` is a `grid` box of two columns: the
 * edges inside it are grid's, and the ones across it are drawn straight end
 * to end (DD-14 §11.1 deviation 1), so only the edges outside it count.
 */

const CHECKOUT = corpusDoc('checkout.sgl');

/** For each edge with neither end in `payments`, whether its source's centre
 *  is left of its target's. The endpoints are read from the edge's
 *  `aria-label` ("a to b" or "a to b: label"). */
async function edgesRightwards(page: Page): Promise<boolean[]> {
  return renderedSvg(page).evaluate((svg) =>
    [...svg.querySelectorAll('g.L-edges > g.e')].flatMap((edge) => {
      const [from, to] = (edge.getAttribute('aria-label') ?? '').replace(/:.*$/, '').split(' to ');
      if (from?.startsWith('payments.') || to?.startsWith('payments.')) return [];
      const cx = (id: string | undefined) => {
        const box = (svg.querySelector(`[id="n-${id}"]`) as SVGGraphicsElement).getBBox();
        return box.x + box.width / 2;
      };
      return [cx(from) < cx(to)];
    }),
  );
}

async function openOptions(page: Page): Promise<void> {
  const options = page.locator('.engine-options');
  if ((await options.getAttribute('open')) === null) await options.locator('summary').click();
  await expect(options.locator('form')).toBeVisible();
}

test("checkout.sgl's `direction: right` lays it out rightwards under elk, and the form shows it as the document's", async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, CHECKOUT);
  await waitForExactNodeCount(page, visibleNodeCount(CHECKOUT));
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');

  // Both edges outside `payments` run left to right.
  await expect.poll(() => edgesRightwards(page), { timeout: 20_000 }).toEqual([true, true]);

  await openOptions(page);
  const direction = page.getByLabel('Direction (set by document)');
  await expect(direction).toHaveValue('right');
  await expect(direction).toBeDisabled();
  await expect(page.getByLabel('Node spacing', { exact: true })).toBeEnabled();
  // The editor's own options are not written: the override is the document's.
  await expect.poll(async () => (await storedOpenDocument(page))?.engineOptions?.['direction'] ?? 'down').toBe('down');

  // Without it, elk lays the document out downwards again, and the field is the form's.
  await setSource(page, CHECKOUT.replace(', direction: right', ''));
  await expect.poll(async () => (await edgesRightwards(page)).every(Boolean), { timeout: 20_000 }).toBe(false);
  await expect(page.getByLabel('Direction', { exact: true })).toHaveValue('down');
  await expect(page.getByLabel('Direction', { exact: true })).toBeEnabled();
});

test('a root option the engine does not declare is SGL4010, and a value it cannot take is SGL2011; the diagram stays', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = '@layout: { engine: elk, columns: 2, nodeSpacing: 9000 }\na: "A"\nb: "B"\na -> b\n';
  await setSource(page, source);
  await waitForExactNodeCount(page, 2);
  await expect.poll(async () => (await page.locator('.diagnostics-panel .diag .diag-code').allTextContents()).sort()).toEqual(['SGL2011', 'SGL4010']);
  await openOptions(page);
  await expect(page.getByLabel('Node spacing', { exact: true })).toHaveValue('40');
  await expect(page.getByLabel('Node spacing', { exact: true })).toBeEnabled();
});
