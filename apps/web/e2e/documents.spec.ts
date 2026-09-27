import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  editorText,
  EXAMPLE_NODE_COUNT,
  readStorage,
  setSource,
  SMALL_SOURCE,
  storedOpenDocument,
  toastMessages,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/** Fix round 2 (human decision 2026-09-23): the minimal slice of E17 — a
 *  Documents list that reaches every stored document, so one left behind by
 *  Open or a share link is never lost. DD-08 §2's `[≡ docs]`. */

const SHARED = 'shared: {\n  @label: "Shared"\n  a: "Alpha"\n  b: "Beta"\n  a -> b\n}\n';
const shareHash = (source: string): string => `#s=${deflateRawSync(Buffer.from(source, 'utf8')).toString('base64url')}&e=sgl.grid&t=neutral-light`;

const menu = (page: Page) => page.locator('.docs-menu');
async function openList(page: Page): Promise<void> {
  await page.locator('.docs-menu > summary').click();
  await expect(menu(page)).toHaveJSProperty('open', true);
}
const items = (page: Page) => page.locator('.docs-menu .docs-item');

test('a document left behind by a share link is reached through Documents, its text intact', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, SMALL_SOURCE);
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(SMALL_SOURCE);
  const mine = (await storedOpenDocument(page))!;

  await page.goto('about:blank');
  await page.goto(`/${shareHash(SHARED)}`);
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
  await expect(toastMessages(page)).toContainText(['Opened the shared diagram as a new document. Your previous document is in Documents.']);

  await openList(page);
  await expect(items(page)).toHaveCount(2);
  // Most recent first; the open one marked.
  await expect(items(page).nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(items(page).nth(0).locator('.docs-title')).toHaveText('shared');
  await expect(items(page).nth(1).locator('.docs-title')).toHaveText('checkout');
  await expect(page.locator('.docs-menu [aria-current="true"]')).toHaveCount(1);

  await items(page).nth(1).click();
  await expect(menu(page)).toHaveJSProperty('open', false);
  await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
  // Both documents render 3 nodes, so wait for the text itself: the switch
  // now awaits the open document's flush first (F12/F13 round 1, item 8).
  await expect.poll(() => editorText(page)).toBe(SMALL_SOURCE);
  await expect.poll(async () => (await readStorage(page)).lastOpenDocId).toBe(mine.id);
  const stored = await readStorage(page);
  expect(stored.documents).toHaveLength(2);
  expect(stored.documents.find((d) => d.id === mine.id)?.source).toBe(SMALL_SOURCE);
  expect(stored.documents.find((d) => d.id !== mine.id)?.source).toBe(SHARED);

  // And back again: the shared one is intact too.
  await openList(page);
  await items(page).filter({ hasText: 'shared' }).click();
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
  await expect.poll(() => editorText(page)).toBe(SHARED);

  // A reload opens the last one chosen.
  await page.reload();
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
});

test('edits made just before switching are saved to the document they were made in', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await page.goto(`/${shareHash(SHARED)}`);
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
  const shared = (await storedOpenDocument(page))!;
  const edited = `${SHARED}solo: "Solo"\n`;
  await setSource(page, edited); // inside autosave's 500 ms
  await waitForExactNodeCount(page, visibleNodeCount(edited));

  await openList(page);
  await items(page).filter({ hasText: 'checkout' }).click();
  await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect.poll(async () => (await readStorage(page)).documents.find((d) => d.id === shared.id)?.source).toBe(edited);
  // Nothing of the other document leaked into it, nor of it into the other.
  const { documents } = await readStorage(page);
  expect(documents.filter((d) => d.source === edited)).toHaveLength(1);
});

test('New document starts an empty one and keeps the others', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect.poll(async () => (await readStorage(page)).documents.length).toBe(1);
  await openList(page);
  await page.locator('.docs-new').click();
  await expect.poll(() => editorText(page)).toBe('');
  await expect.poll(async () => (await readStorage(page)).documents.length).toBe(2);
  expect((await storedOpenDocument(page))?.source).toBe('');
  await openList(page);
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0)).toHaveAttribute('aria-current', 'true');
});

test('Documents ▾ is a plain disclosure: no menu roles; Escape and an outside click close it', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect(page.locator('.docs-menu [role="menu"], .docs-menu [role="menuitem"]')).toHaveCount(0);
  await expect(page.locator('.docs-menu > summary')).toHaveAccessibleName('Documents');
  await openList(page);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveJSProperty('open', false);
  await expect(page.locator('.docs-menu > summary')).toBeFocused();
  await openList(page);
  await page.locator('.cm-content').click();
  await expect(menu(page)).toHaveJSProperty('open', false);
});
