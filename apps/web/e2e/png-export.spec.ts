import { expect, test, type Page } from '@playwright/test';
import { BUILT_IN, resolveTheme } from '@sgl/theme';
import { openFile, pngPixel, pngSize, renderedSvg, saveAs, savePng, toastMessages, waitForExactNodeCount, waitForTheme } from './helpers.js';

/**
 * D6 and D7 (DD-08 §7): Save ▾ → PNG image at 1×, 2× or 3×, and Copy SVG /
 * Copy PNG, against the production build. The mechanism's own checks (the
 * text is really Inter, pixel for pixel) are `test/png.browser.test.ts`;
 * these hold the app to it: the menu, the file, the theme's background, the
 * clipboard, the refusals. Offline and CSP cases are in `offline.spec.ts`
 * and `csp.spec.ts`.
 */

const DOC = 'a: "Alpha label"\nb: "Beta label"\na -> b: "an edge"\n';

function canvasColour(themeId: string): string {
  const theme = resolveTheme(BUILT_IN[themeId]!, (id) => BUILT_IN[id]);
  return theme.value.canvas.background.toUpperCase();
}

async function svgPixelSize(page: Page): Promise<{ readonly width: number; readonly height: number }> {
  const svg = renderedSvg(page);
  return { width: Number(await svg.getAttribute('width')), height: Number(await svg.getAttribute('height')) };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openFile(page, 'a.sgl', DOC);
  await waitForExactNodeCount(page, 2);
});

test('Save ▾ offers PNG at 1×, 2× and 3×, 2× by default, as a plain radio group', async ({ page }) => {
  await page.locator('.save-menu > summary').click();
  const group = page.locator('.save-menu .png-scale');
  await expect(group.getByRole('radio')).toHaveCount(3);
  await expect(group.getByLabel('2×')).toBeChecked();
  await expect(page.locator('.save-menu').getByRole('group', { name: 'PNG scale' })).toBeVisible();
  // Save ▾ stays a disclosure of plain controls: no menu roles.
  await expect(page.locator('.save-menu [role^="menu"]')).toHaveCount(0);
  for (const cls of ['save-png', 'copy-svg', 'copy-png']) await expect(page.locator(`.save-menu .${cls}`)).toBeVisible();
});

test('PNG is {title}.png at the SVG’s size × the chosen scale', async ({ page }) => {
  const size = await svgPixelSize(page);
  for (const scale of [1, 2, 3] as const) {
    const saved = await savePng(page, scale);
    expect(saved.name).toBe('a.png');
    expect(pngSize(saved.bytes)).toEqual({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
  }
  // The default, untouched, is 2×.
  await page.reload();
  await waitForExactNodeCount(page, 2);
  expect(pngSize((await savePng(page)).bytes)).toEqual({ width: Math.round(size.width * 2), height: Math.round(size.height * 2) });
});

test('the PNG’s background is the theme’s canvas colour, light and dark', async ({ page }) => {
  const light = await savePng(page, 1);
  expect(await pngPixel(page, light.bytes, 1, 1)).toEqual({ hex: canvasColour('neutral-light'), alpha: 255 });

  await page.locator('.theme-picker select').selectOption('neutral-dark');
  await waitForTheme(page, 'neutral-dark');
  const dark = await savePng(page, 1);
  expect(await pngPixel(page, dark.bytes, 1, 1)).toEqual({ hex: canvasColour('neutral-dark'), alpha: 255 });
  expect(canvasColour('neutral-dark')).not.toBe(canvasColour('neutral-light'));
});

test('the PNG’s text is drawn with the embedded font, not a fallback', async ({ page }) => {
  const saved = await savePng(page, 2);
  // `lastGood.svg` itself (Save ▾ SVG without the faces it embeds, D2).
  const svg = (await saveAs(page, 'svg')).text.replace(/@font-face\{[^}]*\}\n/g, '');
  expect(svg).not.toContain('@font-face');
  // The same SVG rasterised the naive way, as an <img> with no font of its
  // own: the isolated image document cannot see the page's Inter, so it
  // falls back. The exported PNG must not be that picture.
  const differs = await page.evaluate(
    async ({ svg, b64 }) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const img = new Image();
      img.src = url;
      await img.decode();
      const bin = atob(b64);
      const data = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      const exported = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      const draw = (src: CanvasImageSource): Uint8ClampedArray => {
        const c = new OffscreenCanvas(exported.width, exported.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(src, 0, 0, exported.width, exported.height);
        return ctx.getImageData(0, 0, exported.width, exported.height).data;
      };
      const a = draw(exported);
      const b = draw(img);
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 64) n += 1;
      URL.revokeObjectURL(url);
      return n;
    },
    { svg, b64: saved.bytes.toString('base64') },
  );
  expect(differs).toBeGreaterThan(50);
});

