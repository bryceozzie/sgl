import { expect, test } from '@playwright/test';
import { renderedSvg, waitForNodeCount } from './helpers.js';

/** Item 9 (fix round 1): the canvas (`apps/web/src/canvas/Canvas.tsx`) had no
 *  coverage at all — pan/zoom/hover/click/Fit, and the overlay-is-a-sibling
 *  property DD-08 §6 states explicitly. */
test.describe('Canvas (DD-08 §6)', () => {
  test('the overlay is not part of the exported tree', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    // `g.overlay` sits beside `g.viewport` inside the host `<svg>`, not inside
    // it — and never inside the nested `<svg>` that `lastGood.svg` (the
    // exported/saved tree) actually is.
    const overlayIsSibling = await page.evaluate(() => {
      const host = document.querySelector('.canvas-host svg.host');
      const viewport = host?.querySelector(':scope > g.viewport');
      const overlay = host?.querySelector(':scope > g.overlay');
      return viewport !== null && overlay !== null && viewport?.parentElement === overlay?.parentElement;
    });
    expect(overlayIsSibling).toBe(true);

    const exportedContainsOverlay = await renderedSvg(page).evaluate((svg) => svg.querySelector('.overlay') !== null);
    expect(exportedContainsOverlay).toBe(false);
  });

  test('hovering a node draws an outline matching its own frame', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const node = page.locator('.canvas-host g.L-nodes > g.n').first();
    await node.hover();

    const hoverRect = page.locator('.canvas-host g.overlay rect.hover');
    await expect(hoverRect).toHaveAttribute('visibility', 'visible');

    const nodeFrame = await node.evaluate((g) => {
      const shape = g.querySelector(':scope > path.n-shape');
      const d = shape?.getAttribute('d') ?? '';
      // Box-shape path is `M x y h w v h h -w Z` (DD-07 §4) — parse the two
      // numbers that matter without depending on the exact command set.
      const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      return { x: nums[0], y: nums[1] };
    });
    const outline = await hoverRect.evaluate((r) => ({ x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')) }));
    expect(outline.x).toBeCloseTo(nodeFrame.x ?? NaN, 1);
    expect(outline.y).toBeCloseTo(nodeFrame.y ?? NaN, 1);
  });

  test('clicking a node selects it', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const selectedRect = page.locator('.canvas-host g.overlay rect.selected');
    await expect(selectedRect).toHaveAttribute('visibility', 'hidden');

    const node = page.locator('.canvas-host g.L-nodes > g.n').first();
    await node.click();

    await expect(selectedRect).toHaveAttribute('visibility', 'visible');
  });

  test('wheel zoom (Ctrl/Cmd) changes scale and clamps to [0.1, 8]', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const readScale = () =>
      page.locator('.viewport').evaluate((g) => {
        const m = /scale\(([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
        return m ? Number(m[1]) : NaN;
      });

    const before = await readScale();
    const box = (await page.locator('.canvas-host svg.host').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200); // negative deltaY = zoom in (DD-08 §6's onWheel).
    await page.keyboard.up('Control');

    const after = await readScale();
    expect(after).toBeGreaterThan(before);

    // Clamp: a huge zoom-in run caps at 8.
    await page.keyboard.down('Control');
    for (let i = 0; i < 30; i += 1) await page.mouse.wheel(0, -300);
    await page.keyboard.up('Control');
    expect(await readScale()).toBeLessThanOrEqual(8);

    // Clamp: a huge zoom-out run caps at 0.1.
    await page.keyboard.down('Control');
    for (let i = 0; i < 60; i += 1) await page.mouse.wheel(0, 300);
    await page.keyboard.up('Control');
    expect(await readScale()).toBeGreaterThanOrEqual(0.1);
  });

  test('dragging pans the viewport', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const readTranslate = () =>
      page.locator('.viewport').evaluate((g) => {
        const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
        return m ? { tx: Number(m[1]), ty: Number(m[2]) } : { tx: NaN, ty: NaN };
      });

    const before = await readTranslate();
    const box = (await page.locator('.canvas-host svg.host').boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y + 40, { steps: 5 });
    await page.mouse.up();

    const after = await readTranslate();
    expect(after.tx).toBeCloseTo(before.tx + 60, 0);
    expect(after.ty).toBeCloseTo(before.ty + 40, 0);
  });

  test('the Fit button re-fits the viewport', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const readTransform = () => page.locator('.viewport').getAttribute('transform');
    const fitted = await readTransform();

    // Pan away from the fitted position.
    const box = (await page.locator('.canvas-host svg.host').boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 100, start.y + 80, { steps: 5 });
    await page.mouse.up();
    expect(await readTransform()).not.toBe(fitted);

    await page.locator('.toolbar-fit').click();
    expect(await readTransform()).toBe(fitted); // back to exactly the fitted transform.
  });
});
