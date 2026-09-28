import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, edgePaths, layoutGeometryHash, setSource, switchEngine, visibleNodeCount, waitForExactNodeCount } from './helpers.js';

/**
 * B5 branch 5, `radial` end to end (DD-12 §12 item 6): Engine ▾ lists it
 * with its `bitwise` badge; picking it draws the root at the centre and its
 * children on a ring around it, with straight edges, and loads the lazy
 * `std-trees` chunk into the layout worker then, not at boot, once for both
 * `radial` and `tree` (N52); a document's bare `engine: radial` selects it;
 * its Options ▾ form has Node spacing and Ring spacing, and a root
 * `rankSpacing` reaches it (H6).
 */

const HUB = 'hub: "Hub"\nn: "North"\ne: "East"\ns: "South"\nw: "West"\nhub -> n\nhub -> e\nhub -> s\nhub -> w\n';
const CHUNK = /\/assets\/std-trees-[^/]*\.js$/;

/** A node's shape box, by its label, in SVG coordinates. */
async function box(page: Page, label: string): Promise<{ readonly x: number; readonly y: number; readonly w: number; readonly h: number }> {
  const node = page.locator('g.L-nodes > g.n').filter({ hasText: new RegExp(`^${label}$`) }).first();
  return node.locator('path.n-shape').first().evaluate((p) => {
    const b = (p as SVGGraphicsElement).getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Every hub-to-leaf distance, and each leaf's side of the hub. */
async function spokes(page: Page): Promise<{ readonly radii: number[]; readonly hub: { x: number; y: number }; readonly leaves: Record<string, { x: number; y: number }> }> {
  const hub = centre(await box(page, 'Hub'));
  const leaves: Record<string, { x: number; y: number }> = {};
  for (const l of ['North', 'East', 'South', 'West']) leaves[l] = centre(await box(page, l));
  return { hub, leaves, radii: Object.values(leaves).map((c) => Math.hypot(c.x - hub.x, c.y - hub.y)) };
}

test('Engine ▾ lists radial as bitwise; picking it puts the root at the centre and its children on a ring, loading std-trees once for radial and tree', async ({ page, context }) => {
  const chunkRequests: string[] = [];
  // The context, not the page: the layout worker fetches the chunk.
  context.on('request', (r) => {
    if (CHUNK.test(new URL(r.url()).pathname)) chunkRequests.push(r.url());
  });
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const option = page.locator('.engine-picker select option[value="sgl.radial"]');
  await expect(option).toHaveCount(1);
  await expect(option).toHaveText('Radial');
  expect(chunkRequests).toEqual([]); // not at boot

  await setSource(page, HUB);
  await waitForExactNodeCount(page, 5);
  await switchEngine(page, 'sgl.radial', await layoutGeometryHash(page));
  await expect(page.locator('.engine-picker .determinism-badge')).toHaveText('bitwise');
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
  expect(chunkRequests).toHaveLength(1);

  // The hub at the centre; its four children on one ring, the first at 45°
  // clockwise from 12 o'clock (each has a quarter of the circle).
  const { hub, leaves, radii } = await spokes(page);
  for (const r of radii) expect(r).toBeCloseTo(radii[0]!, 0);
  expect(leaves['North']!.x).toBeGreaterThan(hub.x);
  expect(leaves['North']!.y).toBeLessThan(hub.y);
  expect(leaves['East']!.y).toBeGreaterThan(hub.y);
  expect(leaves['West']!.x).toBeLessThan(hub.x);
  // Straight spokes: every edge is one segment.
  const paths = await edgePaths(page);
  expect(paths).toHaveLength(4);
  for (const d of paths) expect([...d.matchAll(/[ML]/g)], d).toHaveLength(2);

  // tree uses the same chunk: no second fetch; nor back to radial.
  await switchEngine(page, 'sgl.tree', await layoutGeometryHash(page));
  await switchEngine(page, 'sgl.radial', await layoutGeometryHash(page));
  expect(chunkRequests).toHaveLength(1);
});

test('a document naming `engine: radial` selects it; Options ▾ has Node spacing and Ring spacing, and Ring spacing widens the ring', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = `@layout: { engine: radial }\n${HUB}`;
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.radial');
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  const options = page.locator('.engine-options');
  await options.locator('summary').click();
  await expect(options.locator('form select, form input')).toHaveCount(2);
  await expect(page.getByLabel('Node spacing')).toHaveValue('40');
  await expect(page.getByLabel('Ring spacing')).toHaveValue('70');
  await expect(page.getByLabel('Ring spacing')).toHaveAttribute('max', '500');

  const before = (await spokes(page)).radii[0]!;
  const hash = await layoutGeometryHash(page);
  await page.getByLabel('Ring spacing').fill('170');
  await page.getByLabel('Ring spacing').blur();
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(hash);
  expect((await spokes(page)).radii[0]!).toBeCloseTo(before + 100, 0);
});

/** DD-12 H6 with `radial`: a root `rankSpacing` reaches it. */
test('a root `@layout.rankSpacing` widens the ring, and Options ▾ shows it as the document’s', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, `@layout: { engine: radial }\n${HUB}`);
  await waitForExactNodeCount(page, 5);
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.radial');
  const base = (await spokes(page)).radii[0]!;
  const hash = await layoutGeometryHash(page);
  await setSource(page, `@layout: { engine: radial, rankSpacing: 270 }\n${HUB}`);
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(hash);
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
  expect((await spokes(page)).radii[0]!).toBeCloseTo(base + 200, 0);
  await page.locator('.engine-options summary').click();
  await expect(page.getByLabel('Ring spacing (set by document)')).toHaveValue('270');
});
