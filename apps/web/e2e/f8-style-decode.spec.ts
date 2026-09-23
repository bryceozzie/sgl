import { expect, test } from '@playwright/test';
import { EXAMPLE_NODE_COUNT, renderedSvg, waitForNodeCount } from './helpers.js';

/**
 * F8 (execution plan §2.1): `<style>` content is XML-escaped by `render()` —
 * every golden carries `&apos;Segoe UI&apos;` in the font stack (the theme's
 * `font.sans` token: `Inter, system-ui, -apple-system, 'Segoe UI', Roboto,
 * sans-serif`). Verified correct for a standalone `.svg` by the injection
 * suite; unverified for DD-08 §6's live `innerHTML` path until now — this is
 * that verification, in a real browser.
 *
 * If entities did not decode inside the `innerHTML`'d `<g>`, the computed
 * `font-family` would contain the literal text `&apos;Segoe UI&apos;`
 * (unparsed) instead of the quoted family name, and every multi-word font in
 * the stack would silently degrade to whatever comes after it.
 */
test('F8: the innerHTML-inserted <style> decodes &apos; — computed font-family is the real multi-word stack', async ({
  page,
}) => {
  await page.goto('/');
  await waitForNodeCount(page, EXAMPLE_NODE_COUNT);

  const svg = renderedSvg(page);

  // `style` is not in HTML's foreign-content breakout list (F8's reading), so
  // inside an SVG-namespaced `<g>` it parses under ordinary element-content
  // rules — entities decode — rather than as HTML's RAWTEXT `<style>`, which
  // would leave `&apos;` literal (RAWTEXT content is never entity-decoded).
  // `.textContent` on the already-parsed node is the direct DOM-level readout
  // of *which* parsing mode actually happened: literal `&apos;` proves
  // RAWTEXT (the failure mode); a real apostrophe proves the SVG reading.
  const styleText = await svg.locator('style').textContent();
  expect(styleText).not.toContain('&apos;');
  expect(styleText).toContain("'Segoe UI'");

  // And the practical consequence DD-08 §6 cares about: the rule actually
  // took effect, so the computed style is the real multi-word stack, not a
  // CSS parse failure falling through to nothing.
  const computedFamily = await svg.locator('text.n-title, text.c-title').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(computedFamily).not.toContain('&apos;');
  expect(computedFamily.toLowerCase()).toContain('segoe ui');
});
