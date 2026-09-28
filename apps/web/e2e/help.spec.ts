import { expect, test, type Page } from '@playwright/test';
import { compileHelpDir } from '../build/help-plugin.js';
import { diagnosticCodes, editorText, EXAMPLE_NODE_COUNT, EXAMPLE_SOURCE, readStorage, setSource, toastMessages, waitForExactNodeCount, waitForTheme } from './helpers.js';

/**
 * DD-13 §6 and §12's e2e 1–5 (help branch 4): the Help drawer, from the
 * toolbar's Help button, a diagnostics row's Help (HD3) and a first visit
 * (HD6). Every other spec starts as a returning visitor (the config seeds
 * `sgl-help-shown`); the first-visit cases here start without it.
 */

const content = compileHelpDir();
const exampleOf = (entryId: string, n = 1): string => {
  const entry = content.entries.find((e) => e.id === entryId)!;
  const examples = entry.blocks.flatMap((b) => (b.type === 'example' && b.example.mode === 'example' ? [b.example] : []));
  return examples[n - 1]!.source;
};

const drawer = (page: Page) => page.locator('aside#help-drawer');
const helpButton = (page: Page) => page.getByRole('button', { name: 'Help', exact: true });
const search = (page: Page) => drawer(page).getByRole('searchbox', { name: 'Search help' });
const entryTitle = (page: Page) => drawer(page).locator('.help-entry-title');
const activeClass = (page: Page) => page.evaluate(() => document.activeElement?.className ?? '');
const focusInDrawer = (page: Page) => page.evaluate(() => document.getElementById('help-drawer')?.contains(document.activeElement) ?? false);

async function openPin(page: Page): Promise<void> {
  await helpButton(page).click();
  await search(page).fill('@pin');
  await expect(drawer(page).locator('.help-result').first()).toHaveAttribute('data-id', 'key/pin');
  await search(page).press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(entryTitle(page)).toHaveText('@pin');
}

