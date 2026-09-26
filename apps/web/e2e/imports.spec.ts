import { inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  diagnosticCodes,
  editorText,
  EXAMPLE_NODE_COUNT,
  nodeGeometry,
  openFile,
  readStorage,
  renderedSvg,
  setSource,
  storedOpenDocument,
  toastMessages,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/**
 * A9 `@imports`, end to end (DD-02 §10, DD-08 §15.5): a relative import path
 * finds one of your stored documents (by the name Open read it under, or the
 * name Save ▾ would give it), its classes, variables and — with `as:` — its
 * nodes arrive, an edit to it reaches its importer, Share carries it in the
 * link (`i=`) and the recipient gets it as a new document in Documents ▾,
 * and every way an import can fail is a warning with the rest still drawn.
 * The offline half (the lazy `imports` chunk from the precache) is
 * `offline.spec.ts`'s; `csp.spec.ts` loads it under the policy.
 */

/** A class library with no nodes, opened as `classes.sgl`. Its title is
 *  deliberately not `classes`: the import finds it by its file name (I3). */
const CLASSES = '@title: "Shared classes"\n@vars: { tier: "prod" }\n@classes: {\n  Service: { @shape: hexagon }\n}\n';
/** Imports it without `as`: `Service` and `$tier` arrive unqualified. */
const IMPORTER = '@title: "Importer"\n@imports: ["./shared/classes.sgl"]\napi: { @type: Service, @label: "API (${tier})" }\ndb\napi -> db\n';

/** A library with nodes, opened as `aws-icons.sgl`. */
const AWS = '@title: "AWS"\n@classes: { Lambda: { @shape: diamond } }\nlambda: { @type: Lambda }\nqueue: "SQS"\nlambda -> queue\n';
const AWS_IMPORTER = '@title: "Uses AWS"\n@imports: [{ path: "./aws-icons.sgl", as: aws }]\nfn: aws.Lambda\nfn -> aws.queue\n';

const menu = (page: Page) => page.locator('.docs-menu');
const items = (page: Page) => page.locator('.docs-menu .docs-item');
async function openList(page: Page): Promise<void> {
  await page.locator('.docs-menu > summary').click();
  await expect(menu(page)).toHaveJSProperty('open', true);
}

/** Documents ▾ → the document titled `title`. */
async function switchTo(page: Page, title: string): Promise<void> {
  await openList(page);
  await items(page).filter({ has: page.locator('.docs-title', { hasText: new RegExp(`^${title}$`) }) }).click();
  await expect(menu(page)).toHaveJSProperty('open', false);
}

/** Documents ▾ → New document, then `source` typed into it and saved. */
async function newDocument(page: Page, source: string): Promise<void> {
  const before = (await readStorage(page)).documents.length;
  await openList(page);
  await page.locator('.docs-new').click();
  await expect.poll(() => editorText(page)).toBe('');
  await expect.poll(async () => (await readStorage(page)).documents.length).toBe(before + 1);
  await setSource(page, source);
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(source);
}

/** A rendered node's shape, from its `sh-*` class (DD-07 §4). */
async function shapeOf(page: Page, id: string): Promise<string | undefined> {
  const cls = await renderedSvg(page).locator(`g[id="n-${id}"]`).getAttribute('class');
  return /\bsh-([a-z]+)/.exec(cls ?? '')?.[1];
}

/** The diagnostics panel's rows as `code severity`, in its order. */
async function diagnosticRows(page: Page): Promise<string[]> {
  return page
    .locator('.diagnostics-panel .diag')
    .evaluateAll((rows) => rows.map((r) => `${r.querySelector('.diag-code')?.textContent ?? ''} ${/\bdiag-(error|warning|info)\b/.exec(r.className)?.[1] ?? ''}`));
}

/** Boots on the example, then opens `files` in order, each a new document. */
async function withStored(page: Page, files: readonly (readonly [string, string])[]): Promise<void> {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  for (const [name, text] of files) {
    const before = (await readStorage(page)).documents.length;
    await openFile(page, name, text);
    await expect(toastMessages(page).last()).toContainText(`Opened ${name} as a new document`);
    await expect.poll(async () => (await readStorage(page)).documents.length).toBe(before + 1);
  }
}

test("a stored classes.sgl, imported from another document: its classes and variables are applied, and an edit to it reaches the importer", async ({ page }) => {
  await withStored(page, [['classes.sgl', CLASSES]]);
  await newDocument(page, IMPORTER);
  await waitForExactNodeCount(page, 2);
  await expect.poll(() => shapeOf(page, 'api')).toBe('hexagon'); // the imported class…
  await expect(renderedSvg(page).locator('g[id="n-api"] text')).toHaveText('API (prod)'); // …and variable
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);

  // Freshness (I24): switch to the library, change the class, switch back.
  await switchTo(page, 'Shared classes');
  await expect.poll(() => editorText(page)).toBe(CLASSES);
  const edited = CLASSES.replace('hexagon', 'round');
  await setSource(page, edited);
  await expect.poll(async () => (await storedOpenDocument(page))?.source).toBe(edited);
  await switchTo(page, 'Importer');
  await waitForExactNodeCount(page, 2);
  await expect.poll(() => shapeOf(page, 'api')).toBe('round');
  expect((await storedOpenDocument(page))?.source).toBe(IMPORTER); // the importer itself is unchanged
});

