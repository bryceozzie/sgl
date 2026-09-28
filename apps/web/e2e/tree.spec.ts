import { expect, test, type Page } from '@playwright/test';
import { diagnosticCodes, EXAMPLE_NODE_COUNT, edgePaths, layoutGeometryHash, setSource, switchEngine, visibleNodeCount, waitForExactNodeCount } from './helpers.js';

/**
 * B5 branch 4, `tree` end to end (DD-12 §12 item 6): Engine ▾ lists it with
 * its `bitwise` badge; picking it lays out a tidy tree with elbow edges, and
 * loads the lazy `std-trees` chunk into the layout worker then, not at boot
 * (N52); a document's bare `engine: tree` selects it; its Options ▾ form has
 * Direction, the spacings and Edges; and if the chunk cannot be fetched, the
 * request fails as elk's does (SGL4011, the previous picture kept) and the
 * next edit loads it.
 */

const TREE = 'top: "Top"\nleft: "Left"\nright: "Right"\nleaf: "Leaf"\ntop -> left\ntop -> right\nleft -> leaf\n';
const CHUNK = /\/assets\/std-trees-[^/]*\.js$/;

/** A node's (or container's) shape box, by its label, in SVG coordinates. */
async function box(page: Page, label: string): Promise<{ readonly x: number; readonly y: number; readonly w: number; readonly h: number }> {
  const node = page.locator('g.L-nodes > g.n, g.L-containers > g.c').filter({ hasText: new RegExp(`^${label}$`) }).first();
  return node.locator('path.n-shape, path.c-shape').first().evaluate((p) => {
    const b = (p as SVGGraphicsElement).getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

/** Every vertex of an edge path's `M`/`L` commands. */
function vertices(d: string): { x: number; y: number }[] {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
}

test('Engine ▾ lists tree as bitwise; picking it lays out a tidy tree with elbows, loading the std-trees chunk then, not at boot', async ({ page, context }) => {
  const chunkRequests: string[] = [];
  // The context, not the page: the layout worker fetches the chunk.
  context.on('request', (r) => {
    if (CHUNK.test(new URL(r.url()).pathname)) chunkRequests.push(r.url());
  });
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const option = page.locator('.engine-picker select option[value="sgl.tree"]');
  await expect(option).toHaveCount(1);
  await expect(option).toHaveText('Tree');
  expect(chunkRequests).toEqual([]); // not at boot, and not for elk

  await setSource(page, TREE);
  await waitForExactNodeCount(page, 4);
  await switchEngine(page, 'sgl.tree', await layoutGeometryHash(page));
  await expect(page.locator('.engine-picker .determinism-badge')).toHaveText('bitwise');
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
  expect(chunkRequests).toHaveLength(1);

  // A tidy tree: top above left and right, centred over them; leaf below left.
  const [top, left, right, leaf] = await Promise.all(['Top', 'Left', 'Right', 'Leaf'].map((l) => box(page, l)));
  expect(left!.y).toBeGreaterThan(top!.y + top!.h);
  expect(left!.y).toBe(right!.y);
  expect(top!.x + top!.w / 2).toBeCloseTo((left!.x + left!.w / 2 + right!.x + right!.w / 2) / 2, 1);
  expect(leaf!.y).toBeGreaterThan(left!.y + left!.h);
  // Elbows: every edge runs in horizontal and vertical segments only.
  const paths = await edgePaths(page);
  expect(paths).toHaveLength(3);
  for (const d of paths) {
    const v = vertices(d);
    expect(v.length, d).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < v.length; i += 1) expect(v[i]!.x === v[i - 1]!.x || v[i]!.y === v[i - 1]!.y, d).toBe(true);
  }
  expect(paths.some((d) => vertices(d).length === 4)).toBe(true); // down, across, down

  // Back to elk and to tree again: the chunk is not fetched twice.
  await switchEngine(page, 'sgl.elk', await layoutGeometryHash(page));
  await switchEngine(page, 'sgl.tree', await layoutGeometryHash(page));
  expect(chunkRequests).toHaveLength(1);
});

test('a document naming `engine: tree` selects it; Options ▾ has Direction, spacings and Edges, and Direction: right turns the tree', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = `@layout: { engine: tree }\n${TREE}`;
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.tree');
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  const options = page.locator('.engine-options');
  await options.locator('summary').click();
  await expect(options.locator('form select, form input')).toHaveCount(4);
  await expect(page.getByLabel('Direction')).toHaveValue('down');
  await expect(page.getByLabel('Node spacing')).toHaveValue('40');
  await expect(page.getByLabel('Rank spacing')).toHaveAttribute('max', '500');
  await expect(page.getByLabel('Edges')).toHaveValue('orthogonal');

  const before = await layoutGeometryHash(page);
  await page.getByLabel('Direction').selectOption('right');
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(before);
  const [top, left] = await Promise.all(['Top', 'Left'].map((l) => box(page, l)));
  expect(left!.x).toBeGreaterThan(top!.x + top!.w);

  // Edges: straight — no more elbows.
  const elbows = await layoutGeometryHash(page);
  await page.getByLabel('Edges').selectOption('straight');
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(elbows);
  for (const d of await edgePaths(page)) expect(vertices(d), d).toHaveLength(2);
});

/**
 * Degradation, as `elk`'s lazy chunk degrades (DD-06 §3): the request fails
 * with SGL4011 naming the engine, the previous picture stays, and the app
 * goes on working under another engine. The browser's module map remembers a
 * failed dynamic import for the life of the worker, so a retry in the same
 * worker fails again (as elk's would); the chunk loads with the next worker,
 * here a reload with the network back.
 */
test('if the std-trees chunk cannot be fetched: SGL4011 and the previous picture kept, as elk; other engines still work; a reload loads it', async ({ page, context }) => {
  let block = true;
  await context.route(CHUNK, (route) => (block ? route.abort() : route.continue()));
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, TREE);
  await waitForExactNodeCount(page, 4);
  const underElk = await layoutGeometryHash(page);

  await page.locator('.engine-picker select').selectOption('sgl.tree');
  await expect.poll(() => diagnosticCodes(page), { timeout: 20_000 }).toEqual(['SGL4011']);
  await expect(page.locator('.diagnostics-panel')).toContainText('Layout engine `sgl.tree` failed');
  expect(await layoutGeometryHash(page)).toBe(underElk); // the previous layout stays

  // The worker is not stuck: grid lays out, and the error is gone.
  await switchEngine(page, 'sgl.grid', underElk);
  await expect.poll(() => diagnosticCodes(page), { timeout: 20_000 }).toEqual([]);

  // With the network back, the next worker loads the chunk.
  block = false;
  await page.locator('.engine-picker select').selectOption('sgl.tree');
  await page.reload();
  await waitForExactNodeCount(page, 4);
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.tree');
  await expect.poll(() => diagnosticCodes(page), { timeout: 20_000 }).toEqual([]);
  const [top, left] = await Promise.all(['Top', 'Left'].map((l) => box(page, l)));
  expect(left!.y).toBeGreaterThan(top!.y + top!.h);
});
