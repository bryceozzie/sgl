import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  edgePaths,
  EXAMPLE_NODE_COUNT,
  EXAMPLE_SOURCE,
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

async function shareLinkFor(page: Page): Promise<string> {
  await page.locator('.share-open').click();
  const link = await page.locator('.share-link').inputValue();
  expect(link).toMatch(/#s=[A-Za-z0-9_-]+&e=sgl\.grid&t=neutral-(light|dark)$/);
  return link;
}

/** A document the example is not, so arriving at it proves the link opened. */
const SHARED = 'shared: {\n  @label: "Shared"\n  a: "Alpha"\n  b: "Beta"\n  a -> b: "link"\n}\nsolo: "Solo"\nshared.b -> solo\n';

test('criterion 6: a share link opens identically in a fresh browser context', async ({ page, browser }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, SHARED);
  await waitForExactNodeCount(page, visibleNodeCount(SHARED));
  await page.locator('.theme-picker select').selectOption('neutral-dark'); // writes @theme into the source (DD-08 §10)
  await waitForTheme(page, 'neutral-dark');
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toContain('@theme');
  const source = (await storedOpenDocument(page))!.source;
  const sharedDiagram = await diagram(page);
  const link = await shareLinkFor(page);

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
    link = await shareLinkFor(other);
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
