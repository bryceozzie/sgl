import { CATALOGUE, CONFIG_REGISTRY, DEFAULT_SHAPE, DRAWABLE_SHAPES, LANGUAGE_SHAPES, PORT_SIDES, SIZE_KEYS, STRUCTURAL_KEYS } from '@sgl/core';
import { IMPORT_CATALOGUE } from '@sgl/core/imports';
import { elkDescriptor } from '@sgl/layout-elk/descriptor';
import { A11Y_KEYS } from '@sgl/render-svg';
import { BUILT_IN, DASH_PATTERNS, DEFAULT_THEME_ID, REGISTRY, resolveTheme } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { REGISTERED_ENGINES } from '../src/io/app-boot.js';
import { buildReference } from '../src/reference/build.js';
import type { EngineFact, KeyFact, Reference } from '../src/reference/types.js';

/**
 * DD-13 P20 (help branch 1): the generated reference. Every completeness case
 * iterates the source table itself, never a list typed here, so a row added
 * to the registry, the catalogue, a descriptor or a theme (for example
 * `feat/b5-pin`'s `@pin` and `SGL4021`) is covered without touching this file.
 */

const ref: Reference = buildReference(REGISTERED_ENGINES);

const byId = <T extends { readonly id: string }>(list: readonly T[], id: string): T => {
  const found = list.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no fact ${id}`);
  return found;
};
const key = (name: string): KeyFact => byId(ref.keys, `key/${name}`);
const engine = (bare: string): EngineFact => byId(ref.engines, `engine/${bare}`);
const bareName = (id: string): string => (id.startsWith('sgl.') ? id.slice('sgl.'.length) : id);
const schemaProps = (schema: unknown): Readonly<Record<string, Readonly<Record<string, unknown>>>> =>
  ((schema as { properties?: Record<string, Readonly<Record<string, unknown>>> } | undefined)?.properties ?? {});

describe('buildReference: representative entries (DD-13 P6)', () => {
  it('@shape: its scopes, type, values and the default the compiler uses', () => {
    expect(key('shape')).toEqual({
      id: 'key/shape',
      key: 'shape',
      written: '@shape',
      scopes: ['node', 'class'],
      type: 'enum',
      values: [...LANGUAGE_SHAPES],
      default: DEFAULT_SHAPE,
    });
  });

  it('@size and its sub-keys, each an entry of its own', () => {
    expect(key('size').subKeys).toEqual([...SIZE_KEYS].map((k) => `key/size.${k}`));
    expect(key('size.maxWidth')).toEqual({
      id: 'key/size.maxWidth',
      key: 'size.maxWidth',
      written: '@size.maxWidth',
      scopes: ['node', 'class'],
      type: 'number',
      parent: 'key/size',
    });
  });

  it('@a11y sub-keys come from the renderer; @ports values are the port sides', () => {
    expect(key('a11y').subKeys).toEqual(['key/a11y.label', 'key/a11y.description']);
    expect(key('a11y.description')).toMatchObject({ type: 'string', scopes: ['node', 'edge'], parent: 'key/a11y' });
    expect(key('ports').values).toEqual([...PORT_SIDES]);
  });

  it('@style lists every style property as its sub-keys, by their style ids', () => {
    expect(key('style').subKeys).toEqual(REGISTRY.map((p) => `style/${p.name}`));
  });

  it('@layout.engine takes the registered engines\' bare names (DD-12 N22); @theme the built-in theme ids', () => {
    expect(key('layout.engine')).toMatchObject({ type: 'string', values: ['elk', 'grid', 'fixed'], parent: 'key/layout' });
    expect(key('layout').subKeys).toEqual(['key/layout.engine']);
    expect(key('theme').values).toEqual(['high-contrast', 'neutral-dark', 'neutral-light', 'print']);
    expect(key('theme').default).toBe(DEFAULT_THEME_ID);
  });

  it('the structural keys @extends and @edges', () => {
    expect(key('extends')).toEqual({ id: 'key/extends', key: 'extends', written: '@extends', scopes: ['class'], type: 'array', structural: true });
    expect(key('edges')).toMatchObject({ scopes: ['root', 'node'], type: 'array', structural: true, canonicalOnly: true });
  });

  it('style/strokeDash: dash keywords, paint; style/strokeWidth: the default theme\'s values per role', () => {
    expect(byId(ref.styles, 'style/strokeDash')).toEqual({
      id: 'style/strokeDash',
      name: 'strokeDash',
      written: '@style.strokeDash',
      affects: 'paint',
      type: 'dash',
      values: ['dashed', 'dotted', 'solid'],
      appliesTo: ['node', 'container', 'edge'],
      inherits: false,
      defaults: [],
    });
    expect(byId(ref.styles, 'style/strokeWidth').defaults).toEqual([
      { role: 'container', value: '1' },
      { role: 'edge', value: '1.5' },
      { role: 'node', value: '1.5' },
    ]);
    expect(byId(ref.styles, 'style/padding').defaults).toContainEqual({ role: 'node', value: '8 12' });
    expect(byId(ref.styles, 'style/arrowhead').values).toEqual(['triangle', 'open', 'diamond', 'circle', 'none']);
  });

  it('shapes: drawn or not, and the default theme\'s per-shape style', () => {
    expect(byId(ref.shapes, 'shape/cylinder')).toEqual({
      id: 'shape/cylinder',
      name: 'cylinder',
      drawn: true,
      themeDefaults: [{ property: 'fill', value: '@surface.sunken' }],
    });
    expect(byId(ref.shapes, 'shape/cloud')).toEqual({ id: 'shape/cloud', name: 'cloud', drawn: false });
    expect(byId(ref.shapes, 'shape/rect')).toMatchObject({ drawn: true, default: true });
  });

  it('engine/elk: identity, capabilities, options with defaults and hints', () => {
    const elk = engine('elk');
    expect(elk).toMatchObject({ engineId: 'sgl.elk', bareName: 'elk', name: 'ELK Layered', determinism: 'quantized' });
    expect(elk.capabilities).toEqual({ containers: true, determinism: 'quantized', edgeRouting: 'orthogonal', incremental: false, labelPlacement: true, ports: true });
    expect(byId(elk.options, 'option/elk.direction')).toEqual({
      id: 'option/elk.direction',
      name: 'direction',
      written: '@layout.direction',
      types: ['string'],
      values: ['down', 'up', 'left', 'right'],
      default: 'down',
    });
    expect(byId(elk.options, 'option/elk.nodeSpacing')).toMatchObject({ types: ['number'], minimum: 0, default: 40 });
    expect(byId(elk.hints, 'hint/elk.portConstraints').values).toContain('FIXED_SIDE');
  });

  it('option/grid.columns: a number or "auto"', () => {
    expect(byId(engine('grid').options, 'option/grid.columns')).toEqual({
      id: 'option/grid.columns',
      name: 'columns',
      written: '@layout.columns',
      types: ['number', 'string'],
      values: ['auto'],
      default: 'auto',
    });
    expect(byId(engine('grid').hints, 'hint/grid.columns')).toMatchObject({ types: ['number'] });
  });

  it('themes, tokens and diagnostics', () => {
    expect(byId(ref.themes, 'theme/print')).toEqual({
      id: 'theme/print',
      themeId: 'print',
      name: 'Print',
      extends: 'neutral-light',
      forces: ['color', 'fill', 'labelPlate', 'shadow', 'stroke'],
      default: false,
    });
    expect(byId(ref.themes, 'theme/neutral-light')).toMatchObject({ extends: null, forces: [], default: true });
    expect(byId(ref.tokens, 'token/surface')).toEqual({
      id: 'token/surface',
      name: 'surface',
      written: '@surface',
      values: { 'high-contrast': '#FFFFFF', 'neutral-dark': expect.any(String), 'neutral-light': '#FFFFFF', 'print': '#FFFFFF' },
    });
    expect(byId(ref.diagnostics, 'diag/SGL3007')).toEqual({
      id: 'diag/SGL3007',
      code: 'SGL3007',
      severity: 'warning',
      template: CATALOGUE.SGL3007.template,
      stage: 'semantic',
    });
    expect(byId(ref.diagnostics, 'diag/SGL2017')).toMatchObject({ stage: 'resolution', template: IMPORT_CATALOGUE.SGL2017.template });
    expect(byId(ref.diagnostics, 'diag/SGL1001').stage).toBe('syntax');
    expect(byId(ref.diagnostics, 'diag/SGL4010').stage).toBe('layout');
    expect(byId(ref.diagnostics, 'diag/SGL5005').stage).toBe('theme');
    expect(byId(ref.diagnostics, 'diag/SGL6001').stage).toBe('platform');
  });
});

describe('buildReference: completeness (DD-13 P20)', () => {
  it('every CONFIG_REGISTRY row appears once, with its scopes, type and enum', () => {
    for (const row of CONFIG_REGISTRY) {
      const facts = ref.keys.filter((k) => k.key === row.key && k.structural !== true);
      expect(facts, row.key).toHaveLength(1);
      expect(facts[0]!.scopes).toEqual(row.scope);
      expect(facts[0]!.type).toBe(row.type);
      if (row.enum !== undefined) expect(facts[0]!.values).toEqual(row.enum);
    }
  });

  it('every structural key appears once', () => {
    for (const spec of STRUCTURAL_KEYS) {
      const facts = ref.keys.filter((k) => k.key === spec.key);
      expect(facts, spec.key).toHaveLength(1);
      expect(facts[0]).toMatchObject({ scopes: spec.scope, type: spec.type, structural: true });
    }
  });

  it('every @size and @a11y sub-key appears, under its parent', () => {
    for (const k of SIZE_KEYS) expect(key(`size.${k}`).parent).toBe('key/size');
    for (const k of A11Y_KEYS) expect(key(`a11y.${k}`).parent).toBe('key/a11y');
    for (const fact of ref.keys) {
      if (fact.parent !== undefined) expect(key(fact.parent.slice('key/'.length)).subKeys, fact.id).toContain(fact.id);
    }
  });

  it('keys follow the canonical order: registry order, sub-keys after their parent, then structural keys', () => {
    const top = ref.keys.filter((k) => k.parent === undefined && k.structural !== true).map((k) => k.key);
    const expected = CONFIG_REGISTRY.map((row, i) => ({ row, i }))
      .sort((a, b) => a.row.order - b.row.order || a.i - b.i)
      .map(({ row }) => row.key);
    expect(top).toEqual(expected);
    const structural = ref.keys.filter((k) => k.structural === true).map((k) => k.key);
    expect(structural).toEqual(STRUCTURAL_KEYS.map((k) => k.key));
    expect(ref.keys.slice(-structural.length).every((k) => k.structural === true)).toBe(true);
    for (const [i, fact] of ref.keys.entries()) {
      if (fact.parent === undefined) continue;
      const parentAt = ref.keys.findIndex((k) => k.id === fact.parent);
      expect(parentAt, fact.id).toBeLessThan(i);
      expect(ref.keys.slice(parentAt + 1, i).every((k) => k.parent === fact.parent), fact.id).toBe(true);
    }
  });

  it('every style property appears, in REGISTRY order, with its enum', () => {
    expect(ref.styles.map((s) => s.name)).toEqual(REGISTRY.map((p) => p.name));
    for (const p of REGISTRY) {
      const s = byId(ref.styles, `style/${p.name}`);
      expect(s).toMatchObject({ affects: p.affects, type: p.type, appliesTo: p.appliesTo, inherits: p.inherits });
      if (p.enum !== undefined) expect(s.values).toEqual(p.enum);
      if (p.type === 'dash') expect(s.values).toEqual(Object.keys(DASH_PATTERNS).sort());
    }
  });

  it('style defaults equal the default theme\'s rules, role by role', () => {
    const rules = BUILT_IN[DEFAULT_THEME_ID]!.rules;
    for (const s of ref.styles) {
      const expected = Object.keys(rules)
        .sort()
        .filter((role) => rules[role]![s.name] !== undefined)
        .map((role) => role);
      expect(s.defaults.map((d) => d.role), s.name).toEqual(expected);
    }
  });

  it('every shape appears; drawn equals DRAWABLE_SHAPES', () => {
    expect(ref.shapes.map((s) => s.name)).toEqual([...LANGUAGE_SHAPES]);
    for (const s of ref.shapes) expect(s.drawn, s.name).toBe(DRAWABLE_SHAPES.has(s.name));
  });

  it('every engine, option and hint appears; each option default equals the descriptor\'s', () => {
    expect(ref.engines.map((e) => e.engineId)).toEqual(REGISTERED_ENGINES.map((e) => e.id));
    for (const reg of REGISTERED_ENGINES) {
      const fact = engine(bareName(reg.id));
      expect(fact.capabilities).toEqual(reg.capabilities);
      const options = schemaProps(reg.optionsSchema);
      expect(fact.options.map((o) => o.name)).toEqual(Object.keys(options));
      for (const [name, schema] of Object.entries(options)) {
        const o = byId(fact.options, `option/${fact.bareName}.${name}`);
        if ('default' in schema) expect(o.default, o.id).toEqual(schema['default']);
        else expect(o.default, o.id).toBeUndefined();
      }
      expect(fact.hints.map((h) => h.name)).toEqual(Object.keys(schemaProps(reg.hintsSchema)));
    }
    for (const [name, value] of Object.entries(elkDescriptor.defaults)) {
      expect(byId(engine('elk').options, `option/elk.${name}`).default).toEqual(value);
    }
  });

  it('every built-in theme appears; the token table equals resolveTheme over BUILT_IN', () => {
    const ids = Object.keys(BUILT_IN).sort();
    expect(ref.themes.map((t) => t.themeId)).toEqual(ids);
    const names = new Set<string>();
    for (const id of ids) {
      const { value, diagnostics } = resolveTheme(BUILT_IN[id]!, (x) => BUILT_IN[x]);
      expect(diagnostics).toEqual([]);
      for (const [name, v] of Object.entries(value.tokens)) {
        names.add(name);
        expect(byId(ref.tokens, `token/${name}`).values[id], `${id} ${name}`).toBe(Array.isArray(v) ? v.join(' ') : String(v));
      }
    }
    expect(ref.tokens.map((t) => t.name)).toEqual([...names].sort());
    for (const t of ref.tokens) expect(Object.keys(t.values)).toEqual(ids);
  });

  it('every catalogue code appears once, sorted; the count is CATALOGUE plus IMPORT_CATALOGUE', () => {
    const codes = [...Object.keys(CATALOGUE), ...Object.keys(IMPORT_CATALOGUE)].sort();
    expect(ref.diagnostics.map((d) => d.code)).toEqual(codes);
    for (const d of ref.diagnostics) {
      const row = (CATALOGUE as Record<string, { severity: string; template: string }>)[d.code] ?? (IMPORT_CATALOGUE as Record<string, { severity: string; template: string }>)[d.code];
      expect(d).toMatchObject({ severity: row!.severity, template: row!.template });
    }
  });

  it('no two facts share an id, and every id is <kind>/<name>', () => {
    const all = [
      ...ref.keys,
      ...ref.styles,
      ...ref.shapes,
      ...ref.engines,
      ...ref.engines.flatMap((e) => [...e.options, ...e.hints]),
      ...ref.themes,
      ...ref.tokens,
      ...ref.diagnostics,
    ].map((f) => f.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^(key|style|shape|engine|option|hint|theme|token|diag)\/\S+$/);
  });
});

describe('buildReference: determinism and immutability', () => {
  it('two builds are identical', () => {
    expect(JSON.stringify(buildReference(REGISTERED_ENGINES))).toBe(JSON.stringify(buildReference(REGISTERED_ENGINES)));
  });

  it('the output is deeply frozen', () => {
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.isFrozen(ref.keys)).toBe(true);
    expect(Object.isFrozen(ref.keys[0])).toBe(true);
    expect(Object.isFrozen(ref.engines[0]!.options)).toBe(true);
    expect(Object.isFrozen(ref.engines[0]!.capabilities)).toBe(true);
    expect(Object.isFrozen(ref.tokens[0]!.values)).toBe(true);
  });

  it('building freezes its own output, never the source tables it reads', () => {
    expect(Object.isFrozen(CONFIG_REGISTRY.find((row) => row.key === 'shape')!.enum)).toBe(false);
    expect(Object.isFrozen(CONFIG_REGISTRY[0]!.scope)).toBe(false);
    expect(Object.isFrozen(REGISTRY.find((p) => p.name === 'arrowhead')!.enum)).toBe(false);
    expect(Object.isFrozen(REGISTERED_ENGINES[0]!.capabilities)).toBe(false);
  });

  it('the engine list is the caller\'s: an engine with no schemas has no options or hints', () => {
    const only = buildReference([{ id: 'x.custom', name: 'Custom', capabilities: elkDescriptor.capabilities }]);
    expect(only.engines).toEqual([
      expect.objectContaining({ id: 'engine/x.custom', engineId: 'x.custom', bareName: 'x.custom', options: [], hints: [] }),
    ]);
    expect(key('layout.engine').values).toEqual(REGISTERED_ENGINES.map((e) => bareName(e.id)));
    expect(only.keys.find((k) => k.id === 'key/layout.engine')?.values).toEqual(['x.custom']);
  });
});
