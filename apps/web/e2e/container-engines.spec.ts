import { expect, test, type Page } from '@playwright/test';
import { corpusDoc, diagnosticCodes, EXAMPLE_NODE_COUNT, edgePaths, layoutGeometryHash, setSource, visibleNodeCount, waitForExactNodeCount } from './helpers.js';

/**
 * B8 branch 2 (DD-14 §10 item 6): a container's own layout engine, end to
 * end. Spec §9's worked example (`corpus/checkout.sgl`) draws `payments` as a
 * two-column grid inside the elk document, with no warning (F29); the
 * composer is the layout worker's lazy `compose` chunk, fetched for the first
 * document that needs it, not at boot; editing a container's engine lays it
 * out again; an engine that is not available is SGL4012, at the key. Offline
 * use is `offline.spec.ts`'s.
 */

const COMPOSE = /\/assets\/compose-[^/]*\.js$/;

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** A node's (or container's) shape box, by its label, in SVG coordinates. */
async function box(page: Page, label: string): Promise<Box> {
  const node = page.locator('g.L-nodes > g.n, g.L-containers > g.c').filter({ hasText: new RegExp(`^${label}$`) }).first();
  return node.locator('path.n-shape, path.c-shape').first().evaluate((p) => {
    const b = (p as SVGGraphicsElement).getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

const centreY = (b: Box): number => b.y + b.h / 2;

test('spec §9: payments is a two-column grid inside the elk document, with no warning; the compose chunk loads then, not at boot', async ({ page, context }) => {
  const chunkRequests: string[] = [];
  // The context, not the page: the layout worker fetches the chunk.
  context.on('request', (r) => {
    if (COMPOSE.test(new URL(r.url()).pathname)) chunkRequests.push(r.url());
  });
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  expect(chunkRequests).toEqual([]); // the welcome example names no container engine

  const spec = corpusDoc('checkout.sgl');
  await setSource(page, spec);
  await waitForExactNodeCount(page, visibleNodeCount(spec));
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');
  // `cloud` is a shape this version does not draw (SGL3006, info): nothing
  // about layout, no warning, no error.
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL3006', 'SGL3006']);
  await expect(page.locator('.diagnostics-panel .diag-warning, .diagnostics-panel .diag-error')).toHaveCount(0);

  await expect.poll(async () => {
    const [api, ledger, outbox] = await Promise.all(['api', 'ledger', 'outbox'].map((l) => box(page, l)));
    return (
      Math.abs(centreY(ledger!) - centreY(api!)) < 1 && // one row …
      ledger!.x > api!.x + api!.w &&
      outbox!.y > api!.y + api!.h && // … and a second
      Math.abs(outbox!.x + outbox!.w / 2 - (api!.x + api!.w / 2)) < 1 // under the first cell
    );
  }).toBe(true);
  // Every node's box is inside `payments`' box.
  const payments = await box(page, 'Payments');
  for (const l of ['api', 'ledger', 'outbox']) {
    const b = await box(page, l);
    expect(b.x >= payments.x && b.y >= payments.y && b.x + b.w <= payments.x + payments.w && b.y + b.h <= payments.y + payments.h, l).toBe(true);
  }
  expect(chunkRequests).toHaveLength(1);
});

test("editing a container's engine lays it out again; removing it gives the one-engine picture back", async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const doc = (layout: string): string => `top: "Top"\nrow: {\n  @label: "Row"\n${layout}  a: "A"\n  b: "B"\n  c: "C"\n  a -> b\n  b -> c\n}\ntop -> row\n`;

  // No container engine: one elk run, flowing down.
  await setSource(page, doc(''));
  await waitForExactNodeCount(page, 5);
  await expect.poll(async () => (await box(page, 'B')).y > (await box(page, 'A')).y).toBe(true);
  const plain = await layoutGeometryHash(page);

  // `row` laid out rightwards by its own elk run (DD-14 C2).
  await setSource(page, doc('  @layout: { engine: elk, direction: right }\n'));
  await expect.poll(async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((l) => box(page, l)));
    return b!.x > a!.x + a!.w && c!.x > b!.x + b!.w && Math.abs(centreY(a!) - centreY(c!)) < 1;
  }).toBe(true);
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  // Its engine changed to grid, two columns: a, b in one row, c below.
  await setSource(page, doc('  @layout: { engine: grid, columns: 2 }\n'));
  await expect.poll(async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((l) => box(page, l)));
    return Math.abs(centreY(a!) - centreY(b!)) < 1 && c!.y > a!.y + a!.h;
  }).toBe(true);
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  // The key removed: the picture is the one-engine one again, exactly.
  await setSource(page, doc(''));
  await expect.poll(() => layoutGeometryHash(page)).toBe(plain);
});

test('an engine that is not available is SGL4012 with a squiggle at the key, and the container is laid out by the engine around it', async ({ page }) => {
  await page.goto('/');
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = 'box: {\n  @label: "Box"\n  @layout: { engine: dagre }\n  a: "A"\n  b: "B"\n  a -> b\n}\n';
  await setSource(page, source);
  await waitForExactNodeCount(page, visibleNodeCount(source));
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL4012']);
  await expect(page.locator('.diagnostics-panel')).toContainText('Layout engine `dagre` is not available; `box` is laid out by `sgl.elk`.');
  const warned = page.locator('.cm-content .cm-lintRange-warning');
  await expect(warned).toHaveCount(1);
  await expect(warned).toHaveText('engine');
  // Laid out by elk, flowing down, and on screen.
  await expect.poll(async () => (await box(page, 'B')).y > (await box(page, 'A')).y).toBe(true);
  expect((await edgePaths(page)).length).toBeGreaterThan(0);
});
