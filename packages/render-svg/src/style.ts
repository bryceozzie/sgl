/**
 * The generated `<style>` blocks (DD-07 §6).
 *
 * Identical styles across elements share one class, so a 500-node diagram with
 * three visual variants emits three rules rather than 500 attribute sets. Tokens
 * are emitted as custom properties so a consumer can re-theme an exported file,
 * but every generated rule uses literal resolved values, never `var()`, so the
 * file renders identically in tools that ignore custom properties.
 *
 * The tokens go in a `<style>` element of their own, after the main one (F17):
 * Inkscape 1.2.2 does not ignore a rule of custom properties, it discards the
 * **whole** `<style>` element that holds one, and every shape falls back to the
 * default black fill. Kept apart, such a tool loses only the tokens.
 */

import { shortHash } from '@sgl/core';
import type { ComputedStyle, ResolvedTheme, StyleValue } from '@sgl/theme';
import { num } from './num.js';
import { cssColor, cssCustomProperty, cssFontFamily, cssKeyword, hashToken } from './security.js';

/** Which family of declarations a `ComputedStyle` is being rendered into. */
export type RuleKind = 'shape' | 'text' | 'plate';

type Bag = Readonly<Record<string, StyleValue>>;

const decl = (property: string, value: string): string => `${property}:${value}`;

