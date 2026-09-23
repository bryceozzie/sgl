import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { edgePaths, nodeGeometry, renderedSvg, setSource, viewBox, waitForNodeCount } from './helpers.js';

const corpusDoc = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../corpus/${name}`, import.meta.url)), 'utf8');

/** MVP acceptance criteria (06 §3), Stage I's slice: criteria 2 and 3 in full,
 *  criterion 1's single-engine half (I1 — the engine-switch half waits for
 *  `elk`, Stage K). */
test.describe('MVP acceptance', () => {
  test('criterion 2: switching theme changes paint only — geometry and viewBox untouched', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);

    const geomBefore = await nodeGeometry(page);
    const edgesBefore = await edgePaths(page);
    const viewBoxBefore = await viewBox(page);
    const svgTextBefore = await renderedSvg(page).innerHTML();

    await page.locator('.theme-picker select').selectOption('neutral-dark');
    await expect(page.locator('.theme-picker .picker-label')).toContainText('set by document');
    // The swap itself is synchronous once the document reparses; give the
    // debounced pipeline a moment even though this path skips layout.
    await page.waitForTimeout(200);

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
    expect(svgTextAfter).not.toBe(svgTextBefore); // paint changed.
  });

  test('criterion 3: a syntax error mid-edit shows a squiggle and keeps the last diagram', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, 2);
    const svgBefore = await renderedSvg(page).innerHTML();

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    // `insertText` (one atomic input event, not per-character `type()`) is
    // required here: `closeBrackets` (DD-08 §4) only auto-pairs a *typed*
    // opening quote, so typing this string character by character would
    // pass through a momentarily *valid*, fully-quoted intermediate state
    // (`broken: "unterminated"`) before any follow-up edit reopened it — a
    // real 4-node document the debounced layout effect can legitimately
    // pick up as the new last-good render before the "delete the closing
    // quote" edit ever lands. That is correct FR-E4 behaviour for that
    // sequence of edits, just not the sequence this test means to make.
    await page.keyboard.insertText('\nbroken: "unterminated');

    await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
    await expect(page.locator('.diagnostics-panel .diag')).toHaveCount(2); // SGL1003 + SGL2002.
    expect(await renderedSvg(page).innerHTML()).toBe(svgBefore); // FR-E4.
  });

  test('criterion 1 (single-engine half): a 40-node, three-level document renders under grid', async ({ page }) => {
    test.setTimeout(60_000); // real keystrokes for ~1.4 kB of source take longer than the 30 s default.
    await page.goto('/');
    await setSource(page, corpusDoc('forty-three-level.sgl'));
    await waitForNodeCount(page, 40);

    const geom = await nodeGeometry(page);
    expect(Object.keys(geom)).toHaveLength(40);
    for (const d of Object.values(geom)) expect(d.length).toBeGreaterThan(0);
    await expect(page.locator('.diagnostics-panel')).toHaveCount(0); // clean document, no diagnostics.
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.grid');
  });
});
