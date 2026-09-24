import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/** A `corpus/` document's text. */
export const corpusDoc = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../corpus/${name}`, import.meta.url)), 'utf8');

/** The document a first visit opens with (DD-08 §9: "create a document from
 *  the example" — `src/examples/checkout.sgl`, Stage J). Every Playwright
 *  test starts in a fresh browser context, so a fresh IndexedDB, so this. */
export const EXAMPLE_SOURCE = readFileSync(fileURLToPath(new URL('../src/examples/checkout.sgl', import.meta.url)), 'utf8');

export function visibleNodeCount(source: string): number {
  const { graph } = compile(resolve(parse(source).ast).model);
  return graph.order.filter((id) => graph.nodes[id]?.hidden === false).length;
}

/** How many nodes and containers the example renders — computed, not
 *  hard-coded, so editing the example cannot silently weaken a wait. */
export const EXAMPLE_NODE_COUNT = visibleNodeCount(EXAMPLE_SOURCE);

/** A small document for tests that edit at a known offset — note the
 *  trailing newline: `Control+End` lands on an empty final line. */
export const SMALL_SOURCE = 'checkout: {\n  web: "Web App"\n  api: "API"\n  web -> api\n}\n';

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
  // `data-origin="live"`: a render of the running pipeline, never the stored
  // picture a reload paints first (J6, `storedSvg` below).
  return page.locator('.canvas-host g.rendered[data-origin="live"] > svg');
}

/** The last-good SVG painted from IndexedDB at boot, before a live render
 *  replaces it (DD-08 §5, §9). */
export function storedSvg(page: Page): Locator {
  return page.locator('.canvas-host g.rendered[data-origin="stored"] > svg');
}

const NODES = 'g.L-nodes > g.n, g.L-containers > g.c';

/** At least `count` nodes and containers rendered live. */
export async function waitForNodeCount(page: Page, count: number): Promise<void> {
  await renderedSvg(page)
    .locator(NODES)
    .nth(count - 1)
    .waitFor({ state: 'attached' });
}

/** Exactly `count` nodes and containers rendered live — for waiting on a
 *  *particular* document's render, where "at least" would already hold. */
export async function waitForExactNodeCount(page: Page, count: number): Promise<void> {
  await expect(renderedSvg(page).locator(NODES)).toHaveCount(count);
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

/** The rendered wrapper's current paint hash (see `waitForTheme`). The
 *  canvas stamps it after the frame that shows a render (F9: the graph paint
 *  hash is taken on first read, off the switch's path), and removes it at
 *  the swap, so this waits for it to be there. */
export async function paintHash(page: Page): Promise<string | null> {
  const wrapper = page.locator('.canvas-host g.rendered');
  await expect(wrapper).toHaveAttribute('data-paint-hash', /^[0-9a-f]{16}$/);
  return wrapper.getAttribute('data-paint-hash');
}

/** A document record as `state/storage.ts` stores it (DD-08 §9). */
export interface StoredDocument {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly engineId: string;
  readonly engineOptions?: Readonly<Record<string, unknown>>;
  readonly themeId: string;
  readonly lastGoodSvg?: string;
  readonly fileExtension?: string;
}

/** Every record in IndexedDB `sgl` and the `lastOpenDocId` setting, read
 *  straight from the browser's own store — the real persisted state, not an
 *  app-provided hook. Empty before the app has created the database. */
export async function readStorage(page: Page): Promise<{ readonly documents: StoredDocument[]; readonly lastOpenDocId: string | undefined }> {
  return page.evaluate(() =>
    new Promise<{ documents: StoredDocument[]; lastOpenDocId: string | undefined }>((resolve, reject) => {
      const open = indexedDB.open('sgl');
      open.onerror = () => reject(open.error);
      // Not created yet: abort rather than create an empty database the app
      // would then open without its stores.
      open.onupgradeneeded = () => open.transaction?.abort();
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['documents', 'settings'], 'readonly');
        const docs = tx.objectStore('documents').getAll();
        const last = tx.objectStore('settings').get('lastOpenDocId');
        tx.oncomplete = () => {
          db.close();
          resolve({ documents: docs.result as StoredDocument[], lastOpenDocId: (last.result as { value?: string } | undefined)?.value });
        };
        tx.onerror = () => reject(tx.error);
      };
    }).catch(() => ({ documents: [] as StoredDocument[], lastOpenDocId: undefined })),
  );
}

/** Rewrites fields of the open document's stored record straight in
 *  IndexedDB — how a record written by an older version, or by hand, looks
 *  to the next boot. The page should be reloaded afterwards. */
export async function patchStoredOpenDocument(page: Page, patch: Readonly<Record<string, unknown>>): Promise<void> {
  await page.evaluate(
    (fields) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('sgl');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['documents', 'settings'], 'readwrite');
          const last = tx.objectStore('settings').get('lastOpenDocId');
          last.onsuccess = () => {
            const id = (last.result as { value?: string } | undefined)?.value;
            if (id === undefined) return;
            const docs = tx.objectStore('documents');
            const get = docs.get(id);
            get.onsuccess = () => docs.put({ ...(get.result as object), ...fields });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    patch,
  );
}

/** A hash of everything paint decides, as rendered, before or after layout
 *  alike (fix round 1, item 14): the `<style>` text, and each element's
 *  `class`, `fill`, `stroke` and `stroke-dasharray`, in document order. */
export async function renderedPaintHash(page: Page): Promise<string> {
  const paint = await renderedSvg(page).evaluate((svg) => {
    const style = [...svg.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
    const attrs = [...svg.querySelectorAll('*')].map((el) =>
      ['class', 'fill', 'stroke', 'stroke-dasharray'].map((a) => `${a}=${el.getAttribute(a) ?? ''}`).join(' '),
    );
    return JSON.stringify({ style, attrs });
  });
  return createHash('sha256').update(paint).digest('hex');
}

/** The open document's stored record (`lastOpenDocId`'s), or `undefined`. */
export async function storedOpenDocument(page: Page): Promise<StoredDocument | undefined> {
  const { documents, lastOpenDocId } = await readStorage(page);
  return documents.find((d) => d.id === lastOpenDocId);
}

/** Opens `text` as file `name` through the toolbar's Open button — the real
 *  `<input type=file>` path (DD-08 §7). */
export async function openFile(page: Page, name: string, text: string | Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.file-open').click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: typeof text === 'string' ? Buffer.from(text, 'utf8') : text });
}

/** Clicks a Save ▾ item and returns the download's file name and text. */
export async function saveAs(page: Page, kind: 'sgl' | 'json' | 'svg'): Promise<{ readonly name: string; readonly text: string }> {
  await page.locator('.save-menu > summary').click();
  const download = page.waitForEvent('download');
  await page.locator(`.save-menu .save-${kind}`).click();
  const file = await download;
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') };
}

/** The toast region's messages. */
export function toastMessages(page: Page): Locator {
  return page.locator('.toasts .toast-message');
}

/** What must survive an engine switch (MVP criterion 1, DD-08 §14 test 4):
 *  every rendered node/container id, every edge id, and every label's text,
 *  each sorted. */
export async function renderedIdentity(page: Page): Promise<{ readonly nodes: string[]; readonly edges: string[]; readonly labels: string[] }> {
  return renderedSvg(page).evaluate((svg) => {
    const ids = (sel: string) => [...svg.querySelectorAll(sel)].map((g) => g.getAttribute('id') ?? '').sort();
    return {
      nodes: ids('g.L-nodes > g.n, g.L-containers > g.c'),
      edges: ids('g.L-edges > g.e'),
      labels: [...svg.querySelectorAll('text')].map((t) => t.textContent ?? '').sort(),
    };
  });
}

/** A hash of everything the layout decides, as rendered: node and container
 *  shapes, edge routes, label positions and the `viewBox`. The pipeline has
 *  no layout hash of its own (`StyledGraph.geometryHash` is the *style*
 *  geometry, the same under every engine), so it is computed here. */
export async function layoutGeometryHash(page: Page): Promise<string> {
  const labels = await renderedSvg(page).evaluate((svg) =>
    [...svg.querySelectorAll('text')].map((t) => `${t.getAttribute('x')},${t.getAttribute('y')},${t.getAttribute('text-anchor')}`),
  );
  const geometry = { nodes: await nodeGeometry(page), edges: await edgePaths(page), labels, viewBox: await viewBox(page) };
  return createHash('sha256').update(JSON.stringify(geometry)).digest('hex');
}

/** Selects `engineId` in Engine ▾ and waits until the canvas shows a layout
 *  whose geometry differs from `before` — the switch's own render. The
 *  switch is one debounced layout request, so the first changed geometry is
 *  the new engine's. */
export async function switchEngine(page: Page, engineId: string, before: string): Promise<void> {
  await page.locator('.engine-picker select').selectOption(engineId);
  await expect(page.locator('.engine-picker select')).toHaveValue(engineId);
  await expect.poll(() => layoutGeometryHash(page), { timeout: 20_000 }).not.toBe(before);
}
