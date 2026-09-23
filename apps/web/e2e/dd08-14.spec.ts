import { expect, test } from '@playwright/test';
import { nodeGeometry, renderedSvg, waitForNodeCount } from './helpers.js';

/** DD-08 §14's Playwright list, tests 1, 2, 3 (corrected by I2) and 8 — the
 *  rest (4: engine switch, 5–7: files/share/offline) wait for Stage J/K. */
test.describe('DD-08 §14', () => {
  test('1. typing updates the canvas and does not reset the viewport', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);
    const transformBefore = await page.locator('.viewport').getAttribute('transform');
    expect(transformBefore).toBeTruthy();

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\ndb: "Database"\napi -> db');
    await waitForNodeCount(page, 3);

    const transformAfter = await page.locator('.viewport').getAttribute('transform');
    expect(transformAfter).toBe(transformBefore); // DD-08 §6: fit only on open/button, never on re-render.
  });

  test('2. deleting a closing brace shows a squiggle at the right offset and keeps the previous SVG', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);
    const svgBefore = await renderedSvg(page).innerHTML();

    const content = page.locator('.cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    // The example document ends with a trailing newline, so `Control+End`
    // lands on an empty final line — one `Backspace` only joins it with the
    // `}` line above (removing the newline, not the brace); the second one
    // removes the brace itself.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible({ timeout: 5000 });
    expect(await renderedSvg(page).innerHTML()).toBe(svgBefore);
  });

  test("3 (corrected by I2): theme switch leaves every node's frame geometry untouched", async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const framesBefore = await renderedSvg(page).evaluate((svg) =>
      [...svg.querySelectorAll('g.L-nodes > g.n, g.L-containers > g.c')].map((g) => {
        const r = (g as SVGGElement).getBBox();
        return { id: g.getAttribute('id'), x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );

    await page.locator('.theme-picker select').selectOption('neutral-dark');
    await page.waitForTimeout(200);

    const framesAfter = await renderedSvg(page).evaluate((svg) =>
      [...svg.querySelectorAll('g.L-nodes > g.n, g.L-containers > g.c')].map((g) => {
        const r = (g as SVGGElement).getBBox();
        return { id: g.getAttribute('id'), x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );

    expect(framesAfter).toEqual(framesBefore);
  });

  test('8. font gate: label geometry is identical on a cold load and a warm (reloaded) one', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);
    const cold = await nodeGeometry(page);

    await page.reload();
    await waitForNodeCount(page, 2);
    const warm = await nodeGeometry(page);

    expect(warm).toEqual(cold);
  });
});
