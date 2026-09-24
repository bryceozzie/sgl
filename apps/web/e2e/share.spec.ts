import { readFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  edgePaths,
  editorText,
  EXAMPLE_NODE_COUNT,
  EXAMPLE_SOURCE,
  layoutGeometryHash,
  nodeGeometry,
  readStorage,
  setSource,
  SMALL_SOURCE,
  storedOpenDocument,
  toastMessages,
  viewBox,
  visibleNodeCount,
  waitForExactNodeCount,
  waitForNodeCount,
  waitForTheme,
} from './helpers.js';

/** MVP acceptance criterion 6 (06 §3) and DD-08 §14 test 6: share by URL
 *  (DD-08 §8). */

async function diagram(page: Page) {
  return { nodes: await nodeGeometry(page), edges: await edgePaths(page), viewBox: await viewBox(page) };
}

/** Opens the Share dialog and returns its link, whose `e=`/`t=` must be
 *  exactly `sgl.elk` (the default engine, Stage K) and `themeId` — the
 *  effective engine and theme the sharer sees. */
async function shareLinkFor(page: Page, themeId: string): Promise<string> {
  await page.locator('.share-open').click();
  const link = await page.locator('.share-link').inputValue();
  expect(link).toMatch(/#s=[A-Za-z0-9_-]+&e=[^&]+&t=[^&]+$/);
  const params = new URLSearchParams(new URL(link).hash.slice(1));
  expect(params.get('e')).toBe('sgl.elk');
  expect(params.get('t')).toBe(themeId);
  return link;
}

/** The source inside a link, decoded independently of the app: Node's own
 *  base64url and raw inflate (DD-08 §8's format), not `state/share.ts`. */
function sourceInLink(link: string): string {
  const s = new URLSearchParams(new URL(link).hash.slice(1)).get('s')!;
  expect(s).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, unpadded
  return inflateRawSync(Buffer.from(s, 'base64url')).toString('utf8');
}

/** A link built by Node's own zlib, not by the app's encoder. */
function nodeBuiltHash(source: string, extra = ''): string {
  return `#s=${deflateRawSync(Buffer.from(source, 'utf8')).toString('base64url')}${extra}`;
}

/** A document the example is not, so arriving at it proves the link opened. */
const SHARED = 'shared: {\n  @label: "Shared"\n  a: "Alpha"\n  b: "Beta"\n  a -> b: "link"\n}\nsolo: "Solo"\nshared.b -> solo\n';

test('criterion 6: a share link opens identically in a fresh browser context', async ({ page, browser }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  // A document that names its own theme: the picker edits that entry in
  // place (DD-08 §10, F9 P1), so the link's source carries the pick.
  const themed = `@theme: "neutral-light"\n${SHARED}`;
  await setSource(page, themed);
  await waitForExactNodeCount(page, visibleNodeCount(themed));
  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toContain('@theme: "neutral-dark"');
  const source = (await storedOpenDocument(page))!.source;
  const sharedDiagram = await diagram(page);
  const link = await shareLinkFor(page, 'neutral-dark');
  expect(sourceInLink(link)).toBe(source); // the link carries exactly the source, in DD-08 §8's format

  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto(link);
    await waitForExactNodeCount(other, visibleNodeCount(source));
    await waitForTheme(other, 'neutral-dark');

    expect(await diagram(other)).toEqual(sharedDiagram); // the diagram appears, identical…
    await expect.poll(async () => (await storedOpenDocument(other))?.source).toBe(source); // …from identical source.
    expect(new URL(other.url()).hash).toBe(''); // cleared, so a reload does not re-import.
    await expect(toastMessages(other)).toContainText(['Opened the shared diagram']);
  } finally {
    await fresh.close();
  }
});

