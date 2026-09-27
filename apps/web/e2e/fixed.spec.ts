import { expect, test, type Page } from '@playwright/test';
import { diagnosticCodes, EXAMPLE_NODE_COUNT, layoutGeometryHash, setSource, switchEngine, visibleNodeCount, waitForExactNodeCount } from './helpers.js';

/**
 * B5 branch 2, `fixed` end to end (DD-12 §12 item 6): Engine ▾ lists it with
 * its `bitwise` badge; picking it honours `@pin`s, relative to the parent's
 * content box (H2); an unpinned node is placed below the pinned ones and is
 * one SGL4020 squiggle at its own line, which follows an edit above it; a
 * document's bare `engine: fixed` selects it; its Options ▾ form has Gap.
 */

/** The first `M x y` of a node's (or container's) shape path: for two nodes of
 *  the same shape, their difference is the difference of their frames. */
async function origin(page: Page, id: string): Promise<{ readonly x: number; readonly y: number }> {
  const d = await page.locator(`[id="${id}"] > path.n-shape, [id="${id}"] > path.c-shape`).first().getAttribute('d');
  const m = /^M\s*(-?[\d.]+)[ ,](-?[\d.]+)/.exec(d ?? '');
  if (m === null) throw new Error(`no shape path for ${id}: ${String(d)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function nodeElementId(page: Page, label: string): Promise<string> {
  const id = await page.locator('g.L-nodes > g.n, g.L-containers > g.c').filter({ hasText: new RegExp(`^${label}$`) }).first().getAttribute('id');
  if (id === null) throw new Error(`no node labelled ${label}`);
  return id;
}

const PINNED = 'a: { @label: "A", @pin: { x: 200, y: 0 } }\nb: { @label: "B", @pin: { x: 0, y: 100 } }\nc: "C"\na -> b\n';

test('Engine ▾ lists fixed as bitwise; picking it honours pins, and an unpinned node is one SGL4020 at its line, which follows an edit', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const fixedOption = page.locator('.engine-picker select option[value="sgl.fixed"]');
  await expect(fixedOption).toHaveCount(1);
  await expect(fixedOption).toHaveText('Fixed');

  await setSource(page, PINNED);
  await waitForExactNodeCount(page, 3);
  // Under elk (the default) the pins are ignored, with a warning each.
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL4021', 'SGL4021']);

  await switchEngine(page, 'sgl.fixed', await layoutGeometryHash(page));
  await expect(page.locator('.engine-picker .determinism-badge')).toHaveText('bitwise');
  await waitForExactNodeCount(page, 3);
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL4020']);
  await expect(page.locator('.diagnostics-panel')).toContainText('`c` has no `@pin`; `fixed` placed it below the pinned nodes.');
  const warned = page.locator('.cm-content .cm-lintRange-warning');
  await expect(warned).toHaveCount(1);
  await expect(warned).toHaveText('c: "C"');

  // The pins: b is 200 px left of a and 100 px below it.
  const a = await origin(page, await nodeElementId(page, 'A'));
  const b = await origin(page, await nodeElementId(page, 'B'));
  expect([b.x - a.x, b.y - a.y]).toEqual([-200, 100]);
  // c is below both pinned nodes, at the leftmost pin.
  const c = await origin(page, await nodeElementId(page, 'C'));
  expect(c.y).toBeGreaterThan(b.y);
  expect(c.x).toBe(b.x);

  // An edit above it: the squiggle moves with the line.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('// moved\n');
  await expect(warned).toHaveCount(1);
  await expect(warned).toHaveText('c: "C"');
});

test('a document naming `engine: fixed` selects it; nested pins are relative to the container; its Options ▾ has Gap', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = '@layout: { engine: fixed }\nbox: {\n  @label: "Box"\n  @pin: { x: 300, y: 100 }\n  a: { @label: "A", @pin: { x: 0, y: 0 } }\n  b: { @label: "B", @pin: { x: 120, y: 0 } }\n}\nc: "C"\nd: "D"\n';
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.fixed');
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL4020', 'SGL4020']);

  // Nested pins are relative to the container's content box.
  const a = await origin(page, await nodeElementId(page, 'A'));
  const b = await origin(page, await nodeElementId(page, 'B'));
  expect([b.x - a.x, b.y - a.y]).toEqual([120, 0]);

  // Options ▾: one field, Gap; a new gap moves the packed nodes.
  const options = page.locator('.engine-options');
  await options.locator('summary').click();
  const gap = page.getByLabel('Gap');
  await expect(gap).toHaveValue('24');
  await expect(gap).toHaveAttribute('max', '200');
  await expect(options.locator('form select, form input')).toHaveCount(1);
  const before = await layoutGeometryHash(page);
  const dBefore = await origin(page, await nodeElementId(page, 'D'));
  const cBefore = await origin(page, await nodeElementId(page, 'C'));
  await gap.fill('80');
  await gap.blur();
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(before);
  const dAfter = await origin(page, await nodeElementId(page, 'D'));
  const cAfter = await origin(page, await nodeElementId(page, 'C'));
  expect(dAfter.x - cAfter.x - (dBefore.x - cBefore.x)).toBe(56);
});
