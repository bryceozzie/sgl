/**
 * Theme resolution and the cascade — DD-04 §3, §4, §5.
 *
 * Two pure functions. `resolveTheme` turns an authored `ThemeDoc` into a
 * `ResolvedTheme` with inheritance followed, `@token` references dereferenced and
 * every value validated against the registry and normalised. `styleGraph` walks a
 * `SemanticGraph` and produces one `ComputedStyle` per element and per label,
 * partitioned on the registry's `affects` flag.
 *
 * Neither ever throws on bad input (DD-00 §3): both return `StageResult` with the
 * best partial value and a diagnostic for every thing they had to drop.
 */

import {
  canonicalise,
  diagnostic,
  fnv1a64,
  SIZE_KEYS,
  type ClassModel,
  type ConfigBag,
  type Diagnostic,
  type EdgeId,
  type GraphEdge,
  type GraphNode,
  type LabelId,
  type NodeId,
  type SemanticGraph,
  type SourceSpan,
  type StageResult,
} from '@sgl/core';
import { BY_NAME, COLOR_FALLBACK, type StyleProperty } from './registry.js';
import type {
  ComputedStyle,
  ResolvedTheme,
  StyleSet,
  StyleValue,
  StyledGraph,
  ThemeDoc,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DD-04 §3 step 1: following `extends` further than this is `SGL5001`. */
export const MAX_THEME_DEPTH = 8;

/**
 * DD-04 §3 step 3: the dash keywords, normalised to SVG dash arrays.
 *
 * The concrete numbers are this module's to choose — DD-04 names the keywords but
 * not their patterns — so they live here rather than in the normative registry.
 */
export const DASH_PATTERNS: Readonly<Record<string, readonly number[]>> = {
  solid: [],
  dashed: [6, 3],
  dotted: [1, 3],
};

/** A normalised style value: no `@` references, no booleans, insets already `[t,r,b,l]`. */
export type ResolvedValue = number | string | readonly number[];

/** Which half of the cascade an element draws its non-text properties from. */
type RoleKind = 'node' | 'container' | 'edge';

/**
 * Document classes as the cascade needs them (DD-04 §4 step 4).
 *
 * `SemanticGraph` deliberately keeps classes symbolic (DD-03 §4) and carries only
 * their *names* per element, so the class bodies have to arrive separately. The
 * application already holds them as `DocumentModel.classes`.
 */
export type DocumentClasses = Readonly<Record<string, ClassModel>>;

/** Theme-sourced diagnostics carry no span (DD-04 §6); `Diagnostic.span` is required. */
const NO_SPAN: SourceSpan = { from: 0, to: 0 };

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Key iteration is always sorted (DD-00 §3), so diagnostic order never depends on
 *  the order an object literal happened to be written in. */
const sortedKeys = (o: Readonly<Record<string, unknown>>): readonly string[] => Object.keys(o).sort();

const isPlainObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Value validation and normalisation (DD-04 §3 step 3)
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\([^()]*\)$/;
/** `none`, `transparent`, `currentColor` and the CSS named colours. */
const NAMED_COLOR = /^[a-zA-Z]+$/;
const NUMBER_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const LENGTH_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px)?$/;

function isColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return HEX_COLOR.test(s) || FUNCTIONAL_COLOR.test(s) || NAMED_COLOR.test(s);
}

function toNumber(v: unknown, allowPx: boolean): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!(allowPx ? LENGTH_LITERAL : NUMBER_LITERAL).test(s)) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/** One, two or four values → `[t, r, b, l]` (DD-04 §3 step 3). */
function toInsets(v: unknown): readonly number[] | undefined {
  const single = toNumber(v, true);
  if (single !== undefined) return [single, single, single, single];
  if (!Array.isArray(v)) return undefined;
  const parsed: number[] = [];
  for (const el of v as readonly unknown[]) {
    const n = toNumber(el, true);
    if (n === undefined) return undefined;
    parsed.push(n);
  }
  const [a, b, c, d] = parsed;
  if (parsed.length === 1) return [a as number, a as number, a as number, a as number];
  if (parsed.length === 2) return [a as number, b as number, a as number, b as number];
  if (parsed.length === 4) return [a as number, b as number, c as number, d as number];
  return undefined;
}

