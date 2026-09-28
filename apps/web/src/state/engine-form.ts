import { ELK_DIRECTIONS, ELK_EDGE_ROUTINGS, ELK_ENGINE_ID, ELK_NODE_PLACEMENTS } from '@sgl/layout-elk/descriptor';
import { COLUMNS_MAX, engineOptionRules, FIXED_ENGINE_ID, GAP_MAX, GRID_ENGINE_ID, SPACING_MAX, TREE_ENGINE_ID, type OptionValue } from './engine-options.js';

/**
 * F11 (DD-08 §10): the per-engine options form, as DOM-free data and pure
 * functions — `toolbar/engine-options-form.tsx` only renders what this
 * returns: the fields, labels and edit rules. Each engine's defaults and the
 * normalisation of a stored bag are `engine-options.ts`, which the boot path
 * needs; this module is part of the lazy `engine-options-form` chunk, loaded
 * when Options ▾ is opened (A8 fix round 2).
 */

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
  /** Fix round 1, item 22: the largest value the form accepts (see each field). */
  readonly max: number;
  readonly step: number;
}

/** `grid`'s columns: a whole number of columns, or automatic. */
export interface ColumnsField {
  readonly kind: 'columns';
  readonly key: string;
  readonly label: string;
  readonly max: number;
}

export type OptionField = SelectField | NumberField | ColumnsField;

export interface EngineForm {
  readonly engineId: string;
  readonly title: string;
  readonly fields: readonly OptionField[];
  readonly defaults: Readonly<Record<string, OptionValue>>;
  /** Every field filled, from an untrusted bag (`engine-options.ts`). */
  readonly normalize: (bag: Readonly<Record<string, unknown>>) => Readonly<Record<string, OptionValue>>;
}

const choices = (values: readonly string[], labels: Readonly<Record<string, string>>) =>
  values.map((value) => ({ value, label: labels[value] ?? value }));

/** Direction and the two spacings: `elk`'s fields, which `tree` shares (DD-12 N37). */
const FLOW_FIELDS: readonly OptionField[] = [
  { kind: 'select', key: 'direction', label: 'Direction', choices: choices(ELK_DIRECTIONS, { down: 'Down', up: 'Up', left: 'Left', right: 'Right' }) },
  // Spacings in px, 0–500: the defaults are 40 and 70, and at 500 px two
  // neighbours no longer read as one diagram at any zoom the canvas offers.
  { kind: 'number', key: 'nodeSpacing', label: 'Node spacing', min: 0, max: SPACING_MAX, step: 1 },
  { kind: 'number', key: 'rankSpacing', label: 'Rank spacing', min: 0, max: SPACING_MAX, step: 1 },
];

const FIELDS: Readonly<Record<string, { readonly title: string; readonly fields: readonly OptionField[] }>> = {
  [ELK_ENGINE_ID]: {
    title: 'ELK Layered options',
    fields: [
      ...FLOW_FIELDS,
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
  },
  [GRID_ENGINE_ID]: {
    title: 'Grid options',
    fields: [
      { kind: 'columns', key: 'columns', label: 'Columns', max: COLUMNS_MAX },
      { kind: 'number', key: 'gap', label: 'Gap', min: 0, max: GAP_MAX, step: 1 },
      { kind: 'select', key: 'align', label: 'Align', choices: [{ value: 'center', label: 'Center' }, { value: 'start', label: 'Start' }] },
    ],
  },
  // DD-12 N19: one field, the gap between the nodes `fixed` packs below the
  // pinned ones; grid's range.
  [FIXED_ENGINE_ID]: {
    title: 'Fixed options',
    fields: [{ kind: 'number', key: 'gap', label: 'Gap', min: 0, max: GAP_MAX, step: 1 }],
  },
  // DD-12 N37: elk's direction and spacings, and whether tree arcs are
  // drawn as elbows (`orthogonal`) or straight.
  [TREE_ENGINE_ID]: {
    title: 'Tree options',
    fields: [
      ...FLOW_FIELDS,
      { kind: 'select', key: 'edgeRouting', label: 'Edges', choices: [{ value: 'orthogonal', label: 'Elbows' }, { value: 'straight', label: 'Straight' }] },
    ],
  },
};

/** The hand-built form for `engineId`, or `null` for an engine with none. */
export function engineForm(engineId: string): EngineForm | null {
  const fields = FIELDS[engineId];
  const rules = engineOptionRules(engineId);
  return fields === undefined || rules === null ? null : { engineId, ...fields, ...rules };
}

/** The form's current values: the bag, normalised for `engineId`. */
export function formValues(engineId: string, bag: Readonly<Record<string, unknown>>): Readonly<Record<string, OptionValue>> {
  const rules = engineOptionRules(engineId);
  return rules === null ? {} : rules.normalize(bag);
}

/** What happened to one edit (fix round 1, item 22): the whole bag after
 *  it, and — when the value was refused — a message saying why and which
 *  value is in use instead, for the form to show beside the field. */
export interface OptionEdit {
  readonly bag: Readonly<Record<string, OptionValue>>;
  readonly rejected: string | null;
}

/**
 * One field changed. `raw` is the input's text. A value the field does not
 * allow — not a choice, not a number, below `min`, above `max`, or for
 * `grid`'s columns not a whole number — is refused: the bag keeps the value
 * in use, and `rejected` says so. `grid`'s columns take an empty box (or
 * `auto`) as automatic.
 */
export function editOption(
  engineId: string,
  bag: Readonly<Record<string, unknown>>,
  key: string,
  raw: string,
): OptionEdit {
  const form = engineForm(engineId);
  if (form === null) return { bag: {}, rejected: null };
  const current = form.normalize(bag);
  const field = form.fields.find((f) => f.key === key);
  if (field === undefined) return { bag: current, rejected: null };
  let value: OptionValue | null = null;
  let rule = '';
  switch (field.kind) {
    case 'select':
      value = field.choices.some((c) => c.value === raw) ? raw : null;
      rule = 'one of the listed choices';
      break;
    case 'number': {
      const n = raw.trim() === '' ? Number.NaN : Number(raw);
      value = Number.isFinite(n) && n >= field.min && n <= field.max ? n : null;
      rule = `a number from ${field.min} to ${field.max}`;
      break;
    }
    case 'columns': {
      if (raw === 'auto' || raw.trim() === '') value = 'auto';
      else {
        const n = Number(raw);
        value = Number.isInteger(n) && n >= 1 && n <= field.max ? n : null;
      }
      rule = `a whole number from 1 to ${field.max}, or empty for automatic`;
      break;
    }
  }
  if (value === null) {
    return { bag: current, rejected: `${field.label} must be ${rule}. Using ${String(current[key])}.` };
  }
  return { bag: form.normalize({ ...current, [key]: value }), rejected: null };
}

/** `editOption`'s bag alone. */
export function withOption(
  engineId: string,
  bag: Readonly<Record<string, unknown>>,
  key: string,
  raw: string,
): Readonly<Record<string, OptionValue>> {
  return editOption(engineId, bag, key, raw).bag;
}
