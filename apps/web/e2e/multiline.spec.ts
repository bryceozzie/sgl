import { expect, test, type Page } from '@playwright/test';
import {
  diagnosticCodes,
  editorText,
  EXAMPLE_NODE_COUNT,
  renderedSvg,
  setSource,
  sourceDiagnostics,
  waitForExactNodeCount,
  waitForNodeCount,
} from './helpers.js';

/**
 * A18 branch 1 (DD-11 T15–T19, T60): `"""` strings in the app's editor. The
 * editor runs the same Lezer grammar as the pipeline, so what it highlights
 * as one string is what the pipeline decodes as one label.
 */

/** The computed colour of the first CodeMirror text span whose text contains `text`. */
async function colourOf(page: Page, text: string): Promise<string> {
  return page.locator('.cm-content span', { hasText: text }).last().evaluate((el) => getComputedStyle(el).color);
}

const BLOCK = [
  '// a real comment',
  'a: { @label: "plain" }',
  'b: {',
  '  @label: """',
  '    // not a comment',
  '    {not a block} "quoted"',
  '    """',
  '}',
  'a -> b',
  '',
].join('\n');

test('a `"""` block is highlighted as one string, and draws its dedented lines', async ({ page }) => {
  expect(sourceDiagnostics(BLOCK)).toEqual([]);
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, BLOCK);
  await waitForExactNodeCount(page, 2);
  await expect.poll(() => diagnosticCodes(page)).toEqual([]);

  const string = await colourOf(page, '"plain"');
  const comment = await colourOf(page, '// a real comment');
  expect(string).not.toBe(comment);
  // `//`, `{` and `"` inside the block are string text, coloured as a string.
  expect(await colourOf(page, '// not a comment')).toBe(string);
  expect(await colourOf(page, '{not a block}')).toBe(string);

  const labels = await renderedSvg(page).evaluate((svg) => [...svg.querySelectorAll('text')].map((t) => [...t.querySelectorAll('tspan')].map((s) => s.textContent)));
  expect(labels).toContainEqual(['// not a comment', '{not a block} "quoted"']);
});

test('typing `"""` closes it, so the rest of the document still parses', async ({ page }) => {
  const start = 'a: {\n  @label: "A"\n}\nb\na -> b\n';
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, start);
  await waitForExactNodeCount(page, 2);

  // Replace `"A"` by typing, one key at a time, as a person would.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
  await page.keyboard.type('"""');
  // closeBrackets finished the triple quote: nothing after it became string.
  expect(await editorText(page)).toBe('a: {\n  @label: """"""\n}\nb\na -> b\n');
  await page.keyboard.type('Line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line two');

  // Enter indents the new line (however deep is the editor's business);
  // dedent removes it again.
  const typed = await editorText(page);
  expect(typed).toMatch(/^a: \{\n {2}@label: """Line one\n[ \t]*Line two"""\n\}\nb\na -> b\n$/);
  expect(sourceDiagnostics(typed)).toEqual([]);
  await expect.poll(() => diagnosticCodes(page)).toEqual([]);
  await waitForExactNodeCount(page, 2);
  await expect
    .poll(() => renderedSvg(page).evaluate((svg) => [...svg.querySelectorAll('text tspan')].map((s) => s.textContent)))
    .toEqual(expect.arrayContaining(['Line one', 'Line two']));
});

test('an unterminated `"""` is one SGL1003, keeps the last picture, and recovers when closed', async ({ page }) => {
  const good = 'a: { @label: "A" }\nb\na -> b\n';
  const open = 'a: { @label: """A\n}\nb\na -> b\n';
  expect(sourceDiagnostics(open).map((d) => [d.code, d.span.from, d.span.to])).toEqual([['SGL1003', 13, open.length]]);

  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  await setSource(page, good);
  await waitForExactNodeCount(page, 2);
  const before = await renderedSvg(page).innerHTML();

  // A bulk insert (a paste) does not engage closeBrackets.
  await setSource(page, open);
  await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL1003']);
  expect(await renderedSvg(page).innerHTML()).toBe(before);

  const closed = 'a: { @label: """A""" }\nb\na -> b\n';
  await setSource(page, closed);
  await expect.poll(() => diagnosticCodes(page)).toEqual([]);
  await waitForExactNodeCount(page, 2);
});
