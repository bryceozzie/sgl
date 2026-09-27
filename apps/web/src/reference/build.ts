/**
 * `buildReference` (DD-13 P4): the help reference's facts, built at run time
 * from the tables the code itself runs on, so there is no copy to go stale.
 * Pure and DOM-free (it runs under the Node `unit` project), with no prose.
 *
 * **Lazy.** Only the help chunks import this module, dynamically: it must
 * never be statically reachable from the entry or the layout worker
 * (`test/reference-boot.test.ts`). Nearly everything it reads is already in
 * the boot bundle; `IMPORT_CATALOGUE` comes from the lazy `@sgl/core/imports`
 * entry, which the bundler shares with the `imports` chunk.
 *
 * The engine list is passed in (`REGISTERED_ENGINES`), not imported: which
 * engines exist is the app's choice, and it keeps the builder usable by a CLI
 * or an LSP later (DD-13 P4).
 */

import {
  CATALOGUE,
  CONFIG_REGISTRY,
  DEFAULT_SHAPE,
  DRAWABLE_SHAPES,
  LANGUAGE_SHAPES,
  PORT_SIDES,
  SIZE_KEYS,
  STRUCTURAL_KEYS,
  type ConfigKeySpec,
  type Severity,
} from '@sgl/core';
import { IMPORT_CATALOGUE } from '@sgl/core/imports';
import { A11Y_KEYS } from '@sgl/render-svg';
import { BUILT_IN, DASH_PATTERNS, DEFAULT_THEME_ID, REGISTRY, resolveTheme, type StyleSet, type StyleValue } from '@sgl/theme';
import type {
  DiagFact,
  DiagStage,
  EngineFact,
  FactValue,
  KeyFact,
  OptionFact,
  Reference,
  ReferenceEngine,
  RoleDefault,
  ShapeFact,
  StyleFact,
  ThemeFact,
  TokenFact,
} from './types.js';

