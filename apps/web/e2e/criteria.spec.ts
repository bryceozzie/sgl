import { expect, test } from '@playwright/test';
import {
  corpusDoc,
  diagnosticCodes,
  edgePaths,
  editorText,
  errorDecorations,
  EXAMPLE_NODE_COUNT,
  EXAMPLE_SOURCE,
  expectedErrorDecorations,
  layoutGeometryHash,
  nodeGeometry,
  paintHash,
  renderedIdentity,
  renderedSvg,
  setSource,
  sourceDiagnostics,
  switchEngine,
  viewBox,
  waitForExactNodeCount,
  waitForNodeCount,
  waitForTheme,
} from './helpers.js';

/** MVP acceptance criteria (06 §3): 1 (both engines, Stage K), 2 and 3. */
test.describe('MVP acceptance', () => {
  test('criterion 2: switching theme changes paint only — geometry and viewBox untouched', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await waitForTheme(page, 'neutral-light');

    const geomBefore = await nodeGeometry(page);
    const edgesBefore = await edgePaths(page);
    const viewBoxBefore = await viewBox(page);
    const svgTextBefore = await renderedSvg(page).innerHTML();
    const paintBefore = await paintHash(page);

    await page.locator('.theme-picker select').selectOption('neutral-dark');
    await expect(page.locator('.theme-picker .picker-label')).toContainText('set by document');
    // Not a sleep: `data-theme` on the rendered wrapper changes only once the
    // canvas has swapped in a `lastGood` rendered under the new theme.
    await waitForTheme(page, 'neutral-dark');

    const geomAfter = await nodeGeometry(page);
    const edgesAfter = await edgePaths(page);
    const viewBoxAfter = await viewBox(page);
    const svgTextAfter = await renderedSvg(page).innerHTML();

    // I2 / F7: assert geometry, not "only <style> differs" — the tree really
    // does change (paint class names, marker ids), so the negative half of
    // this assertion (svgTextAfter !== svgTextBefore) is expected, not a bug.
    expect(geomAfter).toEqual(geomBefore);
    expect(edgesAfter).toEqual(edgesBefore);
    expect(viewBoxAfter).toBe(viewBoxBefore);
    expect(await paintHash(page)).not.toBe(paintBefore); // paint changed…
    expect(svgTextAfter).not.toBe(svgTextBefore); // …and so did the markup carrying it.
  });

  test('criterion 3: a syntax error mid-edit shows a squiggle at the right span and keeps the last diagram', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    const svgBefore = await renderedSvg(page).innerHTML();

    const addition = 'broken: "unterminated';
    const finalSource = EXAMPLE_SOURCE + addition;
    // What "the right span" means here, pinned independently of the parser:
    // one squiggle over the unterminated string, opening quote included.
    const expected = expectedErrorDecorations(finalSource);
    expect(expected.ranges.map((r) => finalSource.slice(r.from, r.to))).toEqual(['"unterminated']);
    expect(expected.points).toEqual([]);

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End'); // the empty line after the closing brace.
    // `insertText` (one atomic input event, not per-character `type()`) is
    // required here: `closeBrackets` (DD-08 §4) only auto-pairs a *typed*
    // opening quote, so typing this string character by character would
    // pass through a momentarily *valid*, fully-quoted intermediate state
    // (`broken: "unterminated"`) before any follow-up edit reopened it — a
    // real document the debounced layout effect can legitimately adopt as
    // the new last-good render. Correct FR-E4 behaviour, not this test's
    // sequence of edits.
    await page.keyboard.insertText(addition);

    await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL1003', 'SGL2002']); // exact codes, sorted by offset.
    expect(sourceDiagnostics(finalSource).map((d) => d.code)).toEqual(['SGL1003', 'SGL2002']);
    expect(await editorText(page)).toBe(finalSource); // the spans below are for the text really in the editor.
    await expect.poll(() => errorDecorations(page)).toEqual(expected); // the squiggle sits exactly there.

    expect(await renderedSvg(page).innerHTML()).toBe(svgBefore); // FR-E4.
  });

  /** Criterion 1 (Stage K, K7): a 40-node, three-level document renders
   *  under **both** engines, and switching changes only geometry. Identity
   *  (node ids, edge ids, label texts) and the pipeline's own paint hash
   *  (`data-paint-hash`, `StyledGraph.paintHash`) must match; the layout's
   *  geometry hash (`layoutGeometryHash`, computed from the rendered shapes,
   *  routes, label positions and `viewBox` — the pipeline has no layout hash
   *  of its own) must differ. */
  test('criterion 1: a 40-node, three-level document renders under both engines; switching changes only geometry', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await setSource(page, corpusDoc('forty-three-level.sgl'));
    // 40 counts containers as well as leaves (DD-08 §14's note on criterion
    // 1): `waitForExactNodeCount`/`nodeGeometry` read both `g.n` and `g.c`.
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk'); // the default (ADR-0005)
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0); // clean document, no diagnostics.

    const underElk = { identity: await renderedIdentity(page), paint: await paintHash(page), geometry: await layoutGeometryHash(page) };
    const geomElk = await nodeGeometry(page);
    expect(Object.keys(geomElk)).toHaveLength(40);
    for (const d of Object.values(geomElk)) expect(d.length).toBeGreaterThan(0);
    expect(underElk.identity.edges.length).toBeGreaterThan(0);

    await switchEngine(page, 'sgl.grid', underElk.geometry);
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underGrid = { identity: await renderedIdentity(page), paint: await paintHash(page), geometry: await layoutGeometryHash(page) };

    expect(underGrid.identity).toEqual(underElk.identity); // the same nodes, edges and labels …
    expect(underGrid.paint).toBe(underElk.paint); // … the same paint …
    expect(underGrid.geometry).not.toBe(underElk.geometry); // … different geometry.
  });
});
