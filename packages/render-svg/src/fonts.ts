/**
 * D2 (DD-07 §9): an exported SVG embeds the fonts it uses.
 *
 * `render()` names its fonts and embeds none: the live view, `lastGood.svg`,
 * the stored boot picture and every golden stay exactly as they are. Embedding
 * is a step the caller takes when a file or the clipboard receives the SVG
 * (the application's Save ▾ SVG, Copy SVG and the PNG's rasterisation-only
 * copy, DD-08 §7; a future CLI the same way). The caller supplies the font
 * bytes, since only it knows where they live; this module decides which faces
 * the SVG needs and writes them in.
 *
 * Pure and deterministic: no DOM, no I/O, and the same SVG and faces give the
 * same bytes whatever order the faces come in. Its own package entry
 * (`@sgl/render-svg/fonts`), so an application that embeds only at export keeps
 * it out of the bundle that renders.
 */

import { escapeXml } from './security.js';

/** One font face, as CSS font matching keys it. */
export interface FontFaceKey {
  /** A family name, as `font-family` names it (`Inter`). Matched case-insensitively. */
  readonly family: string;
  /** 1–1000; 400 is normal, 700 bold. */
  readonly weight: number;
  /** `normal`, `italic` or `oblique`. */
  readonly style: string;
}

/** A face with its bytes: a WOFF2 file, base64-encoded (no `data:` prefix). */
export interface EmbeddedFont extends FontFaceKey {
  readonly woff2Base64: string;
}

/** The SVG's main (first, and in `render()` output only) `<style>` element. */
const STYLE = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/;

const FONT_STYLES = ['normal', 'italic', 'oblique'] as const;
type FontStyle = (typeof FONT_STYLES)[number];

/** What the SVG's own rules ask for. */
interface Used {
  readonly families: ReadonlySet<string>;
  readonly weights: ReadonlySet<number>;
  readonly styles: ReadonlySet<FontStyle>;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** `a;b` split on `;` outside quotes: a quoted family may hold one. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let quote = '';
  let start = 0;
  const flush = (end: number): void => {
    const d = body.slice(start, end);
    const colon = d.indexOf(':');
    if (colon > 0) out.set(d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).trim());
  };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === '\\') i += 1;
    else if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ';') {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return out;
}

function familyKey(name: string): string {
  const t = name.trim();
  const unquoted = (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
  return unquoted.toLowerCase();
}

function parseWeight(value: string): number | null {
  const v = value.toLowerCase();
  if (v === 'normal') return 400;
  if (v === 'bold') return 700;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : null;
}

function parseStyle(value: string): FontStyle | null {
  const v = value.toLowerCase().split(/\s+/)[0] ?? '';
  return (FONT_STYLES as readonly string[]).includes(v) ? (v as FontStyle) : null;
}

/**
 * The families, weights and styles the `<style>` rules name. A rule with a
 * `font-family` but no `font-weight` (or `font-style`) draws at CSS's initial
 * value, 400 (`normal`), so that counts too. Weights and styles are gathered
 * across rules rather than per rule, since a weight in one rule can apply to
 * text whose family comes from another; embedding a face too many costs bytes,
 * one too few draws in the wrong font. At-rules (an `@font-face` already
 * there) are not usage.
 */
function usedByRules(svg: string): Used | null {
  const m = STYLE.exec(svg);
  if (m === null) return null;
  const css = decodeXml(m[1]!);
  const families = new Set<string>();
  const weights = new Set<number>();
  const styles = new Set<FontStyle>();
  for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (rule[1]!.trim().startsWith('@')) continue;
    const d = declarations(rule[2]!);
    const family = d.get('font-family');
    const weight = d.get('font-weight');
    const style = d.get('font-style');
    if (family !== undefined) {
      for (const name of family.split(',')) if (familyKey(name) !== '') families.add(familyKey(name));
      if (weight === undefined) weights.add(400);
      if (style === undefined) styles.add('normal');
    }
    const w = weight === undefined ? null : parseWeight(weight);
    if (w !== null) weights.add(w);
    const s = style === undefined ? null : parseStyle(style);
    if (s !== null) styles.add(s);
  }
  if (families.size === 0) return null;
  if (weights.size === 0) weights.add(400);
  if (styles.size === 0) styles.add('normal');
  return { families, weights, styles };
}

/** CSS Fonts 4 §5.2's weight matching: the face a browser would draw
 *  `desired` with, given only `available`. */
function matchWeight(desired: number, available: readonly number[]): number | undefined {
  if (available.includes(desired)) return desired;
  const up = available.filter((w) => w > desired).sort((a, b) => a - b);
  const down = available.filter((w) => w < desired).sort((a, b) => b - a);
  if (desired >= 400 && desired <= 500) {
    const toFiveHundred = up.filter((w) => w <= 500);
    return toFiveHundred[0] ?? down[0] ?? up[0];
  }
  return desired < 400 ? (down[0] ?? up[0]) : (up[0] ?? down[0]);
}

