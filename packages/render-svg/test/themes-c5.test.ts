import { BUILT_IN, neutralLight, resolveTheme, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { listCorpusDocs, renderCorpusDoc, type RenderedDoc } from './pipeline.js';

/**
 * C5 (DD-04 §7): the `high-contrast` and `print` themes, judged on what the
 * renderer actually paints — the rules of the rendered `<style>`, attached to
 * the elements that carry their classes — over the whole corpus, not on a
 * hand-picked list of token pairs.
 */

const highContrast = BUILT_IN['high-contrast'] as ThemeDoc;
const print = BUILT_IN['print'] as ThemeDoc;

// ---------------------------------------------------------------------------
// Reading the rendered paint
// ---------------------------------------------------------------------------

type Rules = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** `.name{prop:value;…}` lines of a style block → name → prop → value.
 *  Rules with a selector list (the fixed structural ones) are skipped. */
function parseRules(styleBlock: string): Rules {
  const out = new Map<string, Map<string, string>>();
  for (const m of styleBlock.matchAll(/^\.([\w-]+)\{([^}]*)\}$/gm)) {
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i), d.slice(i + 1));
    }
    out.set(m[1]!, decls);
  }
  return out;
}

/** The value of `prop` for an element with class list `classes`, from the
 *  paint rules (`s-`/`t-`/`p-`/`mf-`/`ms-`) its classes name. */
function paintOf(rules: Rules, classes: string, prop: string): string | undefined {
  let value: string | undefined;
  for (const c of classes.split(/\s+/)) {
    const v = rules.get(c)?.get(prop);
    if (v !== undefined) value = v;
  }
  return value;
}

interface Painted {
  readonly canvas: string;
  /** Every element group: its shape's fill and stroke, its text's fill, its plate's fill. */
  readonly groups: readonly { readonly id: string; readonly kind: 'n' | 'c' | 'e'; readonly fill?: string; readonly stroke?: string; readonly text?: string; readonly plate?: string }[];
  /** Arrowhead ink: a filled marker's fill, an open one's stroke. */
  readonly markers: readonly string[];
}

function painted(doc: RenderedDoc): Painted {
  const svg = doc.rendered.svg;
  const rules = parseRules(doc.rendered.styleBlock);
  const canvas = /^\.canvas\{fill:([^}]*)\}$/m.exec(doc.rendered.styleBlock)![1]!;
  const groups: Painted['groups'][number][] = [];
  // Element groups are flat (layers hold them, they hold no groups); an
  // edge's label is its own `<g class="el">` in the label layer.
  let labels = 0;
  for (const chunk of svg.split('<g ').slice(1)) {
    const head = /^(?:id="([^"]*)"\s+)?class="(n|c|e|el)\b/.exec(chunk);
    if (head === null) continue;
    const kind = head[2] === 'c' ? 'c' : head[2] === 'n' ? 'n' : 'e';
    const id = head[1] ?? `edge label #${labels++}`;
    const shapeClass = /class="((?:n-shape|c-shape|e-path)\b[^"]*)"/.exec(chunk)?.[1];
    const textClass = /class="((?:n-title|c-title|el-text)\b[^"]*)"/.exec(chunk)?.[1];
    const plateClass = /class="(el-plate\b[^"]*)"/.exec(chunk)?.[1];
    const g: { id: string; kind: 'n' | 'c' | 'e'; fill?: string; stroke?: string; text?: string; plate?: string } = { id, kind };
    if (shapeClass !== undefined) {
      const fill = paintOf(rules, shapeClass, 'fill');
      const stroke = paintOf(rules, shapeClass, 'stroke');
      if (fill !== undefined && kind !== 'e') g.fill = fill;
      if (stroke !== undefined) g.stroke = stroke;
    }
    if (textClass !== undefined) {
      const text = paintOf(rules, textClass, 'fill');
      if (text !== undefined) g.text = text;
    }
    if (plateClass !== undefined) {
      const plate = paintOf(rules, plateClass, 'fill');
      if (plate !== undefined) g.plate = plate;
    }
    groups.push(g);
  }
  const markers: string[] = [];
  for (const m of svg.matchAll(/<(?:path|circle) class="(m[fs]-[0-9a-f]+)"/g)) {
    const v = paintOf(rules, m[1]!, m[1]!.startsWith('mf-') ? 'fill' : 'stroke');
    if (v !== undefined) markers.push(v);
  }
  return { canvas, groups, markers };
}