function asNumber(v: StyleValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asString(v: StyleValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

/** `strokeDash` is normalised to a number array by the theme resolver (DD-04 §3). */
function cssDash(v: StyleValue | undefined): string | null {
  if (typeof v === 'string') return v === 'solid' || v === 'none' ? null : null;
  if (!Array.isArray(v)) return null;
  const parts = (v as readonly number[]).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return parts.length > 0 ? parts.map(num).join(' ') : null;
}

function push(out: string[], property: string, value: string | null): void {
  if (value !== null) out.push(decl(property, value));
}

/** The paint half of a rule: everything a theme swap is allowed to change. */
export function paintDeclarations(paint: Bag, kind: RuleKind): readonly string[] {
  const out: string[] = [];
  if (kind === 'shape') {
    push(out, 'fill', mapColor(paint['fill']));
    push(out, 'opacity', mapNumber(paint['opacity']));
    push(out, 'stroke', mapColor(paint['stroke']));
    push(out, 'stroke-dasharray', cssDash(paint['strokeDash']));
  } else if (kind === 'text') {
    push(out, 'fill', mapColor(paint['color']));
    push(out, 'opacity', mapNumber(paint['opacity']));
  } else {
    const plate = asString(paint['labelPlate']);
    // `labelPlate: none` is the documented way to turn the plate off (DD-04 §2);
    // the element is not emitted at all in that case, so there is nothing to style.
    push(out, 'fill', plate === null || plate === 'none' ? null : cssColor(plate));
  }
  return out;
}

/**
 * The geometry half: properties that are visual but that DD-04 §2 classifies as
 * geometry because changing them moves other pixels. They live in their own class
 * so that a `s-`/`t-` class keyed on the paint hash can never collide between two
 * elements that share paint and differ in, say, `strokeWidth` or `fontSize`.
 */
export function geometryDeclarations(geometry: Bag, kind: RuleKind): readonly string[] {
  const out: string[] = [];
  if (kind === 'shape') {
    push(out, 'stroke-width', mapLength(geometry['strokeWidth']));
  } else if (kind === 'text') {
    const family = asString(geometry['fontFamily']);
    push(out, 'font-family', family === null ? null : cssFontFamily(family));
    push(out, 'font-size', mapLength(geometry['fontSize']));
    const style = asString(geometry['fontStyle']);
    push(out, 'font-style', style === null ? null : cssKeyword(style));
    push(out, 'font-weight', mapNumber(geometry['fontWeight']));
    push(out, 'letter-spacing', mapLength(geometry['letterSpacing']));
  }
  return out;
}

function mapColor(v: StyleValue | undefined): string | null {
  const s = asString(v);
  return s === null ? null : cssColor(s);
}

function mapNumber(v: StyleValue | undefined): string | null {
  const n = asNumber(v);
  return n === null ? null : num(n);
}

function mapLength(v: StyleValue | undefined): string | null {
  const n = asNumber(v);
  return n === null ? null : `${num(n)}px`;
}

/**
 * Collects generated rules, deduplicating by class name.
 *
 * Insertion order is irrelevant: `emit` sorts, so two renders that discover the
 * same classes in different orders still produce the same bytes (DD-00 §3).
 */
export class ClassTable {
  private readonly rules = new Map<string, string>();
  /**
   * Tokens already computed, by the exact text they are computed from (F9,
   * execution plan §2.1): a paint token by `paintHash`, a geometry token by
   * its declaration text. A document has thousands of elements but a handful
   * of distinct styles, and a geometry token is an `fnv1a64` of its
   * declarations, so each distinct one is hashed once per table. Both are
   * caches of pure functions of their key, so the names, the rules and which
   * rule wins are exactly what naming every element afresh gave
   * (`test/naming-memo.test.ts`). `geometryHash` is deliberately not a key:
   * the geometry class is keyed by what it emits (see `classesFor`).
   */
  private readonly paintTokens = new Map<string, string>();
  private readonly geometryTokens = new Map<string, string>();

  /** Registers a rule and returns the class name, or `null` when it has no
   *  declarations and so does not need a class at all. */
  private add(prefix: string, key: string, declarations: readonly string[]): string | null {
    if (declarations.length === 0) return null;
    const name = `${prefix}-${key}`;
    this.rules.set(name, declarations.join(';'));
    return name;
  }

  /** `s-{paintHash}` plus the geometry companion (DD-07 §6). */
  shapeClasses(style: ComputedStyle): string {
    return this.classesFor(style, 'shape', 's');
  }

  /** `t-{hash}` plus the geometry companion, which is where the font lives —
   *  DD-07 §5: font properties come from the class, never inline. */
  textClasses(style: ComputedStyle): string {
    return this.classesFor(style, 'text', 't');
  }

  /** `p-{plateHash}` (DD-07 §6). Plates carry no geometry. */
  plateClasses(style: ComputedStyle): string {
    return this.classesFor(style, 'plate', 'p');
  }

  private classesFor(style: ComputedStyle, kind: RuleKind, prefix: string): string {
    let paintToken = this.paintTokens.get(style.paintHash);
    if (paintToken === undefined) {
      paintToken = hashToken(style.paintHash);
      this.paintTokens.set(style.paintHash, paintToken);
    }
    const paint = this.add(prefix, paintToken, paintDeclarations(style.paint, kind));
    const geometryDecls = geometryDeclarations(style.geometry, kind);
    // Keyed by the declarations themselves rather than by `geometryHash`: two
    // elements that differ only in a geometry property this renderer does not
    // emit (`padding`, `minWidth`) would otherwise get two identical rules.
    const geometryText = geometryDecls.join(';');
    let geometryToken = this.geometryTokens.get(geometryText);
    if (geometryToken === undefined) {
      geometryToken = shortHash(geometryText);
      this.geometryTokens.set(geometryText, geometryToken);
    }
    const geometry = this.add('g', geometryToken, geometryDecls);
    return [geometry, paint].filter((c): c is string => c !== null).join(' ');
  }

  /** Every generated rule, sorted by class name. */
  emit(): readonly string[] {
    return [...this.rules.keys()].sort().map((name) => `.${name}{${this.rules.get(name) as string}}`);
  }
}

/** The fixed rules every document gets after `.canvas`, in a fixed order. */
const PREAMBLE: readonly string[] = [
  '.c-shape,.n-shape{stroke-linejoin:round}',
  '.e-path{fill:none;stroke-linecap:round}',
  '.el-plate{stroke:none}',
  '.n-port{stroke:none}',
  'text{white-space:pre}',
];

/**
 * Build the main `<style>` text: every rule that paints the diagram, with
 * literal resolved values and **no** custom property, declared or read (F17).
 * The canvas gets its colour directly rather than through `var(--sgl-canvas)`:
 * a tool that drops the token element must still paint the canvas.
 */
export function buildStyleBlock(canvasBackground: string, generated: readonly string[]): string {
  return [`.canvas{fill:${cssColor(canvasBackground)}}`, ...PREAMBLE, ...generated].join('\n');
}

/**
 * Build the token `<style>` text: one `svg.sgl` rule — scoped to the root svg,
 * never `:root` — declaring every theme token as a custom property, plus
 * `--sgl-canvas`. Nothing in the main block reads them; they are there for a
 * consumer to override when re-theming an exported file (DD-07 §6). The render
 * writes this into its own `<style>` element, after the main one (F17).
 */
export function buildTokenBlock(theme: ResolvedTheme, canvasBackground: string): string {
  const tokens: string[] = [`--sgl-canvas:${cssColor(canvasBackground)}`];
  for (const name of Object.keys(theme.tokens).sort()) {
    const property = cssCustomProperty(name);
    if (property === '') continue;
    const value = theme.tokens[name];
    const rendered = tokenValue(value);
    if (rendered === null) continue;
    tokens.push(`${property}:${rendered}`);
  }
  return `svg.sgl{${tokens.join(';')}}`;
}

/**
 * A token can be any `StyleValue`, and it is emitted as a custom property purely
 * for a consumer to override — nothing in the generated rules reads it. It still
 * goes through the same validation as a used value, because `'unsafe-inline'`
 * makes the `<style>` elements the one place CSP does not protect (DD-09 §1.2).
 */
function tokenValue(value: StyleValue | undefined): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? num(value) : null;
  if (typeof value === 'boolean') return null;
  if (Array.isArray(value)) {
    const parts = (value as readonly number[]).filter((n) => typeof n === 'number' && Number.isFinite(n));
    return parts.length === (value as readonly number[]).length && parts.length > 0
      ? parts.map(num).join(' ')
      : null;
  }
  if (typeof value !== 'string') return null;
  if (value.startsWith('#') || /^(?:rgb|rgba|hsl|hsla)\(/.test(value)) return cssColor(value);
  // Anything else a theme holds as a string is a font stack or a keyword.
  return value.includes(',') ? cssFontFamily(value) : (cssKeyword(value) ?? cssFontFamily(value));
}
