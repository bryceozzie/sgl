import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, waitForNodeCount } from './helpers.js';

/** F13: DD-08 §11's toasts are capped on screen. At most three show — the
 *  newest — and the rest wait behind a "N more" line that can close them
 *  all; an error toast still stays until it is closed. */

const errors = (page: Page) => page.locator('.toast-region-error[role="alert"] .toast');
const more = (page: Page) => page.locator('.toast-more');

/** An invalid share link pasted into the open tab: one error toast each
 *  (DD-08 §8). The hash is cleared after each, so the same link repeats. */
async function pasteInvalidLink(page: Page, expected: number): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#s=this*is*not*base64url';
  });
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  await expect(page.locator('.toast-error')).toHaveCount(Math.min(expected, 3));
}

test('five error toasts: three show, two wait behind "2 more", and come back as shown ones close', async ({ page }) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);
  for (const n of [1, 2, 3, 4, 5]) await pasteInvalidLink(page, n);

  await expect(errors(page)).toHaveCount(3);
  // The count is announced politely, outside the alert region.
  await expect(more(page)).toHaveText(/^2 more/);
  expect(await more(page).evaluate((el) => el.closest('[role="status"]') !== null && el.closest('[role="alert"]') === null)).toBe(true);

  // Closing a shown error brings a held one back: nothing was dropped.
  await errors(page).first().locator('.toast-dismiss').click();
  await expect(errors(page)).toHaveCount(3);
  await expect(more(page)).toHaveText(/^1 more/);
  await errors(page).first().locator('.toast-dismiss').click();
  await expect(errors(page)).toHaveCount(3);
  await expect(more(page)).toHaveCount(0);

  // Close all.
  await pasteInvalidLink(page, 4);
  await expect(more(page)).toHaveText(/^1 more/);
  await more(page).getByRole('button', { name: 'Dismiss all' }).click();
  await expect(page.locator('.toasts .toast')).toHaveCount(0);
  await expect(more(page)).toHaveCount(0);
});