test('an italic label’s PNG is drawn in Inter Italic, as the face’s own metrics say (DD-11 T60)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the probe’s tolerance is measured in Chromium');
  const LABEL = 'Hamburgefontsiv WAVE 0123';
  // The rasterisation-only copy itself (fix round 1, item 2): every SVG the
  // rasteriser hands an <img> passes through URL.createObjectURL.
  await page.evaluate(() => {
    const copies: Promise<string>[] = [];
    (window as unknown as { __svgCopies: Promise<string>[] }).__svgCopies = copies;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource): string => {
      if (obj instanceof Blob && obj.type === 'image/svg+xml') copies.push(obj.text());
      return create(obj);
    };
  });
  await openFile(page, 'italic.sgl', `a: "*${LABEL}*"\n`);
  await waitForExactNodeCount(page, 1);
  // This document's own picture, drawn in the real italic. Measured in the
  // drawn tree itself (the canvas's zoom changes hinting, so an outside
  // reference does not compare): the run's advance equals a clone of it set
  // in Inter Italic 500 loaded independently under a probe name, to 0.05 px,
  // and differs from a clone set upright, which is what a synthetic oblique of
  // the upright face would measure. (Canvas measureText rounds to whole px
  // here, 181 against 180: too coarse to tell the two apart.)
  const advances = (): Promise<{ drawn: number; italic: number; upright: number } | null> =>
    page.evaluate(async () => {
      const run = document.querySelector<SVGTextContentElement>('.canvas-host g.rendered[data-origin="live"] g[id="n-a"] tspan.r-em');
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/inter-latin-500-italic-[^/]*\.woff2$/.test(n));
      if (run === null || url === undefined) return null;
      const w = window as unknown as { __probeFace?: boolean };
      if (!w.__probeFace) {
        const face = new FontFace('ProbeItalic', `url(${url})`, { style: 'italic', weight: '500' });
        document.fonts.add(await face.load());
        w.__probeFace = true;
      }
      const text = run.closest('text')!;
      const clone = (style: string): number => {
        const c = text.cloneNode(true) as SVGTextElement;
        c.querySelector('tspan.r-em')!.setAttribute('style', style);
        text.parentNode!.append(c);
        const length = c.querySelector<SVGTextContentElement>('tspan.r-em')!.getComputedTextLength();
        c.remove();
        return length;
      };
      return { drawn: run.getComputedTextLength(), italic: clone("font-family: 'ProbeItalic'; font-style: italic; font-weight: 500"), upright: clone('font-style: normal') };
    });
  await expect
    .poll(async () => {
      const a = await advances();
      return a === null ? Infinity : Math.abs(a.drawn - a.italic);
    })
    .toBeLessThanOrEqual(0.05);
  const measured = (await advances())!;
  expect(Math.abs(measured.italic - measured.upright), JSON.stringify(measured)).toBeGreaterThan(0.5);
  // …and this label's own layout has landed, not the last document's frames
  // (a wait, not a font check): the node holds the whole run.
  await expect
    .poll(() => renderedSvg(page).locator('g[id="n-a"] > path.n-shape').evaluate((p) => (p as SVGGraphicsElement).getBBox().width))
    .toBeGreaterThan(measured.drawn);
  const saved = await savePng(page, 2);
  // The copy the PNG was drawn from embeds exactly Inter Italic 500 (T50), no other face.
  const copies = await page.evaluate(() => Promise.all((window as unknown as { __svgCopies: Promise<string>[] }).__svgCopies));
  expect(copies).toHaveLength(1);
  expect([...copies[0]!.matchAll(/@font-face\{font-family:&apos;([^&]*)&apos;;font-style:(\w+);font-weight:(\d+)/g)].map((m) => m.slice(1).join(' '))).toEqual(['Inter italic 500']);
  const probe = await page.evaluate(
    async ({ b64, label }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let left = Infinity;
      let right = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (data[(y * c.width + x) * 4]! < 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
      }
      const extent = async (font: string): Promise<number> => {
        await document.fonts.load(font);
        const m = new OffscreenCanvas(1, 1).getContext('2d')!;
        m.font = font;
        const t = m.measureText(label);
        return t.actualBoundingBoxLeft + t.actualBoundingBoxRight;
      };
      return { ink: (right - left + 1) / 2, italic: await extent('italic 500 13px Inter') };
    },
    { b64: saved.bytes.toString('base64'), label: LABEL },
  );
  expect(Math.abs(probe.ink - probe.italic), JSON.stringify(probe)).toBeLessThanOrEqual(1);
  // The face it embeds for the rasterisation is Inter Italic 500 alone (T50): the
  // same selection Save ▾ SVG makes.
  const svg = (await saveAs(page, 'svg')).text;
  expect([...svg.matchAll(/@font-face\{font-family:&apos;([^&]*)&apos;;font-style:(\w+);font-weight:(\d+)/g)].map((m) => m.slice(1).join(' '))).toEqual(['Inter italic 500']);
});

