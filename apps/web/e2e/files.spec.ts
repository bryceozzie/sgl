import { expect, test } from '@playwright/test';
import { parse, resolve, toJson } from '@sgl/core';
import {
  corpusDoc,
  edgePaths,
  editorText,
  EXAMPLE_NODE_COUNT,
  nodeGeometry,
  openFile,
  saveAs,
  setSource,
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
    expect(saved.text).toBe(toJson(resolve(parse(edited).ast).model)); // `toJson(model)`.

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

test.describe('DD-08 §7 Open', () => {
  test('Ctrl+O opens the file chooser, and the open is undoable', async ({ page }) => {
    const small = 'solo: "Solo"\n';
    // Focus the editor first: the shortcut must win over CodeMirror.
    await page.locator('.cm-content').click();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await (await chooser).setFiles({ name: 'solo.sgl', mimeType: 'text/plain', buffer: Buffer.from(small) });
    await waitForDocument(page, small);

    // A replace-document transaction, so undo history survives (DD-08 §4).
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+z');
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  });

  test('a file over 2 MB is refused with a toast and the document is untouched', async ({ page }) => {
    const before = await diagram(page);
    await openFile(page, 'huge.sgl', Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    await expect(toastMessages(page)).toContainText(['over 2 MB']);
    expect(await diagram(page)).toEqual(before);
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
    // Byte for byte, it is the same `lastGood.svg` autosave stores.
    await expect.poll(async () => (await storedOpenDocument(page))?.lastGoodSvg).toBe(saved.text);
    expect(saved.text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(saved.text).toContain('<rect class="canvas"'); // background on (DD-07 §9).
  });
});
