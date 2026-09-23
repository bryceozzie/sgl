import { expect, test, type Locator, type Page } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, openFile, renderedSvg, SMALL_SOURCE, visibleNodeCount, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/** DD-08 §6's canvas (`apps/web/src/canvas/Canvas.tsx`): the overlay as a
 *  sibling of the exported tree, hover and click from `lastGood.layout`
 *  frames, wheel zoom clamped to `[0.1, 8]`, drag to pan, and Fit. */

interface Transform {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

async function viewportTransform(page: Page): Promise<Transform> {
  const attr = (await page.locator('.canvas-host g.viewport').getAttribute('transform')) ?? '';
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(attr);
  if (m === null) throw new Error(`unexpected viewport transform: ${attr}`);
  return { tx: Number(m[1]), ty: Number(m[2]), k: Number(m[3]) };
}

/** The element's box in client pixels, from `getBoundingClientRect` — for
 *  the `<svg>` elements, whose box is their viewport. */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** An SVG shape's *geometry* box in client pixels: `getBBox()` mapped through
 *  `getScreenCTM()` (a scale plus translation here). Not `getBoundingClientRect`
 *  or Playwright's `boundingBox()`: Firefox includes the stroke in the first and
 *  every engine in the second, and the outline's stroke differs from the node's. */
async function shapeBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return locator.evaluate((el) => {
    const g = el as SVGGraphicsElement;
    const b = g.getBBox();
    const m = g.getScreenCTM();
    if (m === null) throw new Error('shape has no screen CTM');
    return { x: b.x * m.a + m.e, y: b.y * m.d + m.f, width: b.width * m.a, height: b.height * m.d };
  });
}

/** Screen boxes within a pixel of each other — the outline and the node's
 *  own shape are drawn under the same transform from the same frame. */
function expectSameBox(actual: { x: number; y: number; width: number; height: number }, expected: typeof actual): void {
  const detail = JSON.stringify({ actual, expected });
  expect(Math.abs(actual.x - expected.x), detail).toBeLessThan(1);
  expect(Math.abs(actual.y - expected.y), detail).toBeLessThan(1);
  expect(Math.abs(actual.width - expected.width), detail).toBeLessThan(1);
  expect(Math.abs(actual.height - expected.height), detail).toBeLessThan(1);
}

const hostSvg = (page: Page): Locator => page.locator('.canvas-host svg.host');
const leafNodes = (page: Page): Locator => renderedSvg(page).locator('g.L-nodes > g.n');
const shapeOf = (node: Locator): Locator => node.locator(':scope > path.n-shape');
const hoverRect = (page: Page): Locator => page.locator('.canvas-host g.overlay rect.hover');
const selectedRect = (page: Page): Locator => page.locator('.canvas-host g.overlay rect.selected');

async function ctrlWheel(page: Page, deltaY: number, times = 1): Promise<void> {
  await page.keyboard.down('Control');
  for (let i = 0; i < times; i += 1) await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}

