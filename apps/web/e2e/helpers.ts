import type { Locator, Page } from '@playwright/test';

/** Replaces the whole editor document — CodeMirror's content is
 *  `contenteditable`, so `fill()` does not work. Uses `insertText` (one bulk
 *  input event, the same shape a real paste or "open a file" produces)
 *  rather than per-character `type()`: `closeBrackets` (DD-08 §4) only
 *  engages for a single typed opening-bracket character, so per-character
 *  typing of a whole fixture would auto-pair every `{`/`"` in it and corrupt
 *  the structure, which bulk insertion correctly does not trigger — still
 *  exercises the same `updateListener` path either way. */
export async function setSource(page: Page, text: string): Promise<void> {
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
}

export function renderedSvg(page: Page): Locator {
  // `lastGood.svg` is inserted whole into `<g class="rendered">` (DD-08 §6) —
  // the nested `<svg>` this selects is the actual exported/golden-comparable
  // tree, distinct from the host `<svg class="host">` that owns pan/zoom.
  return page.locator('.canvas-host g.rendered > svg');
}

export async function waitForNodeCount(page: Page, count: number): Promise<void> {
  await renderedSvg(page)
    .locator('g.L-nodes > g.n, g.L-containers > g.c')
    .nth(count - 1)
    .waitFor({ state: 'attached' });
}

/** Every node/container's own shape `d` (DD-07 §4) — geometry, keyed by id so
 *  it survives DOM re-ordering. */
export async function nodeGeometry(page: Page): Promise<Record<string, string>> {
  return renderedSvg(page).evaluate((svg) => {
    const out: Record<string, string> = {};
    for (const g of svg.querySelectorAll('g.L-nodes > g.n, g.L-containers > g.c')) {
      const id = g.getAttribute('id') ?? '';
      const shape = g.querySelector(':scope > path.n-shape, :scope > path.c-shape');
      out[id] = shape?.getAttribute('d') ?? '';
    }
    return out;
  });
}

/** Every edge's route `d` (DD-07 §3), in document order. */
export async function edgePaths(page: Page): Promise<string[]> {
  return renderedSvg(page).evaluate((svg) =>
    [...svg.querySelectorAll('g.L-edges path.e-path, g.L-edges path')].map((p) => p.getAttribute('d') ?? ''),
  );
}

export async function viewBox(page: Page): Promise<string> {
  return (await renderedSvg(page).getAttribute('viewBox')) ?? '';
}
