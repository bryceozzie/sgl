import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { scaleDocument } from '../../../bench/scale-document.js';
import { diagnosticCodes, EXAMPLE_NODE_COUNT, openFile, renderedSvg, toastMessages, visibleNodeCount, waitForExactNodeCount, waitForNodeCount } from './helpers.js';

/**
 * F19 (execution plan §2.1): a large document must reach the pipeline as a
 * **whole** parse. CodeMirror parses a replaced document only as far as a
 * ~20 ms budget or the viewport before its `updateListener` fires, and parses
 * the rest in the background, which changes no text and so never told the
 * pipeline again; its background parse also stops 100 000 characters past the
 * viewport. Each test takes a real UI path that hands the editor a large text
 * and asserts the canvas shows every node and no diagnostic.
 *
 * The documents are `bench/scale-document.js`'s (`n2000` is the bench's
 * 78 kB one), built in memory so this spec needs no generate step. The layout
 * is `grid`, picked through Engine ▾ before a document is opened (Open and
 * New document take the pickers as they stand): the finding is about
 * parsing, and `elk` would only make every test slower.
 */

const N2000 = scaleDocument(2000);
/** Longer than CodeMirror's 100 000-character background parse-ahead. */
const N3000 = scaleDocument(3000);
/** The largest scale document (in hundreds) whose share link stays within the
 *  Share dialog's 8 000-character warning (DD-08 §8). */
const N800 = scaleDocument(800);

const shareHash = (source: string): string => `#s=${deflateRawSync(Buffer.from(source, 'utf8')).toString('base64url')}&e=sgl.grid&t=neutral-light`;

test.describe.configure({ timeout: 90_000 });

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await page.locator('.engine-picker select').selectOption('sgl.grid');
  await expect(page.locator('.engine-picker select')).toHaveValue('sgl.grid');
}

/** How long a large document may take to reach the canvas (07 §2). A 3 000-
 *  node boot or edit renders in ~2–4 s quiet (parse, layout in the worker,
 *  render) and went past the default 5 s expect timeout at load 17. The
 *  conditions waited on are the render itself (its title, then its exact
 *  node count), so a generous bound makes the test no weaker: a cut-short
 *  parse (F19) never shows the whole count, and still fails, only later. */
const WHOLE = { timeout: 45_000 };

/** The whole of `source`, titled `title`, is the canvas's live render, and
 *  nothing was reported against it: no diagnostic, and the chip is not
 *  showing a last good render in its place. */
async function expectWhole(page: Page, source: string, title: string): Promise<void> {
  await expect(renderedSvg(page).locator('title#sgl-t')).toHaveText(title, WHOLE);
  await waitForExactNodeCount(page, visibleNodeCount(source), WHOLE);
  await expect.poll(() => diagnosticCodes(page)).toEqual([]);
  await expect(page.locator('.chip-last-good, .chip-crashed')).toHaveCount(0);
}

async function openList(page: Page): Promise<void> {
  await page.locator('.docs-menu > summary').click();
  await expect(page.locator('.docs-menu')).toHaveJSProperty('open', true);
}

test('Open renders the whole of a 2 000-node file', async ({ page }) => {
  await start(page);
  await openFile(page, 'n2000.sgl', N2000);
  await expectWhole(page, N2000, 'Scale 2000');
});

test('Documents ▾ renders the whole of a 2 000-node stored document', async ({ page }) => {
  await start(page);
  await openFile(page, 'n2000.sgl', N2000);
  await openList(page);
  await page.locator('.docs-new').click();
  await waitForExactNodeCount(page, 0);
  await openList(page);
  await page.locator('.docs-menu .docs-item').filter({ hasText: '2000' }).click();
  await expectWhole(page, N2000, 'Scale 2000');
});

test('a share link renders the whole of the largest scale document within the 8 000-character guard', async ({ page, baseURL }) => {
  const hash = shareHash(N800);
  expect(`${baseURL}/${hash}`.length).toBeLessThanOrEqual(8000);
  await page.goto(`/${hash}`);
  await expectWhole(page, N800, 'Scale 800');
});

test('an edit to a 3 000-node document just after it boots renders the whole of it', async ({ page }) => {
  await start(page);
  await openFile(page, 'n3000.sgl', N3000);
  // Once it is the open document (the switch awaits the previous one's
  // flush first, F12/F13 round 1, item 8), not while Open is still running.
  await expect(toastMessages(page)).toContainText(['Opened n3000.sgl as a new document']);
  // A reload boots it from storage: the editor starts with only its first
  // screen parsed, and parses on in the background.
  await page.reload();
  await expectWhole(page, N3000, 'Scale 3000');
  // Retitle it on line 2: `@title: "Scale 3000"` → `@title: "Scale 3000!"`.
  await page.locator('.cm-content .cm-line').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.insertText('!');
  await expect(page.locator('.cm-content .cm-line').nth(1)).toHaveText('@title: "Scale 3000!"');
  await expectWhole(page, N3000.replace('@title: "Scale 3000"', '@title: "Scale 3000!"'), 'Scale 3000!');
});