test.describe('returning visitor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
  });

  test('e2e 1: Help opens the drawer (an aside labelled "Help", not a dialog) with focus in search; Escape closes it and focus is back on Help', async ({ page }) => {
    await expect(drawer(page)).toHaveCount(0);
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(helpButton(page)).toHaveAttribute('aria-controls', 'help-drawer');
    await helpButton(page).click();
    await expect(page.getByRole('complementary', { name: 'Help' })).toBeVisible();
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[role="dialog"], [aria-modal="true"]')).toHaveCount(0);
    await expect(search(page)).toBeFocused();
    // The home: the categories, the quick start first and open.
    await expect(drawer(page).locator('.help-home summary')).toHaveText(['Quick start', 'Language topics', '@ keys', 'Style properties', 'Shapes', 'Layout engines', 'Themes and tokens', 'Diagnostics'].filter((t) => t !== 'Language topics' || content.entries.some((e) => e.kind === 'topic' && e.id !== 'topic/quickstart')));
    await expect(drawer(page).locator('.help-home details').first()).toHaveAttribute('open', '');

    // Escape in a non-empty search box clears it; the drawer stays.
    await search(page).fill('pin');
    await search(page).press('Escape');
    await expect(search(page)).toHaveValue('');
    await expect(drawer(page)).toBeVisible();
    // Escape again closes it, and focus returns to Help.
    await search(page).press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    await expect(helpButton(page)).toBeFocused();
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'false');

    // × closes it too; so does the Help button, a toggle.
    await helpButton(page).click();
    await drawer(page).getByRole('button', { name: 'Close help' }).click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(helpButton(page)).toBeFocused();
    await helpButton(page).click();
    await expect(drawer(page)).toBeVisible();
    await helpButton(page).click();
    await expect(drawer(page)).toHaveCount(0);
  });

  test('P36/P37: search `@pin`, Down and Enter open @pin; its heading takes focus and the facts panel says what it is; ← goes back to the results', async ({ page }) => {
    await helpButton(page).click();
    await search(page).fill('@pin');
    await expect(drawer(page).locator('.help-count')).toHaveText(/^\d+ results?$/);
    await expect(drawer(page).locator('.help-result').first()).toHaveAttribute('data-id', 'key/pin');
    await search(page).press('ArrowDown');
    await expect(drawer(page).locator('.help-result').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(drawer(page).locator('.help-result').first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(search(page)).toBeFocused();
    await search(page).press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(entryTitle(page)).toHaveText('@pin');
    await expect(entryTitle(page)).toBeFocused();
    const facts = drawer(page).locator('.help-facts');
    await expect(facts).toContainText('Written as@pin');
    await expect(facts).toContainText('Applies tonodes and containers');
    await expect(facts).toContainText('SGL4020');

    // A link to another entry is followed in the drawer.
    await drawer(page).locator('.help-facts a', { hasText: 'SGL4020' }).click();
    await expect(entryTitle(page)).toHaveText('SGL4020');
    await drawer(page).getByRole('button', { name: /Back/ }).click();
    await expect(entryTitle(page)).toHaveText('@pin');
    await drawer(page).getByRole('button', { name: /Results/ }).click();
    await expect(search(page)).toHaveValue('@pin');
    await expect(drawer(page).locator('.help-result[data-id="key/pin"]')).toBeFocused();

    // No results: said so, as a status.
    await search(page).fill('zzqqxx');
    await expect(drawer(page).locator('.help-count[role="status"]')).toHaveText('No results for “zzqqxx”');
  });

  test('e2e 4: an example\'s preview renders an SVG through the pipeline, captioned with its engine and theme; a theme switch renders it again in the new theme', async ({ page }) => {
    await openPin(page);
    const first = drawer(page).locator('.help-example').first();
    await expect(first.locator('.help-preview[data-state="rendered"] svg')).toHaveCount(1, { timeout: 20_000 });
    await expect(first.locator('.help-preview svg g.n')).toHaveCount(3);
    await expect(first.locator('figcaption')).toHaveText('Three pinned nodes · fixed · neutral-light');
    // The expected warning is labelled so (`A node without a pin`, SGL4020).
    const third = drawer(page).locator('.help-example').nth(2);
    await third.scrollIntoViewIfNeeded();
    await expect(third.locator('figcaption')).toHaveText('A node without a pin · fixed · neutral-light · 1 diagnostic (expected)', { timeout: 20_000 });

    // The editor's own document is untouched: no diagnostics, same text.
    expect(await diagnosticCodes(page)).toEqual([]);
    expect(await editorText(page)).toBe(EXAMPLE_SOURCE);

    const light = await first.locator('.help-preview svg').evaluate((svg) => svg.outerHTML);
    await page.locator('.theme-picker select').selectOption('neutral-dark');
    await waitForTheme(page, 'neutral-dark');
    await expect(first.locator('figcaption')).toHaveText('Three pinned nodes · fixed · neutral-dark', { timeout: 20_000 });
    await expect(first.locator('.help-preview[data-state="rendered"] svg')).toHaveCount(1);
    const dark = await first.locator('.help-preview svg').evaluate((svg) => svg.outerHTML);
    expect(dark).not.toBe(light);
    // The same geometry, another paint: only the style differs.
    expect(dark.replace(/<style>[\s\S]*<\/style>/, '')).toBe(light.replace(/<style>[\s\S]*<\/style>/, ''));
  });

  test('P39: with the drawer open and previews rendering, typing in the editor keeps focus and text, and a click in the editor does not close the drawer', async ({ page }) => {
    await openPin(page);
    await page.locator('.cm-content').click();
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('typed: "while help renders"\n');
    await expect(drawer(page).locator('.help-preview[data-state="rendered"]').first()).toBeVisible({ timeout: 20_000 });
    await page.keyboard.insertText('more\n');
    expect(await activeClass(page)).toContain('cm-content');
    expect(await editorText(page)).toBe(`${EXAMPLE_SOURCE}typed: "while help renders"\nmore\n`);
  });

  test('P34: the drawer is a third column; the editor keeps its size and the canvas narrows', async ({ page }) => {
    const editorBefore = await page.locator('.editor-host').boundingBox();
    const canvasBefore = await page.locator('.canvas-host').boundingBox();
    await helpButton(page).click();
    await expect(drawer(page)).toBeVisible();
    const editorAfter = await page.locator('.editor-host').boundingBox();
    const canvasAfter = await page.locator('.canvas-host').boundingBox();
    const aside = await drawer(page).boundingBox();
    expect(editorAfter).toEqual(editorBefore);
    expect(canvasAfter!.width).toBeLessThan(canvasBefore!.width - 300);
    expect(Math.round(aside!.width)).toBe(380);
    expect(aside!.x).toBeGreaterThanOrEqual(canvasAfter!.x + canvasAfter!.width);
  });

  test('e2e 5: Open as new document makes a document with exactly the example\'s text; the toast shows; the previous one is unchanged; the drawer stays open', async ({ page }) => {
    await openPin(page);
    const before = await readStorage(page);
    await drawer(page).locator('.help-example').first().getByRole('button', { name: 'Open as new document' }).click();
    const source = exampleOf('key/pin');
    await expect.poll(() => editorText(page)).toBe(source);
    await expect(toastMessages(page)).toContainText(['Opened the example as a new document. Your previous document is in Documents.']);
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).locator('.help-example').first().getByRole('button', { name: 'Open as new document' })).toBeFocused();
    await expect.poll(async () => (await readStorage(page)).documents.length).toBe(before.documents.length + 1);
    const after = await readStorage(page);
    const created = after.documents.find((d) => !before.documents.some((b) => b.id === d.id))!;
    expect(created.source).toBe(source);
    expect(created.engineId).toBe('sgl.fixed');
    expect(after.lastOpenDocId).toBe(created.id);
    const previous = after.documents.find((d) => d.id === before.lastOpenDocId)!;
    expect(previous.source).toBe(EXAMPLE_SOURCE);
    await waitForExactNodeCount(page, 3);
    await page.locator('.docs-menu > summary').click();
    await expect(page.locator('.docs-menu .docs-item')).toHaveCount(2);
  });

  test('HD2: Copy puts the example\'s text on the clipboard, with a toast', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPin(page);
    await drawer(page).locator('.help-example').first().getByRole('button', { name: 'Copy' }).click();
    await expect(toastMessages(page)).toContainText(['Example copied.']);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(exampleOf('key/pin'));
    // There is no Insert (HD2).
    await expect(drawer(page).getByRole('button', { name: /insert/i })).toHaveCount(0);
  });

  test('HD3: a diagnostics row\'s Help opens the drawer at that code, focus on its heading; the code\'s entry points at the prose that explains it', async ({ page }) => {
    await setSource(page, 'a: { @nope: 1 }\n');
    await expect.poll(() => diagnosticCodes(page)).toEqual(['SGL2010']);
    const row = page.locator('.diagnostics-panel .diag').first();
    await row.getByRole('button', { name: 'Help for SGL2010' }).click();
    await expect(entryTitle(page)).toHaveText('SGL2010');
    await expect(entryTitle(page)).toBeFocused();
    await expect(drawer(page).locator('.help-facts')).toContainText('Severitywarning');
    // No diag prose yet (help branch 3): the entries whose Diagnostics: line
    // names the code are linked.
    const explained = content.entries.filter((e) => e.diagnostics.includes('SGL2010'));
    if (content.entries.some((e) => e.id === 'diag/SGL2010')) {
      await expect(drawer(page).locator('.help-summary')).toBeVisible();
    } else if (explained.length > 0) {
      await expect(drawer(page).locator('.help-explained a')).toHaveText(explained.map((e) => e.title));
    }
    // The row's own click (scroll the editor to the span) did not also run:
    // focus stayed in help.
    expect(await focusInDrawer(page)).toBe(true);
    // HD5: no keyboard shortcut opens help.
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    for (const key of ['F1', 'Alt+Shift+H', 'Control+/', '?']) {
      await page.locator('.cm-content').press(key);
      await expect(drawer(page)).toHaveCount(0);
    }
  });

  test('a help chunk that cannot be loaded toasts, as the other lazy chunks do; the drawer stays closed and the app keeps working', async ({ page }) => {
    await page.route(/\/assets\/help-[\w-]{8}\.js$/, (route) => route.abort());
    await helpButton(page).click();
    await expect(toastMessages(page)).toContainText(["Part of SGL couldn't be loaded. If you are offline, save your work (Save ▾) and reload when online."]);
    await expect(drawer(page)).toHaveCount(0);
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'false');
    await setSource(page, 'x\ny\nx -> y\n');
    await waitForExactNodeCount(page, 2);
  });

  test('the help-content chunk failing toasts too, and the drawer says so', async ({ page }) => {
    await page.route(/\/assets\/help-content-[\w-]{8}\.js$/, (route) => route.abort());
    await helpButton(page).click();
    await expect(toastMessages(page)).toContainText(["Part of SGL couldn't be loaded. If you are offline, save your work (Save ▾) and reload when online."]);
    await expect(drawer(page).locator('.help-loading')).toHaveText("Help couldn't be loaded. Close it and try again.");
  });
});

test.describe('first visit (HD6)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('opens the drawer at the quick start without moving focus; typing in the editor goes on; a reload does not open it again', async ({ page }) => {
    await page.goto('/');
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect(entryTitle(page)).toHaveText('Quick start');
    expect(await focusInDrawer(page)).toBe(false);
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'true');

    // Focus is the editor's once the user puts it there, and stays there
    // while the quick start's previews render.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('first: "visit"\n');
    await expect(drawer(page).locator('.help-preview[data-state="rendered"]').first()).toBeVisible({ timeout: 20_000 });
    expect(await activeClass(page)).toContain('cm-content');
    expect(await focusInDrawer(page)).toBe(false);
    expect(await editorText(page)).toBe(`${EXAMPLE_SOURCE}first: "visit"\n`);
    expect(await page.evaluate(() => localStorage.getItem('sgl-help-shown'))).toBe('1');

    await page.reload();
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT + 1);
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(drawer(page)).toHaveCount(0);
  });

  test('with localStorage refused, a first visit still opens help and nothing breaks', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
    });
    await page.goto('/');
    await waitForExactNodeCount(page, EXAMPLE_NODE_COUNT);
    await expect(entryTitle(page)).toHaveText('Quick start');
  });
});