test.describe('Canvas (DD-08 §6)', () => {
  // Stage I's small document, opened through Open (DD-08 §7) so the canvas
  // fits it exactly as it fits a document on first open (§6). The larger
  // first-run example made WebKit's repaint at 8x zoom slow enough under
  // parallel load to time the wheel test out, and none of these tests is
  // about the document.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await openFile(page, 'small.sgl', SMALL_SOURCE);
    await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
  });

  test('the overlay is a sibling of the viewport, never part of the exported tree', async ({ page }) => {
    // Make the overlay's outlines live first, so "not exported" is checked
    // while there is something in it to leak.
    await leafNodes(page).first().click();
    await leafNodes(page).nth(1).hover();
    await expect(selectedRect(page)).toHaveAttribute('visibility', 'visible');
    await expect(hoverRect(page)).toHaveAttribute('visibility', 'visible');

    const structure = await hostSvg(page).evaluate((host) => {
      const viewport = host.querySelector(':scope > g.viewport');
      const overlay = host.querySelector(':scope > g.overlay');
      const rendered = host.querySelector('g.rendered');
      const exported = rendered?.querySelector(':scope > svg') ?? null;
      return {
        viewportIsChild: viewport?.parentElement === host,
        overlayIsChild: overlay?.parentElement === host,
        overlayInsideViewport: overlay !== null && (viewport?.contains(overlay) ?? false),
        overlayInsideRendered: overlay !== null && (rendered?.contains(overlay) ?? false),
        overlayInsideExported: overlay !== null && (exported?.contains(overlay) ?? false),
        renderedInsideViewport: rendered !== null && (viewport?.contains(rendered) ?? false),
      };
    });
    expect(structure).toEqual({
      viewportIsChild: true,
      overlayIsChild: true,
      overlayInsideViewport: false,
      overlayInsideRendered: false,
      overlayInsideExported: false,
      renderedInsideViewport: true,
    });

    // The exported SVG — `lastGood.svg`, exactly what `g.rendered` holds —
    // contains no overlay element or outline, by element or by markup.
    const exported = await renderedSvg(page).evaluate((svg) => ({
      overlayElements: svg.querySelectorAll('.overlay, .node-outline, .hover, .selected').length,
      markup: svg.outerHTML,
    }));
    expect(exported.overlayElements).toBe(0);
    expect(exported.markup).not.toMatch(/overlay|node-outline/);
    expect(await page.locator('.canvas-host g.rendered').evaluate((g) => g.children.length)).toBe(1); // just the exported <svg>.
  });

  test("hovering a node outlines exactly that node's frame", async ({ page }) => {
    await expect(hoverRect(page)).toHaveAttribute('visibility', 'hidden');
    const nodes = leafNodes(page);
    for (const i of [0, 1]) {
      const node = nodes.nth(i);
      await node.hover();
      await expect(hoverRect(page)).toHaveAttribute('visibility', 'visible');
      expectSameBox(await shapeBox(hoverRect(page)), await shapeBox(shapeOf(node)));
    }
  });

  test('clicking a node selects it, and clicking another moves the selection', async ({ page }) => {
    await expect(selectedRect(page)).toHaveAttribute('visibility', 'hidden');
    const nodes = leafNodes(page);

    await nodes.first().click();
    await expect(selectedRect(page)).toHaveAttribute('visibility', 'visible');
    expectSameBox(await shapeBox(selectedRect(page)), await shapeBox(shapeOf(nodes.first())));

    await nodes.nth(1).click();
    expectSameBox(await shapeBox(selectedRect(page)), await shapeBox(shapeOf(nodes.nth(1))));
  });

  test('ctrl + wheel zooms about the cursor and clamps the scale to [0.1, 8]', async ({ page }) => {
    const before = await viewportTransform(page);
    const host = await box(hostSvg(page));
    // A point off-centre, so "about the cursor" is distinguishable from
    // "about the centre" — whole pixels, since a wheel event's clientX/Y are.
    const cx = Math.round(host.x + host.width * 0.3);
    const cy = Math.round(host.y + host.height * 0.4);
    await page.mouse.move(cx, cy);

    await ctrlWheel(page, -100); // negative deltaY zooms in.
    await expect.poll(async () => (await viewportTransform(page)).k).toBeGreaterThan(before.k);
    const after = await viewportTransform(page);
    // The diagram point under the cursor stays under the cursor.
    const localX = cx - host.x;
    const localY = cy - host.y;
    expect((localX - after.tx) / after.k).toBeCloseTo((localX - before.tx) / before.k, 3);
    expect((localY - after.ty) / after.k).toBeCloseTo((localY - before.ty) / before.k, 3);

    await ctrlWheel(page, -300, 10); // each is a factor of e^3; 10 is far past 8.
    await expect.poll(async () => (await viewportTransform(page)).k).toBeCloseTo(8, 6);

    await ctrlWheel(page, 300, 10); // likewise far past 0.1.
    await expect.poll(async () => (await viewportTransform(page)).k).toBeCloseTo(0.1, 6);
  });

  test('dragging pans by exactly the drag distance and leaves the scale alone', async ({ page }) => {
    const before = await viewportTransform(page);
    const host = await box(hostSvg(page));
    const start = { x: host.x + 20, y: host.y + 20 }; // empty space near the corner.

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y + 40, { steps: 5 });
    await page.mouse.up();

    const after = await viewportTransform(page);
    expect(after.tx).toBeCloseTo(before.tx + 60, 3);
    expect(after.ty).toBeCloseTo(before.ty + 40, 3);
    expect(after.k).toBe(before.k);
  });

  test('the Fit button fits: centred, the limiting side at 94 % of the canvas, same as on open', async ({ page }) => {
    const fitted = await viewportTransform(page); // DD-08 §6: fitted on document open.
    const host = await box(hostSvg(page));

    // Move away: pan, then zoom.
    await page.mouse.move(host.x + 20, host.y + 20);
    await page.mouse.down();
    await page.mouse.move(host.x + 120, host.y + 100, { steps: 5 });
    await page.mouse.up();
    await ctrlWheel(page, -150);
    await expect.poll(async () => (await viewportTransform(page)).k).not.toBe(fitted.k);

    await page.locator('.toolbar-fit').click();
    expect(await viewportTransform(page)).toEqual(fitted);

    // And "fitted" means fitted: the exported SVG's box is centred in the
    // canvas, and its limiting dimension spans 94 % of it.
    const content = await box(renderedSvg(page));
    expect(Math.abs(content.x + content.width / 2 - (host.x + host.width / 2))).toBeLessThan(1);
    expect(Math.abs(content.y + content.height / 2 - (host.y + host.height / 2))).toBeLessThan(1);
    expect(Math.max(content.width / host.width, content.height / host.height)).toBeCloseTo(0.94, 2);
  });
});
