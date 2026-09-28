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
  renderedPaintHash,
  renderedSvg,
  setSource,
  sourceDiagnostics,
  switchEngine,
  viewBox,
  waitForExactNodeCount,
  waitForNodeCount,
  waitForTheme,
} from './helpers.js';

/** MVP acceptance criteria (06 §3): 1 (elk and grid, Stage K; fixed, feat/b5-fixed), 2 and 3. */
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

    const textBefore = await editorText(page);
    await page.locator('.theme-picker select').selectOption('neutral-dark');
    // Not a sleep: `data-theme` on the rendered wrapper changes only once the
    // canvas has swapped in a `lastGood` rendered under the new theme.
    await waitForTheme(page, 'neutral-dark');
    // The example names no theme, so the pick is a view preference (F9 P1,
    // DD-08 §10): the document is not edited.
    await expect(page.locator('.theme-picker .picker-label')).toHaveText('Theme');
    expect(await editorText(page)).toBe(textBefore);

    const geomAfter = await nodeGeometry(page);
    const edgesAfter = await edgePaths(page);
    const viewBoxAfter = await viewBox(page);
    const svgTextAfter = await renderedSvg(page).innerHTML();

    // I2: geometry is asserted directly. Since F7 the paint class names and
    // marker ids no longer change with the theme, and since F9 the switch is
    // a swap of the `<style>` text alone (DD-08 §6), so everything outside
    // that element is identical too.
    expect(geomAfter).toEqual(geomBefore);
    expect(edgesAfter).toEqual(edgesBefore);
    expect(viewBoxAfter).toBe(viewBoxBefore);
    expect(await paintHash(page)).not.toBe(paintBefore); // paint changed…
    expect(svgTextAfter).not.toBe(svgTextBefore); // …and so did the markup carrying it,
    const withoutStyle = (markup: string): string => markup.replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
    expect(withoutStyle(svgTextAfter)).toBe(withoutStyle(svgTextBefore)); // …which is the <style> text alone.
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

    const underElk = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };
    const geomElk = await nodeGeometry(page);
    expect(Object.keys(geomElk)).toHaveLength(40);
    for (const d of Object.values(geomElk)) expect(d.length).toBeGreaterThan(0);
    expect(underElk.identity.edges.length).toBeGreaterThan(0);

    await switchEngine(page, 'sgl.grid', underElk.geometry);
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underGrid = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };

    expect(underGrid.identity).toEqual(underElk.identity); // the same nodes, edges and labels …
    expect(underGrid.paint).toBe(underElk.paint); // … the same paint, by the pipeline's own hash …
    // … and as rendered (fix round 1, item 14): the <style> text and every
    // element's class/fill/stroke/stroke-dasharray, so a paint difference
    // the pipeline's hash does not see would still fail here …
    expect(underGrid.renderedPaint).toBe(underElk.renderedPaint);
    expect(underGrid.geometry).not.toBe(underElk.geometry); // … different geometry.
  });

  /** Criterion 1 under `fixed` (DD-12 §12 item 5, feat/b5-fixed): the same
   *  40-node document with every node pinned from its grid layout
   *  (`corpus/layout/forty-three-pinned.sgl`, which names `fixed`). Under
   *  elk the pins are ignored (one SGL4021 each); switching to `fixed` keeps
   *  identity and paint, changes geometry, and leaves no diagnostic at all. */
  test('criterion 1 under fixed: the pinned 40-node document, elk → fixed, changes only geometry, with no diagnostics', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await setSource(page, corpusDoc('layout/forty-three-pinned.sgl'));
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.fixed'); // the document names it
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

    await switchEngine(page, 'sgl.elk', await layoutGeometryHash(page));
    await waitForExactNodeCount(page, 40);
    await expect.poll(() => diagnosticCodes(page)).toEqual(new Array<string>(40).fill('SGL4021'));
    const underElk = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };

    await switchEngine(page, 'sgl.fixed', underElk.geometry);
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underFixed = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };
    expect(underFixed.identity).toEqual(underElk.identity);
    expect(underFixed.paint).toBe(underElk.paint);
    expect(underFixed.renderedPaint).toBe(underElk.renderedPaint);
    expect(underFixed.geometry).not.toBe(underElk.geometry);
  });

  /** Criterion 1 under `tree` (DD-12 §12 item 5, feat/b5-tree): the same
   *  40-node, three-level document as the first case. Switching from elk to
   *  tree (whose layout code the worker loads from the lazy `std-trees`
   *  chunk then) keeps identity and paint, changes geometry, and leaves no
   *  diagnostic: tree takes nested containers as nested trees. */
  test('criterion 1 under tree: the 40-node document, elk → tree, changes only geometry, with no diagnostics', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await setSource(page, corpusDoc('forty-three-level.sgl'));
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underElk = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };

    await switchEngine(page, 'sgl.tree', underElk.geometry);
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underTree = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };
    expect(underTree.identity).toEqual(underElk.identity);
    expect(underTree.paint).toBe(underElk.paint);
    expect(underTree.renderedPaint).toBe(underElk.renderedPaint);
    expect(underTree.geometry).not.toBe(underElk.geometry);
  });

  /** Criterion 1 under `radial` (DD-12 §12 item 5, feat/b5-radial): the same
   *  40-node, three-level document as the first case. Switching from elk to
   *  radial (whose layout code the worker loads from the lazy `std-trees`
   *  chunk then) keeps identity and paint, changes geometry, and leaves no
   *  diagnostic: radial takes nested containers as nested discs (N45). */
  test('criterion 1 under radial: the 40-node document, elk → radial, changes only geometry, with no diagnostics', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await setSource(page, corpusDoc('forty-three-level.sgl'));
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.elk');
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underElk = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };

    await switchEngine(page, 'sgl.radial', underElk.geometry);
    await waitForExactNodeCount(page, 40);
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
    const underRadial = {
      identity: await renderedIdentity(page),
      paint: await paintHash(page),
      renderedPaint: await renderedPaintHash(page),
      geometry: await layoutGeometryHash(page),
    };
    expect(underRadial.identity).toEqual(underElk.identity);
    expect(underRadial.paint).toBe(underElk.paint);
    expect(underRadial.renderedPaint).toBe(underElk.renderedPaint);
    expect(underRadial.geometry).not.toBe(underElk.geometry);
  });
});
