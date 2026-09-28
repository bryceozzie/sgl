import { ELK_DEFAULT_OPTIONS, ELK_ENGINE_ID, normalizeElkOptions } from '@sgl/layout-elk/descriptor';
import { radialDescriptor, treeDescriptor, type EngineDescriptor } from '@sgl/layout-std/descriptor';

/**
 * F11 (DD-08 §10): each engine's option defaults and the normalisation of an
 * untrusted bag — the part of the options form the boot path needs, because
 * the pipeline sends every layout request through `optionsForEngine` and
 * selecting an engine resets the bag to `defaultOptionsFor`. The form itself
 * (fields, labels, edit rules: `engine-form.ts`, rendered by
 * `toolbar/engine-options-form.tsx`) is a lazy chunk loaded when Options ▾ is
 * opened (A8 fix round 2, execution plan §2.1 F20).
 *
 * **One hand-built form per engine** (decision K9). Generating the form from
 * `optionsSchema` is B7 and out of scope; each engine's fields, labels and
 * defaults are written out by hand. The values go through the pipeline's
 * existing `engineOptions` signal (persisted on the document record since
 * Stage J).
 *
 * The bag is untrusted (it comes from IndexedDB, a share link's record or an
 * older version), so every read normalises: a value the field allows is kept,
 * anything else shows — and is sent to the engine as — the default.
 */

export const GRID_ENGINE_ID = 'sgl.grid';
/** DD-12 §4 (feat/b5-fixed). */
export const FIXED_ENGINE_ID = 'sgl.fixed';
/** DD-12 §8 (feat/b5-tree). */
export const TREE_ENGINE_ID = 'sgl.tree';
/** DD-12 §9 (feat/b5-radial). */
export const RADIAL_ENGINE_ID = 'sgl.radial';

export type OptionValue = string | number;

/** Largest spacing/gap the forms accept, in px (fix round 1, item 22). */
export const SPACING_MAX = 500;
/** Largest gap for grid, in px: its default is 24; beyond 200 a grid of cells
 *  is mostly gap. */
export const GAP_MAX = 200;
/** Largest explicit column count for grid: more than 50 columns is wider than
 *  any screen at a legible zoom; `auto` covers large graphs (⌈√n⌉). */
export const COLUMNS_MAX = 50;

export interface EngineOptionRules {
  readonly defaults: Readonly<Record<string, OptionValue>>;
  /** Every field filled, from an untrusted bag. */
  readonly normalize: (bag: Readonly<Record<string, unknown>>) => Readonly<Record<string, OptionValue>>;
}

/** DD-06 §7's `optionsSchema`: `columns: number | 'auto' ('auto')`, `gap:
 *  number (24)`, `align: start|center (center)` — the values `grid.ts` reads. */
const GRID_DEFAULTS: Readonly<Record<string, OptionValue>> = { columns: 'auto', gap: 24, align: 'center' };

/** DD-12 N19: `gap: number (24)`, the loose-node packing gap, grid's field. */
const FIXED_DEFAULTS: Readonly<Record<string, OptionValue>> = { gap: 24 };

const validGap = (gap: unknown, fallback: number): number =>
  typeof gap === 'number' && Number.isFinite(gap) && gap >= 0 && gap <= GAP_MAX ? gap : fallback;

/** `elk`'s options, normalised; the spacings stop at the form's maximum. */
function elkValues(bag: Readonly<Record<string, unknown>>) {
  const o = normalizeElkOptions(bag);
  // The engine accepts any non-negative spacing; the form (and so the
  // request, item 3) stops at its own maximum.
  return {
    ...o,
    nodeSpacing: o.nodeSpacing <= SPACING_MAX ? o.nodeSpacing : ELK_DEFAULT_OPTIONS.nodeSpacing,
    rankSpacing: o.rankSpacing <= SPACING_MAX ? o.rankSpacing : ELK_DEFAULT_OPTIONS.rankSpacing,
  };
}

type SchemaProps = Readonly<Record<string, { readonly enum?: readonly string[]; readonly default: OptionValue }>>;