/** Keyword, `'4 2'` / `'4,2'`, or an array of numbers → a dash array. */
function toDash(v: unknown): readonly number[] | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    const keyword = hasOwn(DASH_PATTERNS, s) ? DASH_PATTERNS[s] : undefined;
    if (keyword !== undefined) return keyword;
    const parts = s.split(/[\s,]+/).filter((p) => p.length > 0);
    if (parts.length === 0) return undefined;
    return numberList(parts);
  }
  if (Array.isArray(v)) return numberList(v as readonly unknown[]);
  return undefined;
}

function numberList(items: readonly unknown[]): readonly number[] | undefined {
  const out: number[] = [];
  for (const item of items) {
    const n = toNumber(item, true);
    if (n === undefined || n < 0) return undefined;
    out.push(n);
  }
  return out;
}

/** What an unresolvable value becomes. Loud for colours, inert for everything else. */
function fallbackFor(prop: StyleProperty): ResolvedValue {
  switch (prop.type) {
    case 'color':
      return COLOR_FALLBACK;
    case 'length':
    case 'number':
      return 0;
    case 'insets':
      return [0, 0, 0, 0];
    case 'dash':
      return [];
    case 'enum':
      return prop.enum?.[0] ?? '';
    case 'string':
      return '';
  }
}

/** `undefined` means "fails its registry type" — the caller emits `SGL5004`. */
function coerce(prop: StyleProperty, raw: unknown): ResolvedValue | undefined {
  switch (prop.type) {
    case 'color':
      return isColor(raw) ? raw.trim() : undefined;
    case 'length':
      return toNumber(raw, true);
    case 'number':
      return toNumber(raw, false);
    case 'insets':
      return toInsets(raw);
    case 'dash':
      return toDash(raw);
    case 'enum':
      return typeof raw === 'string' && (prop.enum ?? []).includes(raw) ? raw : undefined;
    case 'string':
      return typeof raw === 'string' ? raw : undefined;
  }
}

function describe(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return `[${(raw as readonly unknown[]).map(describe).join(', ')}]`;
  if (raw === null) return 'null';
  if (typeof raw === 'object') return JSON.stringify(raw) ?? 'object';
  return String(raw);
}

// ---------------------------------------------------------------------------
// Token resolution (DD-04 §3 step 2)
// ---------------------------------------------------------------------------

const isTokenRef = (v: unknown): v is string => typeof v === 'string' && v.startsWith('@');

/**
 * Dereference the token table itself, transitively.
 *
 * Doing this once up front rather than per property is what keeps diagnostics
 * single: a broken token is reported where it is defined, and the twenty
 * properties that reference it inherit the fallback silently instead of shouting
 * twenty times about the same typo.
 */
function resolveTokenTable(
  raw: Readonly<Record<string, StyleValue>>,
  diagnostics: Diagnostic[],
): Record<string, StyleValue> {
  const out: Record<string, StyleValue> = {};
  const inProgress = new Set<string>();

  const visit = (name: string, trail: readonly string[]): StyleValue => {
    if (hasOwn(out, name)) return out[name] as StyleValue;
    if (inProgress.has(name)) {
      diagnostics.push(
        diagnostic('SGL5006', NO_SPAN, { name, cycle: [...trail, name].join(' → ') }),
      );
      return COLOR_FALLBACK;
    }
    const value = raw[name] as StyleValue;
    inProgress.add(name);
    let resolved: StyleValue;
    if (isTokenRef(value)) {
      const ref = value.slice(1);
      if (hasOwn(raw, ref)) {
        resolved = visit(ref, [...trail, name]);
      } else {
        diagnostics.push(diagnostic('SGL5005', NO_SPAN, { name: ref }));
        resolved = COLOR_FALLBACK;
      }
    } else {
      resolved = value;
    }
    inProgress.delete(name);
    out[name] = resolved;
    return resolved;
  };

  for (const name of sortedKeys(raw)) visit(name, []);
  return out;
}

interface Deref {
  readonly value: unknown;
  /** The reference named a token that does not exist; use the type's fallback. */
  readonly unresolved: boolean;
}