/** Style fallback as CSS matches it: italic → oblique → normal, and oblique →
 *  italic → normal (a normal face is slanted by the browser). */
const STYLE_FALLBACK: Readonly<Record<FontStyle, readonly FontStyle[]>> = {
  normal: ['normal', 'oblique', 'italic'],
  italic: ['italic', 'oblique', 'normal'],
  oblique: ['oblique', 'italic', 'normal'],
};

function compareKeys(a: FontFaceKey, b: FontFaceKey): number {
  const fa = familyKey(a.family);
  const fb = familyKey(b.family);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a.style !== b.style) return a.style < b.style ? -1 : 1;
  return a.weight - b.weight;
}

/**
 * The faces of `fonts` the SVG draws with: for each family its `<style>` names
 * that `fonts` has, each weight and style its rules use, matched as CSS font
 * matching would among `fonts` (a 700 with only 400–600 given uses 600). One
 * per slot, the first given for a slot winning, sorted by family, style and
 * weight. Empty when the SVG has no `font-family` rule (no text).
 *
 * Takes faces without bytes too, so a caller can find out what to fetch before
 * fetching it.
 */
export function usedFontFaces<T extends FontFaceKey>(svg: string, fonts: readonly T[]): T[] {
  const used = usedByRules(svg);
  if (used === null) return [];
  const slots = new Map<string, T>();
  for (const f of fonts) {
    const key = `${familyKey(f.family)}\u0000${f.style}\u0000${f.weight}`;
    if (!slots.has(key)) slots.set(key, f);
  }
  const unique = [...slots.values()];
  const chosen = new Set<T>();
  for (const family of used.families) {
    const ofFamily = unique.filter((f) => familyKey(f.family) === family);
    if (ofFamily.length === 0) continue;
    for (const style of used.styles) {
      const fallback = STYLE_FALLBACK[style].find((s) => ofFamily.some((f) => f.style === s));
      if (fallback === undefined) continue;
      const ofStyle = ofFamily.filter((f) => f.style === fallback);
      const available = ofStyle.map((f) => f.weight);
      for (const weight of used.weights) {
        const w = matchWeight(weight, available);
        const face = ofStyle.find((f) => f.weight === w);
        if (face !== undefined) chosen.add(face);
      }
    }
  }
  return [...chosen].sort(compareKeys);
}

/** A CSS string: `'` and `\` backslash-escaped, control characters as hex escapes. */
function cssString(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be escaped.
  return `'${text.replace(/[\\']/g, '\\$&').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}'`;
}

function check(font: EmbeddedFont): void {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(font.woff2Base64) || font.woff2Base64.length % 4 !== 0) {
    throw new TypeError(`embedFonts: ${font.family} ${font.weight}: woff2Base64 is not base64`);
  }
  if (!Number.isInteger(font.weight) || font.weight < 1 || font.weight > 1000) {
    throw new TypeError(`embedFonts: ${font.family}: weight ${font.weight} is not an integer in 1–1000`);
  }
  if (!(FONT_STYLES as readonly string[]).includes(font.style)) {
    throw new TypeError(`embedFonts: ${font.family}: style ${JSON.stringify(font.style)} is not normal, italic or oblique`);
  }
  if (font.family.trim() === '') throw new TypeError('embedFonts: an empty family name');
}

/** One face as an `@font-face` rule with a `data:` URL, in CSS. */
export function fontFaceRule(font: EmbeddedFont): string {
  return (
    `@font-face{font-family:${cssString(font.family)};font-style:${font.style};font-weight:${font.weight};` +
    `src:url(data:font/woff2;base64,${font.woff2Base64}) format('woff2')}`
  );
}

/**
 * `svg` with the faces of `fonts` it uses (`usedFontFaces`) embedded: one
 * `@font-face` rule each, with a `data:font/woff2;base64,…` URL, one per
 * line at the start of its main `<style>` element, XML-escaped as `render()`
 * escapes that element's text. Everything else is byte for byte what came in,
 * and an SVG that uses none of them (no text, or no family given) comes back
 * unchanged. Throws on a malformed face (not base64, a weight outside 1–1000,
 * an unknown style): that is the caller's bug, never document input.
 */
export function embedFonts(svg: string, fonts: readonly EmbeddedFont[]): string {
  for (const f of fonts) check(f);
  const faces = usedFontFaces(svg, fonts);
  if (faces.length === 0) return svg;
  const m = STYLE.exec(svg)!;
  const at = m.index + m[0].length - m[1]!.length - '</style>'.length;
  const rules = faces.map((f) => `${escapeXml(fontFaceRule(f))}\n`).join('');
  return `${svg.slice(0, at)}${rules}${svg.slice(at)}`;
}
