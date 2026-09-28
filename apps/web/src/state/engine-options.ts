import { ELK_DEFAULT_OPTIONS, ELK_ENGINE_ID, normalizeElkOptions } from '@sgl/layout-elk/descriptor';

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

/** DD-12 N37: `tree` takes `elk`'s `direction`, `nodeSpacing` and
 *  `rankSpacing` (names, values, defaults and the form's 0–500 range), and
 *  its own `edgeRouting`, `orthogonal` (elbows) or `straight`. */
function treeValues(bag: Readonly<Record<string, unknown>>): Readonly<Record<string, OptionValue>> {
  const { direction, nodeSpacing, rankSpacing } = elkValues(bag);
  return { direction, nodeSpacing, rankSpacing, edgeRouting: bag['edgeRouting'] === 'straight' ? 'straight' : 'orthogonal' };
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
  [TREE_ENGINE_ID]: {
    defaults: treeValues({}),
    normalize: treeValues,
  },
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