export function buildReference(engines: readonly ReferenceEngine[]): Reference {
  const themeIds = Object.keys(BUILT_IN).sort();
  return deepFreeze({
    keys: keyFacts(engines, themeIds),
    styles: REGISTRY.map(styleFact),
    shapes: [...LANGUAGE_SHAPES].map(shapeFact),
    engines: engines.map(engineFact),
    themes: themeIds.map(themeFact),
    tokens: tokenFacts(themeIds),
    diagnostics: diagFacts(),
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const keyId = (key: string): string => `key/${key}`;

/** Sub-keys the code defines for a registry key, each a fact of its own (DD-13 P6). */
function subKeyFacts(row: ConfigKeySpec, engines: readonly ReferenceEngine[]): readonly KeyFact[] {
  const sub = (name: string, type: ConfigKeySpec['type'], values?: readonly string[]): KeyFact => ({
    id: keyId(`${row.key}.${name}`),
    key: `${row.key}.${name}`,
    written: `@${row.key}.${name}`,
    scopes: [...row.scope],
    type,
    ...(values !== undefined && { values }),
    parent: keyId(row.key),
  });
  switch (row.key) {
    case 'size':
      return [...SIZE_KEYS].map((k) => sub(k, 'number'));
    case 'a11y':
      return A11Y_KEYS.map((k) => sub(k, 'string'));
    case 'layout':
      // The one `@layout` key the app reads itself (`documentEngineOverride`);
      // every other is an engine option or hint, listed on its engine.
      return [sub('engine', 'string', engines.map((e) => e.id))];
    default:
      return [];
  }
}

function keyFacts(engines: readonly ReferenceEngine[], themeIds: readonly string[]): readonly KeyFact[] {
  // Canonical order (DD-02 §6): `order`, ties in registry order.
  const rows = CONFIG_REGISTRY.map((row, i) => ({ row, i }))
    .sort((a, b) => a.row.order - b.row.order || a.i - b.i)
    .map(({ row }) => row);
  const out: KeyFact[] = [];
  for (const row of rows) {
    const subs = subKeyFacts(row, engines);
    const subKeys = row.key === 'style' ? REGISTRY.map((p) => styleId(p.name)) : subs.map((s) => s.id);
    const values = keyValues(row, themeIds);
    const fallback = row.key === 'shape' ? DEFAULT_SHAPE : row.key === 'theme' ? DEFAULT_THEME_ID : undefined;
    out.push({
      id: keyId(row.key),
      key: row.key,
      written: `@${row.key}`,
      scopes: [...row.scope],
      type: row.type,
      ...(values !== undefined && { values }),
      ...(fallback !== undefined && { default: fallback }),
      ...(subKeys.length > 0 && { subKeys }),
    });
    out.push(...subs);
  }
  for (const spec of STRUCTURAL_KEYS) {
    out.push({
      id: keyId(spec.key),
      key: spec.key,
      written: `@${spec.key}`,
      scopes: [...spec.scope],
      type: spec.type,
      structural: true,
      ...(spec.canonicalOnly === true && { canonicalOnly: true as const }),
    });
  }
  return out;
}

function keyValues(row: ConfigKeySpec, themeIds: readonly string[]): readonly string[] | undefined {
  if (row.enum !== undefined) return [...row.enum];
  if (row.key === 'ports') return [...PORT_SIDES];
  if (row.key === 'theme') return [...themeIds];
  return undefined;
}

// ---------------------------------------------------------------------------
// Styles and shapes
// ---------------------------------------------------------------------------

const styleId = (name: string): string => `style/${name}`;

const printValue = (v: StyleValue): string => (Array.isArray(v) ? v.join(' ') : String(v));

const defaultTheme = BUILT_IN[DEFAULT_THEME_ID];

function styleFact(p: (typeof REGISTRY)[number]): StyleFact {
  const rules = defaultTheme?.rules ?? {};
  const defaults: RoleDefault[] = [];
  for (const role of Object.keys(rules).sort()) {
    const v = rules[role]?.[p.name];
    if (v !== undefined) defaults.push({ role, value: printValue(v) });
  }
  const values = p.enum !== undefined ? [...p.enum] : (p.type === 'dash' ? Object.keys(DASH_PATTERNS).sort() : undefined);
  return {
    id: styleId(p.name),
    name: p.name,
    written: `@style.${p.name}`,
    affects: p.affects,
    type: p.type,
    ...(values !== undefined && { values }),
    appliesTo: [...p.appliesTo],
    inherits: p.inherits,
    defaults,
  };
}

const sortedStyle = (set: StyleSet): readonly { property: string; value: string }[] =>
  Object.keys(set)
    .sort()
    .map((property) => ({ property, value: printValue(set[property]!) }));

function shapeFact(name: string): ShapeFact {
  const byShape = defaultTheme?.byShape[name];
  return {
    id: `shape/${name}`,
    name,
    drawn: DRAWABLE_SHAPES.has(name),
    ...(name === DEFAULT_SHAPE && { default: true as const }),
    ...(byShape !== undefined && { themeDefaults: sortedStyle(byShape) }),
  };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

type Schema = Readonly<Record<string, unknown>>;

/** `sgl.elk` → `elk`, the same short form `@layout.engine` accepts (`layout-config.ts`). */
const bareNameOf = (id: string): string => (id.startsWith('sgl.') ? id.slice('sgl.'.length) : id);

const isFactValue = (v: unknown): v is FactValue => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** The branches of a property schema: itself, or each `oneOf`/`anyOf` member. */
function branches(schema: Schema): readonly Schema[] {
  const alt = schema['oneOf'] ?? schema['anyOf'];
  return Array.isArray(alt) ? (alt as Schema[]) : [schema];
}

function optionFacts(kind: 'option' | 'hint', bareName: string, schema: Schema | undefined): readonly OptionFact[] {
  const props = schema?.['properties'];
  if (typeof props !== 'object' || props === null) return [];
  // Schema order, which is the descriptor's authored order (the order the
  // Options ▾ form shows): option names are never integer-like.
  return Object.entries(props as Readonly<Record<string, Schema>>).map(([name, prop]) => {
    const types: string[] = [];
    const values: string[] = [];
    let minimum: number | undefined;
    for (const b of branches(prop)) {
      const t = b['type'];
      for (const one of Array.isArray(t) ? t : [t]) if (typeof one === 'string' && !types.includes(one)) types.push(one);
      const e = b['enum'];
      if (Array.isArray(e)) for (const v of e) if (!values.includes(String(v))) values.push(String(v));
      if (typeof b['minimum'] === 'number') minimum = b['minimum'];
    }
    const fallback = prop['default'];
    return {
      id: `${kind}/${bareName}.${name}`,
      name,
      written: `@layout.${name}`,
      types,
      ...(values.length > 0 && { values }),
      ...(minimum !== undefined && { minimum }),
      ...(isFactValue(fallback) && { default: fallback }),
    };
  });
}

function engineFact(e: ReferenceEngine): EngineFact {
  const bareName = bareNameOf(e.id);
  const caps = e.capabilities as unknown as Readonly<Record<string, unknown>>;
  const capabilities: Record<string, FactValue> = {};
  for (const k of Object.keys(caps).sort()) {
    const v = caps[k];
    if (isFactValue(v)) capabilities[k] = v;
  }
  return {
    id: `engine/${bareName}`,
    engineId: e.id,
    bareName,
    name: e.name,
    determinism: e.capabilities.determinism,
    capabilities,
    options: optionFacts('option', bareName, e.optionsSchema),
    hints: optionFacts('hint', bareName, e.hintsSchema),
  };
}

// ---------------------------------------------------------------------------
// Themes and tokens
// ---------------------------------------------------------------------------

function themeFact(id: string): ThemeFact {
  const doc = BUILT_IN[id]!;
  return {
    id: `theme/${id}`,
    themeId: id,
    name: doc.name,
    extends: doc.extends,
    forces: Object.keys(doc.force ?? {}).sort(),
    default: id === DEFAULT_THEME_ID,
  };
}

/** Each token's resolved value per theme: `extends` followed and `@` references resolved (DD-04 §3). */
function tokenFacts(themeIds: readonly string[]): readonly TokenFact[] {
  const resolved = themeIds.map((id) => ({ id, tokens: resolveTheme(BUILT_IN[id]!, (x) => BUILT_IN[x]).value.tokens }));
  const names = [...new Set(resolved.flatMap((t) => Object.keys(t.tokens)))].sort();
  return names.map((name) => {
    const values: Record<string, string> = {};
    for (const { id, tokens } of resolved) {
      const v = tokens[name];
      if (v !== undefined) values[id] = printValue(v);
    }
    return { id: `token/${name}`, name, written: `@${name}`, values };
  });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** The thousands digit of a code names its stage (`diagnostics.ts`, DD-00 §3). */
const STAGES: Readonly<Record<string, DiagStage>> = {
  '1': 'syntax',
  '2': 'resolution',
  '3': 'semantic',
  '4': 'layout',
  '5': 'theme',
  '6': 'platform',
};

function diagFacts(): readonly DiagFact[] {
  const rows: Readonly<Record<string, { readonly severity: Severity; readonly template: string }>> = { ...CATALOGUE, ...IMPORT_CATALOGUE };
  return Object.keys(rows)
    .sort()
    .map((code) => {
      const stage = STAGES[code.charAt('SGL'.length)];
      if (stage === undefined) throw new Error(`buildReference: ${code} has no stage`);
      return { id: `diag/${code}`, code, severity: rows[code]!.severity, template: rows[code]!.template, stage };
    });
}

// ---------------------------------------------------------------------------

/** One immutable object (DD-13 P6): help and E6 share it, so neither may change it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