test('criterion 6, theme half: with no @theme in the source, the receiver renders the t= theme', async ({ page, browser }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  // With no @theme in the document the picker is a view preference (DD-08
  // §10, F9 P1): it leaves the source alone, and the choice travels as t=.
  const exampleText = await editorText(page);
  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  expect(await editorText(page)).toBe(exampleText);
  await setSource(page, SHARED);
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
  await waitForTheme(page, 'neutral-dark');
  const link = await shareLinkFor(page, 'neutral-dark');
  expect(sourceInLink(link)).toBe(SHARED);
  expect(SHARED).not.toContain('@theme');

  const fresh = await browser.newContext(); // its own default theme is neutral-light
  try {
    const other = await fresh.newPage();
    await other.goto(link);
    await waitForExactNodeCount(other, visibleNodeCount(SHARED));
    await waitForTheme(other, 'neutral-dark'); // only t= can have said so
    await expect(other.locator('.theme-picker select')).toHaveValue('neutral-dark');
    await expect(other.locator('.theme-picker .picker-label')).toHaveText('Theme'); // not "(set by document)"
    await expect.poll(async () => (await storedOpenDocument(other))?.themeId).toBe('neutral-dark');
  } finally {
    await fresh.close();
  }
});

test('criterion 6: a link made outside the app (Node zlib) opens with exactly its source', async ({ browser }) => {
  const fresh = await browser.newContext();
  try {
    const page = await fresh.newPage();
    await page.goto(`/${nodeBuiltHash(SHARED, '&e=sgl.grid&t=neutral-dark')}`);
    await waitForExactNodeCount(page, visibleNodeCount(SHARED));
    await waitForTheme(page, 'neutral-dark');
    expect(await editorText(page)).toBe(SHARED);
    await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(SHARED);
    // e=sgl.grid, not the default elk (fix round 1, item 15): the picker says
    // so, the record keeps it, and the geometry is grid's, not elk's.
    await expect(page.locator('.engine-picker select')).toHaveValue('sgl.grid');
    await expect.poll(async () => (await storedOpenDocument(page))?.engineId).toBe('sgl.grid');
    const gridGeometry = await layoutGeometryHash(page);

    const elkPage = await fresh.newPage();
    await elkPage.goto(`/${nodeBuiltHash(SHARED, '&e=sgl.elk&t=neutral-dark')}`);
    await waitForExactNodeCount(elkPage, visibleNodeCount(SHARED));
    await expect(elkPage.locator('.engine-picker select')).toHaveValue('sgl.elk');
    expect(await layoutGeometryHash(elkPage)).not.toBe(gridGeometry);
  } finally {
    await fresh.close();
  }
});

test('opening a share link makes a new document and never overwrites the current one', async ({ page, browser }) => {
  // The link, made elsewhere.
  const maker = await browser.newContext();
  let link: string;
  try {
    const other = await maker.newPage();
    await other.goto('/');
    await waitForNodeCount(other, EXAMPLE_NODE_COUNT);
    await setSource(other, SHARED);
    await waitForExactNodeCount(other, visibleNodeCount(SHARED));
    link = await shareLinkFor(other, 'neutral-light');
  } finally {
    await maker.close();
  }

  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await expect.poll(async () => (await readStorage(page)).documents.length).toBe(1);
  const mine = (await storedOpenDocument(page))!;

  await page.goto('about:blank');
  await page.goto(link);
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));

  const after = await readStorage(page);
  expect(after.documents).toHaveLength(2);
  expect(after.documents.find((d) => d.id === mine.id)?.source).toBe(EXAMPLE_SOURCE); // untouched
  const opened = after.documents.find((d) => d.id === after.lastOpenDocId)!;
  expect(opened.id).not.toBe(mine.id);
  expect(opened.source).toBe(SHARED);

  // The hash is gone, so a reload reopens the new document, not a third copy.
  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
  expect((await readStorage(page)).documents).toHaveLength(2);
});