test('`as: aws`: `aws.Lambda` is a class, and the import\'s nodes and edge arrive under a container `aws`', async ({ page }) => {
  await withStored(page, [['aws-icons.sgl', AWS]]);
  await newDocument(page, AWS_IMPORTER);
  // fn, the container aws, and aws.lambda and aws.queue inside it.
  await waitForExactNodeCount(page, 4);
  expect(await shapeOf(page, 'fn')).toBe('diamond');
  expect(await shapeOf(page, 'aws.lambda')).toBe('diamond');
  await expect(renderedSvg(page).locator('g.L-containers > g.c[id="n-aws"]')).toHaveCount(1);
  await expect(renderedSvg(page).locator('g[id="n-aws.queue"] text')).toHaveText('SQS');
  // The container is labelled with the import's @title.
  await expect(renderedSvg(page).locator('text', { hasText: /^AWS$/ })).toHaveCount(1);
  // fn -> aws.queue and the import's own aws.lambda -> aws.queue.
  await expect(renderedSvg(page).locator('g.L-edges > g.e')).toHaveCount(2);
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
  // The document is still named after its own @title, not the import.
  expect((await storedOpenDocument(page))?.title).toBe('Uses AWS');
});

test('an unresolved import is a warning in the diagnostics panel, and the diagram is still drawn', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  const source = '@imports: [{ path: "./nowhere.sgl", as: gone }]\napi\ndb\nx: gone.Thing\napi -> db\napi -> gone.thing\n';
  await setSource(page, source);
  await waitForExactNodeCount(page, 3);
  await expect(renderedSvg(page).locator('g.L-edges > g.e')).toHaveCount(1);
  // SGL2017 for the import; SGL2024 for the class through it and the edge into it (I17).
  await expect.poll(() => diagnosticRows(page)).toEqual(['SGL2017 warning', 'SGL2024 warning', 'SGL2024 warning']);
  await expect(page.locator('.diagnostics-panel .diag-message').first()).toContainText('Cannot find `./nowhere.sgl` to import');
  await expect(page.locator('.diagnostics-panel .diag-error')).toHaveCount(0);
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
});

test('a cycle is a warning, the import that closes it is skipped, and the rest renders', async ({ page }) => {
  await withStored(page, [
    ['cycle-b.sgl', '@imports: ["./cycle-a.sgl"]\n@classes: { B: { @shape: diamond } }\n'],
    ['cycle-a.sgl', '@imports: ["./cycle-b.sgl"]\n@classes: { A: {} }\nx: B\ny: A\nx -> y\n'],
  ]);
  // cycle-a is open: it imports cycle-b, which imports cycle-a (itself).
  await waitForExactNodeCount(page, 2);
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL2019']);
  await expect(page.locator('.diagnostics-panel .diag-warning .diag-message')).toHaveText(
    '`./cycle-a.sgl` imports itself via `this document -> ./cycle-b.sgl -> ./cycle-a.sgl`; this import was skipped.',
  );
  expect(await shapeOf(page, 'x')).toBe('diamond'); // cycle-b's class still arrived
});

test('an import that matches two documents is a warning, and the most recently updated one is used', async ({ page }) => {
  await withStored(page, [
    ['dup.sgl', '@classes: { Dup: { @shape: round } }\n'],
    ['dup.sgl.json', '{ "@classes": { "Dup": { "@shape": "diamond" } } }'],
  ]);
  await newDocument(page, '@imports: ["./dup.sgl"]\nn: Dup\n');
  await waitForExactNodeCount(page, 1);
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL2018']);
  await expect(page.locator('.diagnostics-panel .diag-warning .diag-message')).toContainText('`./dup.sgl` matches 2 documents');
  expect(await shapeOf(page, 'n')).toBe('diamond'); // dup.sgl.json, opened second
});

