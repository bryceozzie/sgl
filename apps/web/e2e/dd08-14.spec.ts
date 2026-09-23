import { expect, test } from '@playwright/test';
import {
  diagnosticCodes,
  editorText,
  errorDecorations,
  EXAMPLE_NODE_COUNT,
  expectedErrorDecorations,
  layoutGeometryHash,
  nodeGeometry,
  renderedIdentity,
  renderedSvg,
  setSource,
  SMALL_SOURCE,
  sourceDiagnostics,
  switchEngine,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
  waitForTheme,
} from './helpers.js';

/** DD-08 §14's Playwright list, tests 1, 2, 3 (corrected by I2), 4 (Stage K)
 *  and 8. Tests 5–7 (files, share, offline) are `files.spec.ts`,
 *  `share.spec.ts` and `offline.spec.ts` (Stage J; the offline engine switch
 *  is Stage K's). */
test.describe('DD-08 §14', () => {
  test('1. typing updates the canvas and does not reset the viewport', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const transformBefore = await page.locator('.viewport').getAttribute('transform');
    expect(transformBefore).toBeTruthy();

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    // `payments.api`, the example's own node: an edge from an undeclared
    // endpoint is an error, and a document with an error never renders.
    await page.keyboard.type('\ndb: "Database"\npayments.api -> db');
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT + 1);

    const transformAfter = await page.locator('.viewport').getAttribute('transform');
    expect(transformAfter).toBe(transformBefore); // DD-08 §6: fit only on open/button, never on re-render.
  });

  test('2. deleting a closing brace shows a squiggle at the right offset and keeps the previous SVG', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    // A document that ends in a container's closing brace (the example ends
    // in an edge).
    await setSource(page, SMALL_SOURCE);
    await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
    const svgBefore = await renderedSvg(page).innerHTML();

    const finalSource = SMALL_SOURCE.slice(0, -2); // the trailing "}\n" removed.
    // What "the right offset" means here, pinned independently of the
    // parser: one zero-width "expected `}`" marker at the very end of the
    // document, and no ranged squiggle.
    const expected = expectedErrorDecorations(finalSource);
    expect(expected).toEqual({ ranges: [], points: [finalSource.length] });

    const content = page.locator('.cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    // The example document ends with a trailing newline, so `Control+End`
    // lands on an empty final line — one `Backspace` only joins it with the
    // `}` line above (removing the newline, not the brace); the second one
    // removes the brace itself.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL1001']);
    expect(sourceDiagnostics(finalSource).map((d) => d.code)).toEqual(['SGL1001']);
    expect(await editorText(page)).toBe(finalSource);
    await expect.poll(() => errorDecorations(page)).toEqual(expected);

    expect(await renderedSvg(page).innerHTML()).toBe(svgBefore);
  });

  test("3 (corrected by I2): theme switch leaves every node's frame geometry untouched", async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await waitForTheme(page, 'neutral-light');

    const frames = () =>
      renderedSvg(page).evaluate((svg) =>
        [...svg.querySelectorAll('g.L-nodes > g.n, g.L-containers > g.c')].map((g) => {
          const r = (g as SVGGElement).getBBox();
          return { id: g.getAttribute('id'), x: r.x, y: r.y, w: r.width, h: r.height };
        }),
      );
    const framesBefore = await frames();

    await page.locator('.theme-picker select').selectOption('neutral-dark');
    await waitForTheme(page, 'neutral-dark'); // the swap has landed; not a sleep.

    expect(await frames()).toEqual(framesBefore);
  });

  test('4. switching engine changes geometry and keeps every id (Stage K)', async ({ page }) => {
    await page.goto('/');
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');
    const elkIdentity = await renderedIdentity(page);
    const elkGeometry = await layoutGeometryHash(page);

    await switchEngine(page, 'sgl.grid', elkGeometry);
    const gridGeometry = await layoutGeometryHash(page);
    expect(await renderedIdentity(page)).toEqual(elkIdentity);
    expect(gridGeometry).not.toBe(elkGeometry);

    // And back: elk's geometry again, exactly (quantized, deterministic).
    await switchEngine(page, 'sgl.elk', gridGeometry);
    expect(await layoutGeometryHash(page)).toBe(elkGeometry);
    expect(await renderedIdentity(page)).toEqual(elkIdentity);
  });

  test('8. font gate: label geometry is identical on a cold load and a warm (reloaded) one', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const cold = await nodeGeometry(page);

    await page.reload();
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const warm = await nodeGeometry(page);

    expect(warm).toEqual(cold);
  });
});
