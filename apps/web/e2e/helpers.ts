import { expect, type Locator, type Page } from '@playwright/test';
import { parse, resolve, type Diagnostic } from '@sgl/core';

/** `parse -> resolve`'s combined diagnostics for `source`, sorted by offset —
 *  the same ground truth `pipeline.ts`'s `diags` computed builds `parsed`'s
 *  and `model`'s halves from. Stops at `resolve` (not `compile`) because every
 *  e2e scenario that needs this only exercises parse/resolve-level codes
 *  (SGL1xxx/SGL2xxx); a test that needs a compile-level code should extend
 *  this rather than call `parse`/`resolve` directly and drop half the pair. */
export function sourceDiagnostics(source: string): readonly Diagnostic[] {
  const { ast, diagnostics: parseDiags } = parse(source);
  const { diagnostics: modelDiags } = resolve(ast);
  return [...parseDiags, ...modelDiags].sort((a, b) => a.span.from - b.span.from);
}

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

/** The diagnostics panel's rows, in document order — code and message text,
 *  for asserting exactly which diagnostics fired rather than just a count. */
export async function diagnosticRows(page: Page): Promise<{ readonly code: string; readonly text: string }[]> {
  return page.locator('.diagnostics-panel .diag').evaluateAll((rows) =>
    rows.map((row) => ({
      code: row.querySelector('.diag-code')?.textContent ?? '',
      text: row.textContent ?? '',
    })),
  );
}

/** The text CodeMirror's inline error decoration covers, in document order —
 *  compared against `source.slice(span.from, span.to)` computed from the real
 *  parser output, this is the "squiggle at the right offset" assertion. */
export async function lintRangeTexts(page: Page): Promise<string[]> {
  return page.locator('.cm-lintRange-error').evaluateAll((els) => els.map((el) => el.textContent ?? ''));
}

/** Every `error`-severity diagnostic in `expected` is decorated at exactly its
 *  own span: a non-empty span (`from < to`) as a `.cm-lintRange-error` whose
 *  text is `source.slice(span.from, span.to)`; a zero-width span (`from ===
 *  to` — e.g. "expected `}` here", pointing at an insertion point, not a
 *  range) as a `.cm-lintPoint-error` instead — CodeMirror renders the two
 *  differently, so a test that only ever looked for ranges would silently
 *  pass zero range elements. */
export async function assertErrorSpans(page: Page, source: string, expected: readonly { readonly span: { readonly from: number; readonly to: number } }[]): Promise<void> {
  const ranged = expected.filter((d) => d.span.from < d.span.to);
  const pointed = expected.filter((d) => d.span.from === d.span.to);

  // A single diagnostic's span can render as *several* adjacent
  // `.cm-lintRange-error` elements — CodeMirror's decoration layer splits at
  // every boundary another mark (e.g. a syntax-highlight span) also starts or
  // ends inside the range, which the opening `"` of an unterminated string
  // reliably does — and two diagnostics whose spans *overlap* (a real case
  // here: SGL1003's span covers the whole unterminated string content,
  // SGL2002's covers just the bareword class name error recovery reinterprets
  // part of it as) do not each get their own separately-rendered copy of the
  // shared text. Checking that the concatenated decorated text *contains*
  // each expected span's slice — rather than reconstructing it exactly via
  // one-element-per-diagnostic or even one-pass-per-diagnostic concatenation
  // — is what stays robust to both without losing "the squiggle really does
  // cover this diagnostic's own span, not just some text somewhere."
  const rangeTexts = await lintRangeTexts(page);
  const decorated = rangeTexts.join('');
  for (const d of ranged) expect(decorated).toContain(source.slice(d.span.from, d.span.to));

  const pointCount = await page.locator('.cm-lintPoint-error').count();
  expect(pointCount).toBe(pointed.length);
}

/** Waits for a theme switch to actually reach `lastGood` — `data-theme`
 *  changing is proof the *pipeline* (not just the picker's own `<select>`)
 *  settled on the new theme, unlike a fixed `waitForTimeout` which can read
 *  stale pre-switch geometry on a slow runner and pass for the wrong reason. */
export async function waitForTheme(page: Page, themeId: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, value }) => document.querySelector(selector)?.getAttribute('data-theme') === value,
    { selector: '.canvas-host g.rendered', value: themeId },
  );
}