function deref(raw: unknown, tokens: Readonly<Record<string, StyleValue>>): Deref {
  if (!isTokenRef(raw)) return { value: raw, unresolved: false };
  const name = raw.slice(1);
  if (!hasOwn(tokens, name)) return { value: raw, unresolved: true };
  // The table is already fully dereferenced, so one hop is the whole chain.
  return { value: tokens[name], unresolved: false };
}

// ---------------------------------------------------------------------------
// StyleSet resolution
// ---------------------------------------------------------------------------

/**
 * Validate, dereference and normalise one authored `StyleSet`.
 *
 * `where` fills the `SGL5003` message; `span` is the document span for a set that
 * came from a document, and `NO_SPAN` for one that came from a theme (DD-04 §6).
 */
function resolveStyleSet(
  set: Readonly<Record<string, unknown>>,
  tokens: Readonly<Record<string, StyleValue>>,
  where: string,
  span: SourceSpan,
  diagnostics: Diagnostic[],
): Record<string, ResolvedValue> {
  const out: Record<string, ResolvedValue> = {};
  for (const name of sortedKeys(set)) {
    const prop = BY_NAME.get(name);
    if (prop === undefined) {
      diagnostics.push(diagnostic('SGL5003', span, { name, where }));
      continue;
    }
    const raw = set[name];
    const { value, unresolved } = deref(raw, tokens);
    if (unresolved) {
      diagnostics.push(
        diagnostic('SGL5005', span, { name: String(raw).slice(1) }),
      );
      out[name] = fallbackFor(prop);
      continue;
    }
    const coerced = coerce(prop, value);
    if (coerced === undefined) {
      diagnostics.push(
        diagnostic('SGL5004', span, { name, type: prop.type, value: describe(value) }),
      );
      continue;
    }
    out[name] = coerced;
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolveTheme (DD-04 §3)
// ---------------------------------------------------------------------------

/** The `extends` chain, nearest first. Stops at depth, at a cycle, and at a parent
 *  the lookup cannot supply. */
function inheritanceChain(
  doc: ThemeDoc,
  lookup: (id: string) => ThemeDoc | undefined,
  diagnostics: Diagnostic[],
): readonly ThemeDoc[] {
  const chain: ThemeDoc[] = [doc];
  const seen = new Set<string>([doc.id]);
  let current = doc;

  while (typeof current.extends === 'string') {
    const parentId = current.extends;
    if (seen.has(parentId)) {
      diagnostics.push(
        diagnostic('SGL5002', NO_SPAN, {
          id: parentId,
          cycle: [...chain.map((t) => t.id), parentId].join(' → '),
        }),
      );
      break;
    }
    if (chain.length > MAX_THEME_DEPTH) {
      diagnostics.push(
        diagnostic('SGL5001', NO_SPAN, {
          chain: chain.map((t) => t.id).join(' → '),
          id: parentId,
        }),
      );
      break;
    }
    const parent = lookup(parentId);
    // An `extends` naming a theme nobody can supply has no code in the DD-04
    // catalogue, so the chain simply stops: the child's own rules still resolve.
    if (parent === undefined) break;
    seen.add(parentId);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function mergeFlat(
  into: Record<string, StyleValue>,
  from: Readonly<Record<string, StyleValue>> | undefined,
): void {
  if (!isPlainObject(from)) return;
  for (const key of sortedKeys(from)) into[key] = from[key] as StyleValue;
}

/** Deep-merge one level down: a child `StyleSet` merges into the parent's for the
 *  same key rather than replacing it (DD-04 §3 step 1). */
function mergeNested(
  into: Record<string, Record<string, StyleValue>>,
  from: Readonly<Record<string, StyleSet>> | undefined,
): void {
  if (!isPlainObject(from)) return;
  for (const key of sortedKeys(from)) {
    const set = from[key];
    if (!isPlainObject(set)) continue;
    const target = into[key] ?? {};
    for (const name of sortedKeys(set)) target[name] = (set as StyleSet)[name] as StyleValue;
    into[key] = target;
  }
}

/** Resolve a theme document: follow `extends`, resolve `@token` references,
 *  normalise insets, dashes and lengths. Design: DD-04 §3. */
export function resolveTheme(
  doc: ThemeDoc,
  lookup: (id: string) => ThemeDoc | undefined = () => undefined,
): StageResult<ResolvedTheme> {
  const diagnostics: Diagnostic[] = [];
  const chain = inheritanceChain(doc, lookup, diagnostics);

  // 1. Inheritance — merge root ancestor first, so the child wins.
  const rawTokens: Record<string, StyleValue> = {};
  const rawRules: Record<string, Record<string, StyleValue>> = {};
  const rawByShape: Record<string, Record<string, StyleValue>> = {};
  const rawByClass: Record<string, Record<string, StyleValue>> = {};
  let rawBackground = '';

  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const t = chain[i] as ThemeDoc;
    mergeFlat(rawTokens, t.tokens);
    mergeNested(rawRules, t.rules);
    mergeNested(rawByShape, t.byShape);
    mergeNested(rawByClass, t.byClass);
    if (isPlainObject(t.canvas) && typeof t.canvas.background === 'string') {
      rawBackground = t.canvas.background;
    }
  }

  // 2. Token references.
  const tokens = resolveTokenTable(rawTokens, diagnostics);

  // 3. Validate and normalise every rule set.
  const resolveGroup = (
    group: Readonly<Record<string, Record<string, StyleValue>>>,
    kind: string,
  ): Record<string, StyleSet> => {
    const out: Record<string, StyleSet> = {};
    for (const key of sortedKeys(group)) {
      out[key] = resolveStyleSet(
        group[key] as Record<string, StyleValue>,
        tokens,
        `theme \`${doc.id}\` ${kind} \`${key}\``,
        NO_SPAN,
        diagnostics,
      );
    }
    return out;
  };

  const canvasDeref = deref(rawBackground, tokens);
  let background: string;
  if (canvasDeref.unresolved) {
    diagnostics.push(diagnostic('SGL5005', NO_SPAN, { name: rawBackground.slice(1) }));
    background = COLOR_FALLBACK;
  } else if (isColor(canvasDeref.value)) {
    background = canvasDeref.value.trim();
  } else {
    diagnostics.push(
      diagnostic('SGL5004', NO_SPAN, {
        name: 'canvas.background',
        type: 'color',
        value: describe(canvasDeref.value),
      }),
    );
    background = COLOR_FALLBACK;
  }

  const value: ResolvedTheme = {
    id: doc.id,
    rules: resolveGroup(rawRules, 'rule'),
    byShape: resolveGroup(rawByShape, 'byShape'),
    byClass: resolveGroup(rawByClass, 'byClass'),
    canvas: { background },
    tokens,
  };
  return { value, diagnostics };
}

// ---------------------------------------------------------------------------
// The cascade signature (DD-04 §4, DD-07 §6)
// ---------------------------------------------------------------------------

/** The role a cascade signature is for: an element's own style (DD-04 §4
 *  steps 1–5) or its label's (`rules.<role>.title` / `rules.edge.label`, then
 *  steps 3–5). */
export type SignatureRole = 'node' | 'container' | 'edge' | 'node.title' | 'container.title' | 'edge.label';

/**
 * Every input DD-04 §4's cascade reads from the element itself before the
 * theme's values apply — the role (step 1), the shape (step 2, nodes and
 * containers only), the author classes in linearised order (steps 3 and 4:
 * `byClass[c]` and the document's `@classes[c].style`, both keyed by the class
 * name), and the inline `@style` bag (step 5), canonicalised. Step 6 (`@size`)
 * is geometry only and not part of it.
 *
 * Under one theme and one document, equal signatures give equal steps 1–5,
 * hence equal paint (and, without `@size`, an equal style altogether). Two
 * things rely on that: `styleGraph` computes each distinct signature's style
 * once (F9), and the renderer names its paint classes after it (F7, DD-07 §6:
 * nothing in it comes from a theme, so a class name is the same under every
 * theme). A new input to steps 1–5 must be added here.
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

// ---------------------------------------------------------------------------
// styleGraph (DD-04 §4, §5)
// ---------------------------------------------------------------------------

/** Steps 3–5 of the cascade, resolved once per element and then filtered twice —
 *  once for the element's own bag and once for its label's — so an unknown
 *  property in `@style` is reported once rather than twice. */
interface ElementLayers {
  /** Step 3: `theme.byClass[c]`, in linearised order. */
  readonly themeClassSets: readonly Readonly<Record<string, ResolvedValue>>[];
  /** Step 4: the document's `@classes[c].style`, in linearised order. Every
   *  theme-level class set outranks every document one, per the DD-04 §4 table. */
  readonly docClassSets: readonly Readonly<Record<string, ResolvedValue>>[];
  readonly inline: Readonly<Record<string, ResolvedValue>>;
  /** Inline `@size`; empty for edges. */
  readonly size: Readonly<Record<string, ResolvedValue>>;
}

const appliesTo = (name: string, role: RoleKind | 'text'): boolean =>
  BY_NAME.get(name)?.appliesTo.includes(role) ?? false;

function assign(
  into: Record<string, ResolvedValue>,
  from: Readonly<Record<string, ResolvedValue>> | undefined,
  role: RoleKind | 'text',
): void {
  if (from === undefined) return;
  for (const name of sortedKeys(from)) {
    if (!appliesTo(name, role)) continue;
    into[name] = from[name] as ResolvedValue;
  }
}

/** A theme `StyleSet` is already validated and normalised; only the `appliesTo`
 *  filter is left to apply. */
function assignThemeSet(
  into: Record<string, ResolvedValue>,
  from: StyleSet | undefined,
  role: RoleKind | 'text',
): void {
  if (!isPlainObject(from)) return;
  for (const name of sortedKeys(from)) {
    if (!appliesTo(name, role)) continue;
    into[name] = from[name] as ResolvedValue;
  }
}

function styleSetFromConfig(value: unknown): Readonly<Record<string, unknown>> {
  return isPlainObject(value) ? value : {};
}

function sizeKeysOnly(set: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys(set)) if (SIZE_KEYS.has(key)) out[key] = set[key];
  return out;
}

function computeStyle(bag: Readonly<Record<string, ResolvedValue>>): ComputedStyle {
  const geometry: Record<string, ResolvedValue> = {};
  const paint: Record<string, ResolvedValue> = {};
  for (const name of sortedKeys(bag)) {
    const prop = BY_NAME.get(name);
    if (prop === undefined) continue;
    (prop.affects === 'geometry' ? geometry : paint)[name] = bag[name] as ResolvedValue;
  }
  const geometryHash = fnv1a64(canonicalise(geometry));
  // DD-04 §8 asks that changing one geometry property change *both* hashes, while
  // §5 asks that equal `paintHash` plus equal layout imply identical SVG. The
  // renderer reads geometry properties the layout result does not carry — `radius`
  // and `strokeWidth` shape the path itself — so both hold only if the paint hash
  // covers the geometry half too. A pure-paint hash would satisfy the comment on
  // `ComputedStyle.paintHash` and neither invariant, and would let a stale frame
  // through; this direction can only ever cost a redundant repaint.
  const paintHash = fnv1a64(canonicalise({ ...geometry, ...paint }));
  return { geometry, paint, geometryHash, paintHash };
}

/** Options for `styleGraph`. */
export interface StyleGraphOptions {
  /**
   * `false` computes every element's style afresh, as `styleGraph` did before
   * F9's memo: the reference the memo is tested against
   * (`test/memo.test.ts`), never needed otherwise. Default `true`.
   */
  readonly memo?: boolean;
}

/**
 * Apply the cascade per element and compute the two hashes.
 *
 * Pure and synchronous. Two `StyledGraph`s with equal `geometryHash` produce
 * identical layout inputs, which is what lets the application skip re-layout on a
 * paint-only change (DD-08 §3).
 *
 * `documentClasses` is DD-04 §4 step 4. DD-00 §4 spells the signature
 * `styleGraph(graph, theme)`, so the parameter is optional and that call still
 * compiles; without it steps 1–3, 5 and 6 apply and document classes contribute
 * nothing, because `SemanticGraph` carries class *names* only (DD-03 §4).
 *
 * **Once per distinct cascade signature** (F9, execution plan §2.1). A
 * document has thousands of elements and a handful of distinct signatures
 * (`cascadeSignature`: DD-04 §4 steps 1–5), and equal signatures resolve to
 * the same bag, so an element with no `@size` (step 6, the only per-element
 * input the signature leaves out) reuses the `ComputedStyle` of the first
 * element with its signature, hashes and all; a label likewise, by its own
 * signature. The one other thing that differs per element is where a
 * diagnostic points (its span, and its id in the message), so a signature
 * whose resolution reported anything is never reused: every element that
 * would report a diagnostic still resolves, and reports, on its own. The
 * result — every style, both graph hashes, every diagnostic and its order —
 * is exactly what resolving each element afresh gives (`options.memo:
 * false`; `test/memo.test.ts` compares them over the corpus under both
 * themes, the synthetic theme pair and random documents).
 *
 * Design: DD-04 §4, §5.
 */
export function styleGraph(
  graph: SemanticGraph,
  theme: ResolvedTheme,
  documentClasses: DocumentClasses = {},
  options: StyleGraphOptions = {},
): StageResult<StyledGraph> {
  const memo = options.memo ?? true;
  const diagnostics: Diagnostic[] = [];
  const styles: Record<string, ComputedStyle> = {};
  const labelStyles: Record<string, ComputedStyle> = {};
  const geometryParts: string[] = [];
  const paintParts: string[] = [];
  /** By cascade signature: styles whose resolution reported nothing. */
  const elementMemo = new Map<string, ComputedStyle>();
  const labelMemo = new Map<string, ComputedStyle>();

  const record = (id: string, style: ComputedStyle): void => {
    geometryParts.push(`${id}=${style.geometryHash}`);
    paintParts.push(`${id}=${style.paintHash}`);
  };

  /** Steps 3–5, resolved once. */
  const layersOf = (
    classes: readonly string[],
    config: ConfigBag | undefined,
    span: SourceSpan,
    where: string,
    withSize: boolean,
  ): ElementLayers => {
    // 3. Theme-level class styling, every class before any document class.
    const themeClassSets: Readonly<Record<string, ResolvedValue>>[] = [];
    for (const c of classes) {
      const themeSet = theme.byClass[c];
      if (isPlainObject(themeSet)) {
        themeClassSets.push(themeSet as Readonly<Record<string, ResolvedValue>>);
      }
    }
    // 4. Document `@classes[c].style`.
    const docClassSets: Readonly<Record<string, ResolvedValue>>[] = [];
    for (const c of classes) {
      const declaredStyle = styleSetFromConfig(documentClasses[c]?.config?.style);
      if (sortedKeys(declaredStyle).length > 0) {
        docClassSets.push(
          resolveStyleSet(declaredStyle, theme.tokens, `class \`${c}\``, span, diagnostics),
        );
      }
    }
    const inline = resolveStyleSet(
      styleSetFromConfig(config?.style),
      theme.tokens,
      where,
      span,
      diagnostics,
    );
    // Step 6 takes only the geometry keys `@size` may carry (language spec
    // §4, `SIZE_KEYS`): anything else under `@size` is the resolver's SGL2010
    // and must not reach the bag, or `@size.fill` would paint behind the
    // renderer's cascade signature (DD-07 §6), which leaves `@size` out.
    const size = withSize
      ? resolveStyleSet(sizeKeysOnly(styleSetFromConfig(config?.size)), theme.tokens, where, span, diagnostics)
      : {};
    return { themeClassSets, docClassSets, inline, size };
  };

  const elementBag = (
    role: RoleKind,
    shape: string | undefined,
    layers: ElementLayers,
  ): Record<string, ResolvedValue> => {
    const bag: Record<string, ResolvedValue> = {};
    assignThemeSet(bag, theme.rules[role], role); // 1
    if (role !== 'edge' && shape !== undefined) assignThemeSet(bag, theme.byShape[shape], role); // 2
    for (const set of layers.themeClassSets) assign(bag, set, role); // 3
    for (const set of layers.docClassSets) assign(bag, set, role); // 4
    assign(bag, layers.inline, role); // 5
    assign(bag, layers.size, role); // 6
    return bag;
  };

  const labelBag = (role: RoleKind, layers: ElementLayers): Record<string, ResolvedValue> => {
    const bag: Record<string, ResolvedValue> = {};
    const ruleKey = role === 'edge' ? 'edge.label' : `${role}.title`;
    assignThemeSet(bag, theme.rules[ruleKey], 'text'); // 1
    for (const set of layers.themeClassSets) assign(bag, set, 'text'); // 3
    for (const set of layers.docClassSets) assign(bag, set, 'text'); // 4
    assign(bag, layers.inline, 'text'); // 5
    return bag;
  };

  /**
   * One element and its label. `sizeFree`: the element has no `@size` key
   * (always, for an edge), so its own style is a function of its signature
   * alone. Layers (steps 3–6) are resolved at most once, and only when a
   * style is not reused; `clean` records whether resolving them reported
   * anything, and only a clean resolution is ever reused.
   */
  const styleElement = (
    role: RoleKind,
    shape: string | undefined,
    classes: readonly string[],
    config: ConfigBag | undefined,
    span: SourceSpan,
    id: string,
    withSize: boolean,
  ): { readonly style: ComputedStyle; readonly label: () => ComputedStyle } => {
    let layers: ElementLayers | null = null;
    let clean = true;
    const layersNow = (): ElementLayers => {
      if (layers === null) {
        const before = diagnostics.length;
        layers = layersOf(classes, config, span, `\`${id}\``, withSize);
        clean = diagnostics.length === before;
      }
      return layers;
    };
    const sizeFree = !withSize || sortedKeys(sizeKeysOnly(styleSetFromConfig(config?.size))).length === 0;

    let style: ComputedStyle | undefined;
    const signature = memo ? cascadeSignature(role, shape, classes, config) : '';
    if (memo && sizeFree) style = elementMemo.get(signature);
    if (style === undefined) {
      style = computeStyle(elementBag(role, shape, layersNow()));
      if (memo && sizeFree && clean) elementMemo.set(signature, style);
    }

    const label = (): ComputedStyle => {
      const labelRole: SignatureRole = role === 'edge' ? 'edge.label' : role === 'container' ? 'container.title' : 'node.title';
      const labelSignature = memo ? cascadeSignature(labelRole, undefined, classes, config) : '';
      let labelStyle = memo ? labelMemo.get(labelSignature) : undefined;
      if (labelStyle === undefined) {
        labelStyle = computeStyle(labelBag(role, layersNow()));
        if (memo && clean) labelMemo.set(labelSignature, labelStyle);
      }
      return labelStyle;
    };
    return { style, label };
  };

  // ---- nodes and containers ------------------------------------------------
  for (const id of graph.order) {
    const node: GraphNode | undefined = graph.nodes[id];
    if (node === undefined) continue;
    const role: RoleKind = node.children.length > 0 ? 'container' : 'node';
    const { style, label } = styleElement(role, node.shape, node.classes, node.config, node.span, id, true);
    styles[id] = style;
    record(id, style);

    if (node.labelId !== null) {
      const labelStyle = label();
      labelStyles[node.labelId] = labelStyle;
      record(node.labelId, labelStyle);
    }
  }

  // ---- edges ---------------------------------------------------------------
  for (const edge of graph.edges) {
    const e: GraphEdge = edge;
    const { style, label } = styleElement('edge', undefined, e.classes, e.config, e.span, e.id, false);
    styles[e.id] = style;
    record(e.id, style);

    if (e.labelId !== null) {
      const labelStyle = label();
      labelStyles[e.labelId] = labelStyle;
      record(e.labelId, labelStyle);
    }
  }

  // The canvas background is paint with nowhere else to live: it is not any
  // element's ComputedStyle, so the per-element loop above never records it,
  // and `paintHash` would then be unchanged by a theme that alters only the
  // background — the exact gap Stage G's pipeline-level theme-switch test
  // (packages/render-svg/test/pipeline.test.ts) surfaced on `empty.sgl`, whose
  // paintHash was `fnv1a64('')` under both themes. Geometry has no canvas
  // analogue (DD-04's split has nothing geometric at canvas scope), so only
  // paintParts gets this extra entry.
  paintParts.push(`canvas=${theme.canvas.background}`);

  const value: StyledGraph = {
    graph,
    styles: styles as Readonly<Record<NodeId | EdgeId, ComputedStyle>>,
    labelStyles: labelStyles as Readonly<Record<LabelId, ComputedStyle>>,
    canvas: { background: theme.canvas.background },
    themeId: theme.id,
    geometryHash: fnv1a64(geometryParts.join(';')),
    paintHash: fnv1a64(paintParts.join(';')),
  };
  return { value, diagnostics };
}
