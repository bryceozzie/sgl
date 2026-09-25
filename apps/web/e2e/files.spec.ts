import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  corpusDoc,
  edgePaths,
  editorText,
  EXAMPLE_NODE_COUNT,
  nodeGeometry,
  openFile,
  readStorage,
  saveAs,
  setSource,
  SMALL_SOURCE,
  storedOpenDocument,
  toastMessages,
  viewBox,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/**
 * MVP acceptance criterion 4 (06 §3) and DD-08 §14 test 5: open a file, edit,
 * save; reopen the download; identical — for `.sgl`, `.sgl.json` and `.txt`.
 * "Identical" is checked on both halves: the text the editor holds, and the
 * diagram it renders (node geometry, edge routes, viewBox).
 */

/** The canonical JSON the edited `json-form.sgl.json` must save as — checked
 *  in and reviewed against DD-02 §9's serialisation rules (`@sgl` first, root
 *  config, `@classes`, children in declaration order, `@edges` last with
 *  `ordinal`; labels always `@label`, `@type` always an array; two-space
 *  indent, trailing newline), rather than recomputed by `@sgl/core`'s
 *  `toJson`, the function under test. */
const EXPECTED_JSON = readFileSync(fileURLToPath(new URL('./fixtures/json-form-edited.expected.sgl.json', import.meta.url)), 'utf8');

/** A valid document of exactly `bytes` bytes: one node, padded with comment
 *  lines (short ones, so the editor is not handed one 2 MB line). */
function documentOfSize(bytes: number): string {
  const head = 'boundary: "Boundary"\n';
  const line = `// ${'x'.repeat(996)}\n`; // 1 000 bytes
  let text = head;
  while (text.length + line.length <= bytes) text += line;
  const rest = bytes - text.length;
  text += rest < 3 ? '\n'.repeat(rest) : `//${'x'.repeat(rest - 3)}\n`;
  expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
  return text;
}

async function diagram(page: import('@playwright/test').Page) {
  return { nodes: await nodeGeometry(page), edges: await edgePaths(page), viewBox: await viewBox(page) };
}

/** Waits until the editor holds exactly `text` (every line of these small
 *  fixtures is rendered) and its diagram is on screen. */
async function waitForDocument(page: import('@playwright/test').Page, text: string): Promise<void> {
  await expect.poll(() => editorText(page)).toBe(text);
  await waitForExactNodeCount(page, visibleNodeCount(text));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
});

test.describe('MVP acceptance criterion 4 / DD-08 §14 test 5', () => {
  test('.sgl: open, edit, save, reopen the download — identical', async ({ page }) => {
    const fixture = corpusDoc('containers-edges.sgl');
    await openFile(page, 'containers-edges.sgl', fixture);
    await waitForDocument(page, fixture);

    // Edit: one more node and edge, at the end.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    const addition = 'gamma: "Gamma"\nbeta.four -> gamma\n';
    await page.keyboard.insertText(addition);
    const edited = fixture + addition;
    await waitForDocument(page, edited);
    const before = await diagram(page);

    const saved = await saveAs(page, 'sgl');
    // No @title: the first node key names it (DD-08 §7).
    expect(saved.name).toBe('outside.sgl');
    expect(saved.text).toBe(edited); // `source` verbatim.

    // Something else in between, so the reopen is really a load.
    await setSource(page, 'placeholder: "P"\n');
    await waitForDocument(page, 'placeholder: "P"\n');

    await openFile(page, saved.name, saved.text);
    await waitForDocument(page, edited);
    expect(await diagram(page)).toEqual(before);
  });

  test('.sgl.json: open, edit, save as canonical JSON, reopen — identical', async ({ page }) => {
    const fixture = corpusDoc('json-form.sgl.json');
    await openFile(page, 'json-form.sgl.json', fixture);
    await waitForDocument(page, fixture);

    // Edit, in the document's own (JSON) syntax: a new node.
    const edited = fixture.replace('"gateway": { "@label": "API Gateway" },', '"gateway": { "@label": "API Gateway" },\n  "queue": { "@label": "Queue" },');
    expect(edited).not.toBe(fixture);
    await setSource(page, edited);
    await waitForDocument(page, edited);
    const before = await diagram(page);

    const saved = await saveAs(page, 'json');
    expect(saved.name).toBe('JSON subset.sgl.json'); // @title, and the remembered extension.
    expect(saved.text).toBe(EXPECTED_JSON); // canonical JSON (DD-02 §9), byte for byte.

    await setSource(page, 'placeholder: "P"\n');
    await waitForDocument(page, 'placeholder: "P"\n');

    await openFile(page, saved.name, saved.text);
    await waitForDocument(page, saved.text);
    expect(await diagram(page)).toEqual(before);
    // And canonical JSON is a fixed point: saving the reopened file again
    // writes the same bytes.
    expect((await saveAs(page, 'json')).text).toBe(saved.text);
  });

  test('.txt: opens like .sgl and saves back under the remembered extension', async ({ page }) => {
    const fixture = corpusDoc('chains.sgl');
    await openFile(page, 'notes.txt', fixture);
    await waitForDocument(page, fixture);
    const before = await diagram(page);

    const saved = await saveAs(page, 'sgl');
    expect(saved.name.endsWith('.txt')).toBe(true);
    expect(saved.text).toBe(fixture);

    await setSource(page, 'placeholder: "P"\n');
    await waitForDocument(page, 'placeholder: "P"\n');
    await openFile(page, saved.name, saved.text);
    await waitForDocument(page, fixture);
    expect(await diagram(page)).toEqual(before);
  });
});