/** The rules of an engine whose options are all enums and 0–500 spacings,
 *  read from its descriptor's `optionsSchema`: its fields, in schema order,
 *  and its defaults (B5 branch 4 fix round 1, item 9: `tree`'s were `elk`'s,
 *  equal only by coincidence). An enum keeps a value it lists, a number a
 *  finite one from 0 to `SPACING_MAX`; anything else is the default.
 *
 *  - DD-12 N37: `tree` has `elk`'s `direction`, `nodeSpacing` and
 *    `rankSpacing` (names, values and the form's 0–500 range), and its own
 *    `edgeRouting`, `orthogonal` (elbows) or `straight`.
 *  - DD-12 N47 (feat/b5-radial): `radial` has `tree`'s two spacings, the
 *    second its ring gap. */
function schemaRules(descriptor: EngineDescriptor): EngineOptionRules {
  const props = (descriptor.optionsSchema as { readonly properties: SchemaProps }).properties;
  const normalize = (bag: Readonly<Record<string, unknown>>): Readonly<Record<string, OptionValue>> => {
    const out: Record<string, OptionValue> = {};
    for (const key in props) {
      const v = bag[key];
      const p = props[key]!;
      out[key] = (p.enum ? typeof v === 'string' && p.enum.includes(v) : typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= SPACING_MAX) ? (v as OptionValue) : p.default;
    }
    return out;
  };
  return { defaults: normalize({}), normalize };
}

const RULES: Readonly<Record<string, EngineOptionRules>> = {
  [ELK_ENGINE_ID]: {
    defaults: { ...ELK_DEFAULT_OPTIONS },
    normalize: elkValues,
  },
  [GRID_ENGINE_ID]: {
    defaults: GRID_DEFAULTS,
    normalize: (bag) => {
      const columns = bag['columns'];
      const gap = bag['gap'];
      return {
        columns: typeof columns === 'number' && Number.isInteger(columns) && columns >= 1 && columns <= COLUMNS_MAX ? columns : 'auto',
        gap: validGap(gap, GRID_DEFAULTS['gap'] as number),
        align: bag['align'] === 'start' ? 'start' : 'center',
      };
    },
  },
  [FIXED_ENGINE_ID]: {
    defaults: FIXED_DEFAULTS,
    normalize: (bag) => ({ gap: validGap(bag['gap'], FIXED_DEFAULTS['gap'] as number) }),
  },
  [TREE_ENGINE_ID]: schemaRules(treeDescriptor),
  [RADIAL_ENGINE_ID]: schemaRules(radialDescriptor),
};

/** `engineId`'s defaults and normalisation, or `null` for an engine with no
 *  hand-built form (Options ▾ is then not shown). */
export function engineOptionRules(engineId: string): EngineOptionRules | null {
  return RULES[engineId] ?? null;
}

/** What `engineOptions` resets to when `engineId` is selected (DD-08 §10). */
export function defaultOptionsFor(engineId: string): Readonly<Record<string, OptionValue>> {
  return { ...(RULES[engineId]?.defaults ?? {}) };
}

/**
 * What the layout request carries (fix round 1, item 3): for an engine with a
 * hand-built form, exactly what the form shows — the stored bag normalised by
 * the same rules, every field filled — so an invalid stored value (grid's
 * `columns: "x"`) reaches the engine as the default the form displays, not
 * raw. An engine with no form gets its bag unchanged.
 */
export function optionsForEngine(engineId: string, bag: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const rules = RULES[engineId];
  return rules === undefined ? bag : rules.normalize(bag);
}

/** DD-12 H6: whether a document's root `@layout.{key}: value` is one the
 *  engine's form would keep, and so is sent; else it is `SGL2011` and the
 *  form's value applies. An engine with no form takes any value. */
export function acceptsOption(engineId: string, key: string, value: unknown): boolean {
  const rules = RULES[engineId];
  return rules === undefined || rules.normalize({ [key]: value })[key] === value;
}
