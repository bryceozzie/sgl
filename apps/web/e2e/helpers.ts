import { expect, type Locator, type Page } from '@playwright/test';
import { compile, parse, resolve, type Diagnostic } from '@sgl/core';

/** The front end's (`parse -> resolve -> compile`) diagnostics for `source`,
 *  sorted by offset — the ground truth the app's `diags` computed builds its
 *  document half from. Theme/style/layout/render diagnostics are left out:
 *  none of the documents these tests use produces one. */
export function sourceDiagnostics(source: string): readonly Diagnostic[] {
  const parsed = parse(source);
  const resolved = resolve(parsed.ast);
  const compiled = compile(resolved.model);
  return [...parsed.diagnostics, ...resolved.diagnostics, ...compiled.diagnostics].sort((a, b) => a.span.from - b.span.from);
}

/** The document the app opens with (`App.tsx`'s `EXAMPLE`) — note the
 *  trailing newline: `Control+End` lands on an empty final line. */
export const EXAMPLE_SOURCE = 'checkout: {\n  web: "Web App"\n  api: "API"\n  web -> api\n}\n';

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

/** The diagnostics panel's rows, in the panel's own order (sorted by offset,
 *  DD-08 §11) — for asserting exactly which diagnostics fired, not a count. */
export async function diagnosticCodes(page: Page): Promise<string[]> {
  return page.locator('.diagnostics-panel .diag .diag-code').evaluateAll((els) => els.map((el) => el.textContent ?? ''));
}

/** The editor's current document text, read back from CodeMirror's rendered
 *  lines (every line is rendered for the small documents these tests use). A
 *  test asserts this equals the source it meant to produce, so the expected
 *  spans below are computed from the text that is really in the editor, not
 *  from an assumption about what a sequence of keystrokes left there. */
export async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-content > .cm-line').evaluateAll((lines) => lines.map((l) => l.textContent ?? '').join('\n'));
}

export interface Interval {
  readonly from: number;
  readonly to: number;
}

/** Where CodeMirror actually drew the error squiggles, as document offsets:
 *  `ranges` is every stretch of text inside a `.cm-lintRange-error` mark,
 *  merged into maximal intervals (CodeMirror splits one diagnostic's mark at
 *  every other decoration boundary, and splits overlapping diagnostics into
 *  adjacent pieces, so the DOM elements themselves do not map 1:1 to
 *  diagnostics); `points` is the offset of every zero-width
 *  `.cm-lintPoint-error` marker. */
export async function errorDecorations(page: Page): Promise<{ readonly ranges: Interval[]; readonly points: number[] }> {
  return page.locator('.cm-content').evaluate((content) => {
    const covered: number[] = [];
    const points: number[] = [];
    let lineStart = 0;
    for (const line of content.querySelectorAll(':scope > .cm-line')) {
      let offset = lineStart;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof Element) {
          if (node.classList.contains('cm-lintPoint-error')) points.push(offset);
          continue;
        }
        const length = node.textContent?.length ?? 0;
        if (node.parentElement?.closest('.cm-lintRange-error') !== null) for (let i = 0; i < length; i += 1) covered.push(offset + i);
        offset += length;
      }
      lineStart += (line.textContent?.length ?? 0) + 1;
    }
    const ranges: { from: number; to: number }[] = [];
    for (const at of covered) {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && last.to === at) last.to = at + 1;
      else ranges.push({ from: at, to: at + 1 });
    }
    return { ranges, points };
  });
}

/** The squiggles `source`'s own error diagnostics should produce, in the same
 *  shape `errorDecorations` reads back: non-empty spans merged into maximal
 *  intervals, zero-width spans as points. */
export function expectedErrorDecorations(source: string): { readonly ranges: Interval[]; readonly points: number[] } {
  const errors = sourceDiagnostics(source).filter((d) => d.severity === 'error');
  const spans = errors.filter((d) => d.span.from < d.span.to).map((d) => ({ from: d.span.from, to: d.span.to }));
  spans.sort((a, b) => a.from - b.from);
  const ranges: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else ranges.push({ ...span });
  }
  const points = errors.filter((d) => d.span.from === d.span.to).map((d) => d.span.from);
  return { ranges, points: points.sort((a, b) => a - b) };
}

/** Waits for a theme switch to reach what the canvas shows: `Canvas.tsx`
 *  stamps `data-theme`/`data-paint-hash` on the rendered wrapper from the
 *  same `lastGood` it just swapped in, so once `data-theme` reads `themeId`
 *  the geometry on screen is the new theme's — no fixed sleep that a slow
 *  runner could outlast. */
export async function waitForTheme(page: Page, themeId: string): Promise<void> {
  await expect(page.locator('.canvas-host g.rendered')).toHaveAttribute('data-theme', themeId);
}

/** The rendered wrapper's current paint hash (see `waitForTheme`). */
export async function paintHash(page: Page): Promise<string | null> {
  return page.locator('.canvas-host g.rendered').getAttribute('data-paint-hash');
}