test('Share carries the imports (`i=`): a fresh browser gets them as a group in Documents ▾, and renders the same; its own `classes` is untouched', async ({ page, browser }) => {
  await withStored(page, [['classes.sgl', CLASSES]]);
  await newDocument(page, IMPORTER);
  await waitForExactNodeCount(page, 2);
  await expect.poll(() => shapeOf(page, 'api')).toBe('hexagon');
  const sent = await nodeGeometry(page);

  await page.locator('.share-open').click();
  await expect(page.locator('.share-note')).toHaveText('The whole diagram is inside this link, with the document it imports. Nothing is uploaded anywhere.');
  const link = await page.locator('.share-link').inputValue();
  const params = new URLSearchParams(new URL(link).hash.slice(1));
  expect(inflateRawSync(Buffer.from(params.get('s')!, 'base64url')).toString('utf8')).toBe(IMPORTER);
  // DD-08 §15.3 I26's format, decoded by Node's own zlib.
  expect(JSON.parse(inflateRawSync(Buffer.from(params.get('i')!, 'base64url')).toString('utf8'))).toEqual({
    v: 1,
    d: [{ n: 'classes', t: 'Shared classes', s: CLASSES }],
  });

  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    // The recipient has a `classes.sgl` of their own, and a document using it.
    await withStored(other, [['classes.sgl', '@classes: { Service: { @shape: ellipse } }\n']]);
    await newDocument(other, '@title: "Mine"\n@imports: ["./classes.sgl"]\nmine: Service\n');
    await waitForExactNodeCount(other, 1);
    await expect.poll(() => shapeOf(other, 'mine')).toBe('ellipse');

    await other.goto('about:blank');
    await other.goto(link);
    await waitForExactNodeCount(other, 2);
    await expect.poll(() => shapeOf(other, 'api')).toBe('hexagon'); // the bundled classes, not the recipient's
    expect(await nodeGeometry(other)).toEqual(sent);
    await expect(toastMessages(other)).toContainText(['Opened the shared diagram and its imported document as new documents.']);
    await expect(other.locator('.diagnostics-panel')).toHaveCount(0);

    // Stored as a group (I29): the bundled document and the main one share it.
    const { documents, lastOpenDocId } = await readStorage(other);
    const main = documents.find((d) => d.id === lastOpenDocId)!;
    const bundled = documents.find((d) => d.source === CLASSES);
    expect(main.source).toBe(IMPORTER);
    expect(main.group).toBeDefined();
    expect(bundled).toMatchObject({ title: 'Shared classes', fileName: 'classes.sgl', group: main.group });
    expect(documents.filter((d) => d.group === main.group)).toHaveLength(2);

    await openList(other);
    // Listed like any other document (DD-08 §15.4): the two from the link
    // beside the recipient's own three.
    await expect(items(other)).toHaveCount(5);
    for (const title of ['Importer', 'Shared classes', 'Mine']) await expect(items(other).locator('.docs-title', { hasText: new RegExp(`^${title}$`) })).toHaveCount(1);
    await other.keyboard.press('Escape');

    // The recipient's own document still imports their own `classes` (I30).
    await switchTo(other, 'Mine');
    await waitForExactNodeCount(other, 1);
    await expect.poll(() => shapeOf(other, 'mine')).toBe('ellipse');

    // I27: the received document now also imports "Mine" (first, so the
    // bundled `classes` after it still wins, I13), and Mine finds the
    // recipient's own `classes`. One name, two documents: Share carries the
    // first it reached and says so.
    await switchTo(other, 'Importer');
    await setSource(other, IMPORTER.replace('["./shared/classes.sgl"]', '["./Mine.sgl", "./shared/classes.sgl"]'));
    // Mine's node is not imported (SGL2026); the later import's Service replaces Mine's (SGL2023).
    await expect.poll(async () => (await diagnosticCodes(other)).sort()).toEqual(['SGL2023', 'SGL2026']);
    await expect.poll(() => shapeOf(other, 'api')).toBe('hexagon');
    await other.locator('.share-open').click();
    await expect(other.locator('.share-note')).toContainText('with the 2 documents it imports');
    await expect(other.locator('.share-differ')).toHaveText(
      'The import “classes” led to more than one of your documents. The link carries the first, so the recipient’s copy of it will differ.',
    );
    const resent = JSON.parse(inflateRawSync(Buffer.from(new URLSearchParams(new URL(await other.locator('.share-link').inputValue()).hash.slice(1)).get('i')!, 'base64url')).toString('utf8')) as {
      d: { n: string; s: string }[];
    };
    expect(resent.d.map((d) => [d.n, d.s])).toEqual([
      ['mine', '@title: "Mine"\n@imports: ["./classes.sgl"]\nmine: Service\n'],
      ['classes', CLASSES],
    ]);
  } finally {
    await fresh.close();
  }
});

test('the long-link guard counts the imported documents: a short document with a large import warns, and says the file holds this document only', async ({ page }) => {
  // About 8 KB of text that does not compress: hex from a fixed LCG.
  let x = 12345;
  const noise = Array.from({ length: 16_000 }, () => ((x = (x * 1103515245 + 12345) % 2 ** 31), (x >> 16) & 15).toString(16)).join('');
  const big = `@classes: { Big: { @shape: diamond } }\n// ${noise}\n`;
  await withStored(page, [['big.sgl', big]]);
  const importer = '@imports: ["./big.sgl"]\nn: Big\n';
  await newDocument(page, importer);
  await waitForExactNodeCount(page, 1);
  await expect.poll(() => shapeOf(page, 'n')).toBe('diamond');

  await page.locator('.share-open').click();
  const link = await page.locator('.share-link').inputValue();
  expect(link.length).toBeGreaterThan(8000);
  expect(link.slice(0, link.indexOf('&i=')).length).toBeLessThan(200); // the document alone is short
  await expect(page.locator('.share-warning')).toContainText('cut long links short');
  await expect(page.locator('.share-warning')).toContainText('The file holds this document only, without the documents it imports.');
});