// ---------------------------------------------------------------------------
// WCAG 2.2 relative luminance and contrast ratio
// ---------------------------------------------------------------------------

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AAA_TEXT = 7;
const NON_TEXT = 3;

interface Pair {
  readonly doc: string;
  /** The first element seen with this pair. */
  readonly id: string;
  readonly what: string;
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly min: number;
}

/**
 * Every foreground/background pair the render of `doc` puts next to each
 * other: a title on its own shape's fill, an edge label on its plate (or, with
 * the plate off, on anything it could lie over), and every stroke and
 * arrowhead against every surface it can meet — the canvas and each container
 * fill (conservatively: not only the container it sits in) and, for a shape,
 * its own fill. Pairs are kept only when both colours are the theme's own
 * token values: a colour the document spells out as a literal (`#123456`,
 * `$brand`) is the author's choice, not the theme's, so it is skipped.
 */
function pairs(doc: string, p: Painted, tokenColours: ReadonlySet<string>): { readonly kept: readonly Pair[]; readonly skipped: number } {
  // Distinct (kind, foreground, background) pairs only: a 2 000-node
  // document repeats a handful of them thousands of times.
  const kept = new Map<string, Pair>();
  const skipped = new Set<string>();
  const surfaces = [...new Set([p.canvas, ...p.groups.filter((g) => g.kind === 'c' && g.fill !== undefined && g.fill !== 'none').map((g) => g.fill!)])];
  let id = '';
  const add = (what: string, fg: string | undefined, bg: string | undefined, min: number): void => {
    if (fg === undefined || bg === undefined || fg === 'none' || bg === 'none') return;
    const key = `${what}|${fg}|${bg}`;
    if (!tokenColours.has(fg.toUpperCase()) || !tokenColours.has(bg.toUpperCase())) {
      skipped.add(key);
      return;
    }
    if (!kept.has(key)) kept.set(key, { doc, id, what, fg, bg, ratio: contrast(fg, bg), min });
  };
  for (const g of p.groups) {
    id = g.id;
    if (g.kind === 'e') {
      if (g.plate !== undefined && g.plate !== 'none') {
        add(`label on its plate`, g.text, g.plate, AAA_TEXT);
      } else {
        for (const s of surfaces) add(`label (no plate)`, g.text, s, AAA_TEXT);
      }
    } else {
      add(`title on its fill`, g.text, g.fill ?? p.canvas, AAA_TEXT);
      add(`stroke on its own fill`, g.stroke, g.fill, NON_TEXT);
    }
    for (const s of surfaces) add(`stroke on a surface`, g.stroke, s, NON_TEXT);
  }
  id = 'a marker';
  for (const m of new Set(p.markers)) for (const s of surfaces) add('arrowhead on a surface', m, s, NON_TEXT);
  return { kept: [...kept.values()], skipped: skipped.size };
}

function tokenColoursOf(theme: ThemeDoc): ReadonlySet<string> {
  const { value } = resolveTheme(theme, (id) => BUILT_IN[id]);
  return new Set(Object.values(value.tokens).filter((v): v is string => typeof v === 'string' && v.startsWith('#')).map((v) => v.toUpperCase()));
}