test.describe('clipboard', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Copy SVG puts what Save ▾ SVG saves on the clipboard as text', async ({ page }) => {
    const svg = (await saveAs(page, 'svg')).text;
    await page.locator('.save-menu > summary').click();
    await page.locator('.save-menu .copy-svg').click();
    await expect(toastMessages(page)).toContainText(['SVG copied']);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(svg);
  });

  test('Copy PNG puts an image/png at 2× on the clipboard', async ({ page }) => {
    const size = await svgPixelSize(page);
    await page.locator('.save-menu > summary').click();
    // Copy is at the default scale, whatever the Save scale is set to.
    await page.locator('.save-menu .png-scale').getByLabel('1×').check();
    await page.locator('.save-menu .copy-png').click();
    await expect(toastMessages(page)).toContainText(['PNG copied']);
    const read = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items[0]!;
      const blob = await item.getType('image/png');
      const bitmap = await createImageBitmap(blob);
      return { types: item.types, width: bitmap.width, height: bitmap.height };
    });
    expect(read.types).toContain('image/png');
    expect({ width: read.width, height: read.height }).toEqual({ width: Math.round(size.width * 2), height: Math.round(size.height * 2) });
  });

  test('a refused clipboard says so, for both', async ({ page }) => {
    await page.evaluate(() => {
      const refuse = (): Promise<never> => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
      Object.defineProperty(navigator.clipboard, 'write', { value: refuse });
      Object.defineProperty(navigator.clipboard, 'writeText', { value: refuse });
    });
    await page.locator('.save-menu > summary').click();
    await page.locator('.save-menu .copy-svg').click();
    await expect(page.locator('.toast-error .toast-message')).toContainText(['Could not copy the SVG']);
    await page.locator('.save-menu > summary').click();
    await page.locator('.save-menu .copy-png').click();
    await expect(page.locator('.toast-error .toast-message')).toContainText(['Could not copy the SVG', 'Could not copy the PNG']);
  });
});

test.describe('the pixel cap', () => {
  test('a side over 16 384 px is refused with a toast, and a smaller scale still saves', async ({ page }) => {
    await openFile(page, 'wide.sgl', 'wide: { @size: { width: 6000, height: 40 } }\n');
    await waitForExactNodeCount(page, 1);
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.locator('.save-menu > summary').click();
    await page.locator('.save-menu .png-scale').getByLabel('3×').check();
    await page.locator('.save-menu .save-png').click();
    await expect(page.locator('.toast-error .toast-message')).toContainText([/too large for a PNG at 3×.*16,384/]);
    expect(downloads).toEqual([]);
    const saved = await savePng(page, 2);
    expect(pngSize(saved.bytes).width).toBe(Math.round((await svgPixelSize(page)).width * 2));
  });

  test('over 64 Mpx in all is refused, for Copy PNG too', async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFile(page, 'big.sgl', 'big: { @size: { width: 5000, height: 5000 } }\n');
    await waitForExactNodeCount(page, 1);
    await page.locator('.save-menu > summary').click();
    await page.locator('.save-menu .copy-png').click();
    await expect(page.locator('.toast-error .toast-message')).toContainText([/too large for a PNG at 2×.*Try 1×/]);
  });
});
