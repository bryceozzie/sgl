import { ELK_DEFAULT_OPTIONS, ELK_DIRECTIONS, ELK_EDGE_ROUTINGS, ELK_ENGINE_ID, ELK_NODE_PLACEMENTS, normalizeElkOptions } from '@sgl/layout-elk/descriptor';

/**
 * F11 (DD-08 §10): the per-engine options form, as DOM-free data and pure
 * functions — `toolbar/EngineOptions.tsx` only renders what this returns.
 *
 * **One hand-built form per engine** (decision K9). Generating the form from
 * `optionsSchema` is B7 and out of scope; each engine's fields, labels and
 * defaults are written out here. The values go through the pipeline's
 * existing `engineOptions` signal (persisted on the document record since
 * Stage J). Selecting an engine resets that bag to the engine's defaults
 * (`defaultOptionsFor`, used by `picker-actions.ts`'s `selectEngine`).
 *
 * The bag is untrusted (it comes from IndexedDB, a share link's record or an
 * older version), so every read normalises: a value the field allows is kept,
 * anything else shows — and is sent to the engine as — the default.
 */

export const GRID_ENGINE_ID = 'sgl.grid';

export type OptionValue = string | number;

export interface SelectField {
  readonly kind: 'select';
  readonly key: string;
  readonly label: string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}

export interface NumberField {
  readonly kind: 'number';
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly step: number;
}

/** `grid`'s columns: a whole number of columns, or automatic. */
export interface ColumnsField {
  readonly kind: 'columns';
  readonly key: string;
  readonly label: string;
}

export type OptionField = SelectField | NumberField | ColumnsField;

export interface EngineForm {
  readonly engineId: string;
  readonly title: string;
  readonly fields: readonly OptionField[];
  readonly defaults: Readonly<Record<string, OptionValue>>;
  /** Every field filled, from an untrusted bag. */
  readonly normalize: (bag: Readonly<Record<string, unknown>>) => Readonly<Record<string, OptionValue>>;
}

const choices = (values: readonly string[], labels: Readonly<Record<string, string>>) =>
  values.map((value) => ({ value, label: labels[value] ?? value }));

const ELK_FORM: EngineForm = {
  engineId: ELK_ENGINE_ID,
  title: 'ELK Layered options',
  fields: [
    { kind: 'select', key: 'direction', label: 'Direction', choices: choices(ELK_DIRECTIONS, { down: 'Down', up: 'Up', left: 'Left', right: 'Right' }) },
    { kind: 'number', key: 'nodeSpacing', label: 'Node spacing', min: 0, step: 1 },
    { kind: 'number', key: 'rankSpacing', label: 'Rank spacing', min: 0, step: 1 },
    {
      kind: 'select',
      key: 'edgeRouting',
      label: 'Edge routing',
      choices: choices(ELK_EDGE_ROUTINGS, { ORTHOGONAL: 'Orthogonal', POLYLINE: 'Polyline', SPLINES: 'Splines' }),
    },
    {
      kind: 'select',
      key: 'nodePlacement',
      label: 'Node placement',
      choices: choices(ELK_NODE_PLACEMENTS, { BRANDES_KOEPF: 'Brandes–Köpf', NETWORK_SIMPLEX: 'Network simplex', LINEAR_SEGMENTS: 'Linear segments' }),
    },
  ],
  defaults: { ...ELK_DEFAULT_OPTIONS },
  normalize: (bag) => ({ ...normalizeElkOptions(bag) }),
};

/** DD-06 §7's `optionsSchema`: `columns: number | 'auto' ('auto')`, `gap:
 *  number (24)`, `align: start|center (center)` — the values `grid.ts` reads. */
const GRID_DEFAULTS: Readonly<Record<string, OptionValue>> = { columns: 'auto', gap: 24, align: 'center' };

const GRID_FORM: EngineForm = {
  engineId: GRID_ENGINE_ID,
  title: 'Grid options',
  fields: [
    { kind: 'columns', key: 'columns', label: 'Columns' },
    { kind: 'number', key: 'gap', label: 'Gap', min: 0, step: 1 },
    { kind: 'select', key: 'align', label: 'Align', choices: [{ value: 'center', label: 'Center' }, { value: 'start', label: 'Start' }] },
  ],
  defaults: GRID_DEFAULTS,
  normalize: (bag) => {
    const columns = bag['columns'];
    const gap = bag['gap'];
    return {
      columns: typeof columns === 'number' && Number.isInteger(columns) && columns >= 1 ? columns : 'auto',
      gap: typeof gap === 'number' && Number.isFinite(gap) && gap >= 0 ? gap : (GRID_DEFAULTS['gap'] as number),
      align: bag['align'] === 'start' ? 'start' : 'center',
    };
  },
};

const FORMS: Readonly<Record<string, EngineForm>> = { [ELK_ENGINE_ID]: ELK_FORM, [GRID_ENGINE_ID]: GRID_FORM };

/** The hand-built form for `engineId`, or `null` for an engine with none. */
export function engineForm(engineId: string): EngineForm | null {
  return FORMS[engineId] ?? null;
}

/** What `engineOptions` resets to when `engineId` is selected (DD-08 §10). */
export function defaultOptionsFor(engineId: string): Readonly<Record<string, OptionValue>> {
  return { ...(FORMS[engineId]?.defaults ?? {}) };
}

/** The form's current values: the bag, normalised for `engineId`. */
export function formValues(engineId: string, bag: Readonly<Record<string, unknown>>): Readonly<Record<string, OptionValue>> {
  const form = FORMS[engineId];
  return form === undefined ? {} : form.normalize(bag);
}

/**
 * The bag after the user changed one field. `raw` is the input's text; a
 * number field that does not parse to an allowed number (empty, negative,
 * `NaN`) is ignored rather than written (the previous value stays). `grid`'s
 * columns take `'auto'` or a whole number ≥ 1.
 */
export function withOption(
  engineId: string,
  bag: Readonly<Record<string, unknown>>,
  key: string,
  raw: string,
): Readonly<Record<string, OptionValue>> {
  const form = FORMS[engineId];
  if (form === undefined) return {};
  const current = form.normalize(bag);
  const field = form.fields.find((f) => f.key === key);
  if (field === undefined) return current;
  let value: OptionValue | null = null;
  switch (field.kind) {
    case 'select':
      value = field.choices.some((c) => c.value === raw) ? raw : null;
      break;
    case 'number': {
      const n = raw.trim() === '' ? Number.NaN : Number(raw);
      value = Number.isFinite(n) && n >= field.min ? n : null;
      break;
    }
    case 'columns': {
      if (raw === 'auto' || raw.trim() === '') value = 'auto';
      else {
        const n = Number(raw);
        value = Number.isInteger(n) && n >= 1 ? n : null;
      }
      break;
    }
  }
  return value === null ? current : form.normalize({ ...current, [key]: value });
}