describe('contrast helper', () => {
  it('is the WCAG 2.2 ratio', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});

describe('C5 high-contrast: WCAG 2.2 AAA text (≥ 7:1) and non-text (≥ 3:1) over the rendered corpus', () => {
  const tokens = tokenColoursOf(highContrast);

  it('every text/background and stroke/background pair the corpus renders clears its threshold', async () => {
    const all: Pair[] = [];
    let skipped = 0;
    for (const doc of listCorpusDocs()) {
      const r = pairs(doc, painted(await renderCorpusDoc(doc, highContrast)), tokens);
      for (const pair of r.kept) all.push(pair);
      skipped += r.skipped;
    }
    // Every kind of pair was really seen: titles, labels on plates, strokes, arrowheads.
    for (const what of ['title on its fill', 'label on its plate', 'stroke on a surface', 'stroke on its own fill', 'arrowhead on a surface']) {
      expect(all.some((p) => p.what === what), what).toBe(true);
    }
    expect(all.length).toBeGreaterThan(100);
    // Only document literals are skipped, and they are few.
    expect(skipped).toBeLessThan(all.length / 5);
    const failing = all.filter((p) => p.ratio < p.min).map((p) => `${p.doc} (${p.id}): ${p.what} ${p.fg} on ${p.bg} = ${p.ratio.toFixed(2)} < ${p.min}`);
    expect(failing).toEqual([]);
  });

  it('the theme\'s own token colours clear the thresholds pairwise where the cascade can pair them', () => {
    const { value } = resolveTheme(highContrast, (id) => BUILT_IN[id]);
    const t = (n: string): string => String(value.tokens[n]);
    // Text colours on every surface a text can sit on.
    for (const fg of ['ink', 'ink.muted', 'accent', 'danger']) for (const bg of ['bg', 'surface', 'surface.sunken']) expect(contrast(t(fg), t(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AAA_TEXT);
  });

  it('is exercised on the documents that bring class colours (accent, danger, sunken fills)', async () => {
    const p = painted(await renderCorpusDoc('classes.sgl', highContrast));
    const strokes = new Set(p.groups.map((g) => g.stroke));
    const { value } = resolveTheme(highContrast, (id) => BUILT_IN[id]);
    expect(strokes).toContain(String(value.tokens['accent']));
    expect(strokes).toContain(String(value.tokens['danger']));
  });
});

describe('C5 print: every fill white, every stroke and text black, over the rendered corpus', () => {
  for (const doc of listCorpusDocs()) {
    it(doc, async () => {
      const out = await renderCorpusDoc(doc, print);
      const p = painted(out);
      expect(p.canvas).toBe('#FFFFFF');
      for (const g of p.groups) {
        if (g.fill !== undefined) expect(g.fill, `${g.id} fill`).toMatch(/^(#FFFFFF|none)$/);
        if (g.stroke !== undefined) expect(g.stroke, `${g.id} stroke`).toMatch(/^(#000000|none)$/);
        if (g.text !== undefined) expect(g.text, `${g.id} text`).toBe('#000000');
        if (g.plate !== undefined) expect(g.plate, `${g.id} plate`).toMatch(/^(#FFFFFF|none)$/);
      }
      for (const m of p.markers) expect(m, 'arrowhead').toBe('#000000');
      // No colour anywhere in the paint rules but white, black and none.
      const colours = new Set([...out.rendered.styleBlock.matchAll(/(?:fill|stroke):(#[0-9A-Fa-f]+|[a-z]+)/g)].map((m) => m[1]!));
      for (const c of colours) expect(['#FFFFFF', '#000000', 'none'], `${doc}: ${c}`).toContain(c);
      // Dashes stay: every class's dash array is neutral-light's.
      const light = await renderCorpusDoc(doc, neutralLight);
      const dashes = (block: string): string[] => [...block.matchAll(/^\.([\w-]+)\{[^}]*?(stroke-dasharray:[^;}]*)/gm)].map((m) => `${m[1]}:${m[2]}`).sort();
      expect(dashes(out.rendered.styleBlock)).toEqual(dashes(light.rendered.styleBlock));
    });
  }

  it('colour-coded classes lose their colour by design (classes.sgl: accent, danger and a literal #123456)', async () => {
    const light = painted(await renderCorpusDoc('classes.sgl', neutralLight));
    expect(new Set(light.groups.map((g) => g.stroke)).size).toBeGreaterThan(2);
    const p = painted(await renderCorpusDoc('classes.sgl', print));
    expect(new Set(p.groups.map((g) => g.stroke))).toEqual(new Set(['#000000']));
  });

  it('a dashed edge keeps its dash under print', async () => {
    const { runPipeline } = await import('./pipeline.js');
    const src = 'a\nb\na -> b: { @style.strokeDash: dashed }\n';
    const out = await runPipeline(src, print);
    expect(out.rendered.styleBlock).toMatch(/stroke:#000000;stroke-dasharray:6 3/);
  });
});