test.describe('Save ▾ is a disclosure of buttons (fix round 1, item 10)', () => {
  test('no menu roles; Escape and an outside click close it', async ({ page }) => {
    const menu = page.locator('.save-menu');
    await expect(page.locator('.save-menu [role="menu"], .save-menu [role="menuitem"]')).toHaveCount(0);
    await expect(page.locator('.save-menu > summary [aria-hidden="true"]')).toHaveText('▾');
    await expect(page.locator('.save-menu > summary')).toHaveAccessibleName('Save');

    await page.locator('.save-menu > summary').click();
    await expect(menu).toHaveJSProperty('open', true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveJSProperty('open', false);
    await expect(page.locator('.save-menu > summary')).toBeFocused();

    await page.locator('.save-menu > summary').click();
    await expect(menu).toHaveJSProperty('open', true);
    await page.locator('.cm-content').click();
    await expect(menu).toHaveJSProperty('open', false);
  });

  test('the Fit button is named "Fit", its glyph hidden', async ({ page }) => {
    await expect(page.locator('.toolbar-fit')).toHaveAccessibleName('Fit');
  });
});

test.describe('DD-08 §7 Open', () => {
  test('Ctrl+O opens the file chooser; the opened document starts its own undo history', async ({ page }) => {
    const small = 'solo: "Solo"\n';
    // Focus the editor first: the shortcut must win over CodeMirror.
    await page.locator('.cm-content').click();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await (await chooser).setFiles({ name: 'solo.sgl', mimeType: 'text/plain', buffer: Buffer.from(small) });
    await waitForDocument(page, small);

    // Open makes a new document (human decision, 2026-09-23), so undo does
    // not reach back into the previous one — that is in Documents instead.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await editorText(page)).toBe(small);
    await waitForExactNodeCount(page, 1);
  });

  test('Open creates a new local document; the previous record is saved and never touched again (fix round 2, R2)', async ({ page }) => {
    await expect.poll(async () => (await readStorage(page)).documents.length).toBe(1);
    const previousId = (await readStorage(page)).lastOpenDocId!;
    // An edit still inside autosave's 500 ms when Open arrives: it is
    // flushed to the previous record, not carried into the new one.
    await setSource(page, SMALL_SOURCE);
    await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));

    const opened = 'opened: "Opened"\nother: "Other"\nopened -> other\n';
    await openFile(page, 'other.sgl', opened);
    await waitForDocument(page, opened);
    await expect(toastMessages(page)).toContainText(['Opened other.sgl as a new document. Your previous document is in Documents.']);

    await expect.poll(async () => (await readStorage(page)).documents.length).toBe(2);
    const afterOpen = await readStorage(page);
    expect(afterOpen.lastOpenDocId).not.toBe(previousId);
    const previous = afterOpen.documents.find((d) => d.id === previousId)!;
    expect(previous.source).toBe(SMALL_SOURCE);
    await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(opened);
    expect((await storedOpenDocument(page))?.fileExtension).toBe('.sgl');

    // Edit the new document and let it save: the previous record stays
    // byte for byte what it was.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('third: "Third"\n');
    await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(`${opened}third: "Third"\n`);

    await page.reload();
    await waitForDocument(page, `${opened}third: "Third"\n`);
    const afterReload = await readStorage(page);
    expect(afterReload.documents).toHaveLength(2);
    expect(JSON.stringify(afterReload.documents.find((d) => d.id === previousId))).toBe(JSON.stringify(previous));
  });

  test('a file over 2 MB is refused with a toast and the document is untouched', async ({ page }) => {
    const before = await diagram(page);
    await openFile(page, 'huge.sgl', Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await expect(toastMessages(page)).toContainText(['over 2 MB']);
    expect(await diagram(page)).toEqual(before);
  });

  test('the 2 MB boundary: exactly 2 MB opens, 2 MB + 1 byte is refused', async ({ page }) => {
    const twoMb = 2 * 1024 * 1024;
    const over = documentOfSize(twoMb + 1);
    const before = await diagram(page);
    await openFile(page, 'over.sgl', over);
    await expect(toastMessages(page)).toContainText(['over 2 MB']);
    expect(await diagram(page)).toEqual(before);

    await page.locator('.toast-dismiss').click();
    await openFile(page, 'exact.sgl', documentOfSize(twoMb));
    await waitForExactNodeCount(page, 1);
    await expect(page.locator('.cm-content > .cm-line').first()).toHaveText('boundary: "Boundary"');
    await expect(toastMessages(page)).toHaveText(['Opened exact.sgl as a new document. Your previous document is in Documents.']);
  });

  test('SVG saves lastGood.svg, exactly what the canvas shows', async ({ page }) => {
    const saved = await saveAs(page, 'svg');
    expect(saved.name).toBe('Checkout Flow.svg');
    const onScreen = await page.locator('.canvas-host g.rendered[data-origin="live"]').evaluate((g) => g.innerHTML);
    // The browser re-serialises what it parsed, so compare what matters:
    // one root <svg>, the same element count, the same viewBox.
    const parsed = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      return { root: doc.documentElement.localName, count: doc.getElementsByTagName('*').length, viewBox: doc.documentElement.getAttribute('viewBox') };
    }, saved.text);
    const shown = await page.evaluate((html) => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.innerHTML = html;
      const svg = g.firstElementChild!;
      return { root: svg.localName, count: svg.getElementsByTagName('*').length + 1, viewBox: svg.getAttribute('viewBox') };
    }, onScreen);
    expect(parsed).toEqual(shown);
    // Byte for byte, it is the same `lastGood.svg` autosave stores, plus the
    // Inter faces it uses at the start of its `<style>` (D2; the faces
    // themselves: `svg-export.spec.ts`).
    expect(saved.text).toContain('<style>@font-face{');
    await expect.poll(async () => (await storedOpenDocument(page))?.lastGoodSvg).toBe(saved.text.replace(/@font-face\{[^}]*\}\n/g, ''));
    expect(saved.text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(saved.text).toContain('<rect class="canvas"'); // background on (DD-07 §9).
  });
});

test.describe('DD-08 §12 launch queue (fix round 1, item 13)', () => {
  // `beforeEach` above has already loaded the page; this one needs its fake
  // `launchQueue` in place before the app's scripts run, so it loads again.
  test('a file delivered before the editor exists is opened, not dropped', async ({ page }) => {
    const launched = 'launched: "Launched"\n';
    await page.addInitScript((text) => {
      const file = new File([text], 'launched.sgl', { type: 'text/plain' });
      // Chromium's real launchQueue delivers to a consumer as soon as it is
      // set — here, synchronously, during the app's first effects, before
      // CodeMirror's view has reached the shell.
      // (Chromium has a native, read-only `launchQueue`: redefine it.)
      Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: {
          setConsumer(consumer: (params: unknown) => void) {
            consumer({ files: [{ getFile: () => Promise.resolve(file) }] });
          },
        },
      });
    }, launched);
    await page.goto('/');
    await waitForDocument(page, launched);
    // The remembered extension came with it (§7).
    expect((await saveAs(page, 'sgl')).name).toBe('launched.sgl');
  });
});
