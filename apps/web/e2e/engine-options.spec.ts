import { expect, test, type Page } from '@playwright/test';
import {
  diagnosticCodes,
  EXAMPLE_NODE_COUNT,
  layoutGeometryHash,
  patchStoredOpenDocument,
  setSource,
  storedOpenDocument,
  switchEngine,
  visibleNodeCount,
  waitForExactNodeCount,
} from './helpers.js';

/**
 * F11 end to end (Stage K fix round 1, items 3, 13, 22): the options form
 * beside Engine ▾ changes the layout, the change persists with the document,
 * switching engines resets it, a bad stored bag still renders exactly what
 * the form shows, and a refused value is flagged rather than shown.
 */

const options = (page: Page) => page.locator('.engine-options');

async function openOptions(page: Page): Promise<void> {
  if ((await options(page).getAttribute('open')) === null) await options(page).locator('summary').click();
  await expect(options(page).locator('form')).toBeVisible();
}

test('13: Direction → Right re-lays out, persists across a reload, and an engine switch resets it to elk\'s defaults', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const defaultGeometry = await layoutGeometryHash(page);

  await openOptions(page);
  await expect(page.getByLabel('Direction')).toHaveValue('down');
  await page.getByLabel('Direction').selectOption('right');
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(defaultGeometry);
  const rightGeometry = await layoutGeometryHash(page);

  // Persisted with the document (DD-08 §9's autosave) …
  await expect.poll(async () => (await storedOpenDocument(page))?.engineOptions?.['direction']).toBe('right');
  await page.reload();
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  // … so the reload lays out the same, and the form says why.
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).toBe(rightGeometry);
  await openOptions(page);
  await expect(page.getByLabel('Direction')).toHaveValue('right');

  // Switching engine resets the options to the new engine's defaults (DD-08 §10) …
  await switchEngine(page, 'sgl.grid', rightGeometry);
  await openOptions(page);
  await expect(page.getByLabel('Columns')).toHaveValue('');
  await expect(page.getByLabel('Gap')).toHaveValue('24');
  // … and back to elk: elk's defaults, and elk's default layout again.
  await switchEngine(page, 'sgl.elk', await layoutGeometryHash(page));
  await openOptions(page);
  await expect(page.getByLabel('Direction')).toHaveValue('down');
  await expect(page.getByLabel('Node spacing')).toHaveValue('40');
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).toBe(defaultGeometry);
});

test('3: a stored record whose options the engine cannot use renders with what the form shows', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect.poll(async () => (await storedOpenDocument(page))?.id).toBeDefined();
  // As if written by an older version: grid, with a columns value grid cannot
  // use. Written from a same-origin page that is not the app, after the app
  // has left (its pagehide flush would otherwise write the record back).
  await page.goto('/manifest.webmanifest');
  await patchStoredOpenDocument(page, { engineId: 'sgl.grid', engineOptions: { columns: 'x', gap: 'wide' } });
  await page.goto('/');

  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.grid');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0); // no SGL4011
  await openOptions(page);
  await expect(page.getByLabel('Columns')).toHaveValue(''); // automatic …
  await expect(page.getByLabel('Gap')).toHaveValue('24'); // … and the default gap: what grid was sent.
});

test('23: a container asking for its own engine under elk gets an SGL4010 warning with a squiggle; the diagram stays (human decision 2026-09-23)', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  // The welcome example no longer nests an engine: a first visit shows no warning.
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  const source = 'box: {\n  @label: "Box"\n  @layout: { engine: grid }\n  a: "A"\n  b: "B"\n  a -> b\n}\n';
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL4010']);
  await expect(page.locator('.diagnostics-panel')).toContainText('`@layout.engine` is not an option of engine `sgl.elk`; ignored.');
  // A warning squiggle, exactly over the key.
  const warned = page.locator('.cm-content .cm-lintRange-warning');
  await expect(warned).toHaveCount(1);
  await expect(warned).toHaveText('engine');
  // Still laid out by elk, and on screen.
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');
  await waitForExactNodeCount(page, visibleNodeCount(source));
});

test('22: a refused value is marked invalid, explained, and not left showing', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const before = await layoutGeometryHash(page);
  await openOptions(page);

  const spacing = page.getByLabel('Node spacing');
  await expect(spacing).toHaveAttribute('max', '500');
  await expect(page.getByLabel('Rank spacing')).toHaveAttribute('max', '500');
  await spacing.fill('9000');
  await spacing.press('Enter');
  await spacing.blur();

  await expect(spacing).toHaveAttribute('aria-invalid', 'true');
  await expect(options(page).locator('.options-error')).toHaveText('Node spacing must be a number from 0 to 500. Using 40.');
  await expect(spacing).toHaveValue('40'); // the value in use, not the refused one
  expect(await layoutGeometryHash(page)).toBe(before);

  // A good value clears it.
  await spacing.fill('60');
  await spacing.blur();
  await expect(spacing).not.toHaveAttribute('aria-invalid', 'true');
  await expect(options(page).locator('.options-error')).toHaveCount(0);
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(before);
});