test.describe('DD-08 §14 test 6: invalid links toast and open the last document', () => {
  /** A context whose last document is SMALL_SOURCE (not the example), so
   *  "the last document opens" is distinguishable from "a new one". */
  async function withLastDocument(page: Page): Promise<void> {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await setSource(page, SMALL_SOURCE);
    await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(SMALL_SOURCE);
    await page.goto('about:blank');
  }

  async function expectRefused(page: Page, hash: string): Promise<void> {
    await page.goto(`/${hash}`);
    await expect(toastMessages(page)).toContainText(['This share link is not valid']);
    await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
    expect((await storedOpenDocument(page))?.source).toBe(SMALL_SOURCE);
    expect((await readStorage(page)).documents).toHaveLength(1); // nothing imported
    expect(new URL(page.url()).hash).toBe('');
  }

  test('a corrupt fragment', async ({ page }) => {
    await withLastDocument(page);
    await expectRefused(page, '#s=this*is*not*base64url&e=sgl.grid');
  });

  test('a valid-looking fragment that is not deflate', async ({ page }) => {
    await withLastDocument(page);
    await expectRefused(page, `#s=${Buffer.from('definitely not deflate data').toString('base64url')}`);
  });

  test('an oversize fragment (inflates past the 2 MB cap)', async ({ page }) => {
    await withLastDocument(page);
    const bomb = deflateRawSync(Buffer.alloc(3 * 1024 * 1024, 0x61)).toString('base64url');
    await expectRefused(page, `#s=${bomb}`);
  });
});

test.describe('a share link pasted into an already-open tab (a same-document hash change)', () => {
  test('imports it as a new document, after saving the current one', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect.poll(async () => (await readStorage(page)).documents.length).toBe(1);
    const mine = (await storedOpenDocument(page))!;
    // An edit still inside autosave's 500 ms when the link arrives.
    await setSource(page, SMALL_SOURCE);
    await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));

    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, nodeBuiltHash(SHARED, '&e=sgl.grid&t=neutral-dark'));

    await waitForExactNodeCount(page, visibleNodeCount(SHARED));
    expect(await editorText(page)).toBe(SHARED);
    await expect(toastMessages(page)).toContainText(['Opened the shared diagram']);
    expect(new URL(page.url()).hash).toBe('');
    const after = await readStorage(page);
    expect(after.documents).toHaveLength(2);
    expect(after.documents.find((d) => d.id === mine.id)?.source).toBe(SMALL_SOURCE); // flushed first, not lost
    expect(after.lastOpenDocId).not.toBe(mine.id);
    expect(after.documents.find((d) => d.id === after.lastOpenDocId)?.source).toBe(SHARED);
  });

  test('an invalid one toasts and leaves the open document alone', async ({ page }) => {
    await page.goto('/');
    await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
    await setSource(page, SMALL_SOURCE);
    await waitForExactNodeCount(page, visibleNodeCount(SMALL_SOURCE));
    await page.evaluate(() => {
      window.location.hash = '#s=this*is*not*base64url';
    });
    await expect(toastMessages(page)).toContainText(['This share link is not valid']);
    expect(new URL(page.url()).hash).toBe('');
    expect(await editorText(page)).toBe(SMALL_SOURCE);
    await expect.poll(async () => (await readStorage(page)).documents.length).toBe(1);
    await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(SMALL_SOURCE);
  });
});

test('the Share dialog takes focus, closes on Escape, and gives focus back to Share', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await page.locator('.share-open').click();
  await expect(page.locator('.share-link')).toBeFocused();
  await page.keyboard.press('Escape'); // no tabbing in first
  await expect(page.locator('.share-dialog')).toHaveCount(0);
  await expect(page.locator('.share-open')).toBeFocused();

  await page.locator('.share-open').click();
  await expect(page.locator('.share-link')).toBeFocused();
  await page.locator('.share-close').click();
  await expect(page.locator('.share-dialog')).toHaveCount(0);
  await expect(page.locator('.share-open')).toBeFocused();
});

test('a link over 8 000 characters warns and offers the file save instead', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  // Labels that do not compress: a deterministic pseudo-random hex stream.
  let x = 0x2545f491;
  const hex = (): string => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0).toString(16).padStart(8, '0');
  };
  const lines: string[] = [];
  for (let i = 0; i < 400; i += 1) lines.push(`n${i}: "${hex()}${hex()}${hex()}${hex()}"`);
  const big = `${lines.join('\n')}\n`;
  await setSource(page, big);
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(big);

  await page.locator('.share-open').click();
  expect((await page.locator('.share-link').inputValue()).length).toBeGreaterThan(8000);
  await expect(page.locator('.share-warning')).toContainText('cut long links short');

  const download = page.waitForEvent('download');
  await page.locator('.share-save').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('n0.sgl');
  expect(readFileSync(await file.path(), 'utf8')).toBe(big);
});
