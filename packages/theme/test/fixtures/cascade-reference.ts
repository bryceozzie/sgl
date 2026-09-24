/**
 * TEST FIXTURE, not shipped: the reference `test/memo.test.ts` holds
 * `styleGraph` to. It is `packages/theme/src/cascade.ts`'s `styleGraph` as it
 * was on `main` at 681729f, before F9's per-signature memo
 * (`feat/theme-fast-path`) — every element resolved afresh — trimmed to what
 * that function needs: the theme resolution (`resolveTheme` and its helpers)
 * is gone, the import paths differ, and nothing else is changed.
 *
 * **Keep it in step with the cascade.** When the cascade's *output* is meant
 * to change (a new property, a new step, a new diagnostic), make the same
 * change here in the same commit; this file exists only to catch a change to
 * `styleGraph` that nobody meant.
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
import { BY_NAME, COLOR_FALLBACK, type StyleProperty } from '../../src/registry.js';
import type {
  ComputedStyle,
  ResolvedTheme,
  StyleSet,
  StyleValue,
  StyledGraph,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * DD-04 §3 step 3: the dash keywords, normalised to SVG dash arrays.
 *
 * The concrete numbers are this module's to choose — DD-04 names the keywords but
 * not their patterns — so they live here rather than in the normative registry.
 */
const DASH_PATTERNS: Readonly<Record<string, readonly number[]>> = {
  solid: [],
  dashed: [6, 3],
  dotted: [1, 3],
};

/** A normalised style value: no `@` references, no booleans, insets already `[t,r,b,l]`. */
type ResolvedValue = number | string | readonly number[];

/** Which half of the cascade an element draws its non-text properties from. */
type RoleKind = 'node' | 'container' | 'edge';

/**
 * Document classes as the cascade needs them (DD-04 §4 step 4).
 *
 * `SemanticGraph` deliberately keeps classes symbolic (DD-03 §4) and carries only
 * their *names* per element, so the class bodies have to arrive separately. The
 * application already holds them as `DocumentModel.classes`.
 */
type DocumentClasses = Readonly<Record<string, ClassModel>>;

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
 * Design: DD-04 §4, §5.
 */
export function styleGraph(
  graph: SemanticGraph,
  theme: ResolvedTheme,
  documentClasses: DocumentClasses = {},
): StageResult<StyledGraph> {
  const diagnostics: Diagnostic[] = [];
  const styles: Record<string, ComputedStyle> = {};
  const labelStyles: Record<string, ComputedStyle> = {};
  const geometryParts: string[] = [];
  const paintParts: string[] = [];

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

  // ---- nodes and containers ------------------------------------------------
  for (const id of graph.order) {
    const node: GraphNode | undefined = graph.nodes[id];
    if (node === undefined) continue;
    const role: RoleKind = node.children.length > 0 ? 'container' : 'node';
    const layers = layersOf(node.classes, node.config, node.span, `\`${id}\``, true);

    const style = computeStyle(elementBag(role, node.shape, layers));
    styles[id] = style;
    record(id, style);

    if (node.labelId !== null) {
      const label = computeStyle(labelBag(role, layers));
      labelStyles[node.labelId] = label;
      record(node.labelId, label);
    }
  }

  // ---- edges ---------------------------------------------------------------
  for (const edge of graph.edges) {
    const e: GraphEdge = edge;
    const layers = layersOf(e.classes, e.config, e.span, `\`${e.id}\``, false);

    const style = computeStyle(elementBag('edge', undefined, layers));
    styles[e.id] = style;
    record(e.id, style);

    if (e.labelId !== null) {
      const label = computeStyle(labelBag('edge', layers));
      labelStyles[e.labelId] = label;
      record(e.labelId, label);
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
