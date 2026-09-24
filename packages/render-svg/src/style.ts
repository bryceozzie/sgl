/**
 * The generated `<style>` element (DD-07 §6).
 *
 * Identical styles across elements share one class, so a 500-node diagram with
 * three visual variants emits three rules rather than 500 attribute sets.
 *
 * Paint class names are **theme-invariant** (F7): `s-`/`t-`/`p-` are keyed on
 * the element's cascade inputs (`cascadeSignature`: DD-04 §4 steps 1–5 — role,
 * shape, author classes, inline `@style`), never on a resolved value, so a
 * theme switch changes only the rule bodies in `<style>`, never an element's
 * `class` attribute. Every
 * rule uses literal resolved values and the element holds no custom property,
 * declared or read (F17): Inkscape 1.2.2 discards a **whole** `<style>` element
 * that declares one, and every shape falls back to the default black fill. The
 * theme tokens are therefore not emitted at all (F18: re-theming an exported
 * file by overriding them is not supported; re-export under another theme).
 */

import { canonicalise, fnv1a64, shortHash } from '@sgl/core';
import type { ComputedStyle, StyleValue } from '@sgl/theme';
import { num } from './num.js';
import { cssColor, cssFontFamily, cssKeyword, hashToken } from './security.js';

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
    // `labelPlate: none` is the documented way to turn the plate off (DD-04 §2).
    // The plate `<rect>` is still emitted (F7: which elements exist never
    // depends on paint, DD-07 §6), so "off" is `fill:none`, and so is a plate
    // with no colour at all — never the SVG default black.
    push(out, 'fill', plate === null || plate === 'none' ? 'none' : cssColor(plate));
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

/** The role a cascade signature is for: an element's own style (DD-04 §4
 *  steps 1–5) or its label's (`rules.<role>.title` / `rules.edge.label`, then
 *  steps 3–5). */
export type SignatureRole = 'node' | 'container' | 'edge' | 'node.title' | 'container.title' | 'edge.label';

/**
 * The theme-invariant key a paint class is named after (F7, DD-07 §6): every
 * input DD-04 §4's cascade reads from the element itself before the theme's
 * values apply — the role (step 1), the shape (step 2, nodes and containers
 * only), the author classes in linearised order (steps 3 and 4: `byClass[c]`
 * and the document's `@classes[c].style`, both keyed by the class name), and
 * the inline `@style` bag (step 5), canonicalised. Step 6 (`@size`) is
 * geometry only. Under one theme and one document, equal signatures give equal
 * paint, so the signature is a sound de-duplication key; and nothing in it
 * comes from a theme, so the class name is the same under every theme.
 */
export function cascadeSignature(
  role: SignatureRole,
  shape: string | undefined,
  classes: readonly string[],
  config: Readonly<Record<string, unknown>> | undefined,
): string {
  const style = config?.['style'];
  const inline =
    typeof style === 'object' && style !== null && !Array.isArray(style)
      ? canonicalise(style as Readonly<Record<string, unknown>>)
      : '';
  return `${role}|${shape ?? ''}|${classes.join(',')}|${inline}`;
}

/** The class token for a signature: the whole `fnv1a64`, as the paint hash's
 *  token was before F7, so the collision odds are unchanged. */
export function signatureToken(signature: string): string {
  return hashToken(fnv1a64(signature));
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
   * Names already computed (F9, execution plan §2.1): a paint class by its
   * prefix and cascade signature, a geometry token by its declaration text. A
   * document has thousands of elements but a handful of distinct styles, so
   * each distinct signature is hashed, and its paint declarations built, once
   * per table. Equal signatures have equal paint within one render (see
   * `cascadeSignature`), so the first element's rule is every one's. The names,
   * the rules and which rule wins are exactly what naming every element afresh
   * gives (`test/naming-memo.test.ts`). `geometryHash` is deliberately not a
   * key: the geometry class is keyed by what it emits (see `classesFor`).
   */
  private readonly paintNames = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private readonly geometryTokens = new Map<string, string>();

  /** The token for `signature`, hashed once per table. */
  token(signature: string): string {
    let token = this.tokens.get(signature);
    if (token === undefined) {
      token = signatureToken(signature);
      this.tokens.set(signature, token);
    }
    return token;
  }

  /** `s-{signature token}` plus the geometry companion (DD-07 §6). */
  shapeClasses(style: ComputedStyle, signature: string): string {
    return this.classesFor(style, 'shape', 's', signature);
  }

  /** `t-{signature token}` plus the geometry companion, which is where the
   *  font lives — DD-07 §5: font properties come from the class, never inline. */
  textClasses(style: ComputedStyle, signature: string): string {
    return this.classesFor(style, 'text', 't', signature);
  }

  /** `p-{signature token}` (DD-07 §6), keyed on the edge's own signature
   *  (`labelPlate` is an edge property). Plates carry no geometry. */
  plateClasses(style: ComputedStyle, signature: string): string {
    return this.classesFor(style, 'plate', 'p', signature);
  }

  /**
   * The rule for a marker's own paint (DD-07 §6): `mf-{token}{fill:…}` for a
   * filled arrowhead, `ms-{token}{stroke:…}` for `open`, which is stroked.
   * `token` is the edge's signature token, so the rule, like the marker id,
   * never names a colour.
   */
  markerPaint(className: string, open: boolean, color: string): void {
    if (this.rules.has(className)) return;
    this.rules.set(className, open ? `stroke:${cssColor(color)}` : `fill:${cssColor(color)}`);
  }

  private classesFor(style: ComputedStyle, kind: RuleKind, prefix: string, signature: string): string {
    const key = `${prefix}\u0000${signature}`;
    let paint = this.paintNames.get(key);
    if (paint === undefined) {
      paint = `${prefix}-${this.token(signature)}`;
      this.paintNames.set(key, paint);
      // The class is on the element whether or not this theme gives it any
      // declaration (F7: the `class` attribute never depends on paint); only
      // the rule is omitted when there is nothing to put in it.
      const declarations = paintDeclarations(style.paint, kind);
      if (declarations.length > 0) this.rules.set(paint, declarations.join(';'));
    }
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
    if (geometryDecls.length === 0) return paint;
    const geometry = `g-${geometryToken}`;
    this.rules.set(geometry, geometryText);
    return `${geometry} ${paint}`;
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
 * The canvas gets its colour directly, never through `var()`.
 */
export function buildStyleBlock(canvasBackground: string, generated: readonly string[]): string {
  return [`.canvas{fill:${cssColor(canvasBackground)}}`, ...PREAMBLE, ...generated].join('\n');
}
