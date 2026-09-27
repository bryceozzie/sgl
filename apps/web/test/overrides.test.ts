import { compile, parse, resolve } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { documentEngineOverride, documentThemeOverride } from '../src/state/overrides.js';
import { setRootConfigString } from '../src/state/root-config-edit.js';

function modelOf(source: string) {
  const { ast } = parse(source);
  const { model } = resolve(ast);
  return model;
}

describe('documentThemeOverride / documentEngineOverride (DD-08 §10)', () => {
  it('undefined when the document sets neither', () => {
    const model = modelOf('a: "A"');
    expect(documentThemeOverride(model)).toBeUndefined();
    expect(documentEngineOverride(model)).toBeUndefined();
  });

  it('reads @theme', () => {
    expect(documentThemeOverride(modelOf('@theme: "neutral-dark"\na: "A"'))).toBe('neutral-dark');
  });

  it('reads @layout.engine (dotted form)', () => {
    expect(documentEngineOverride(modelOf('@layout.engine: "sgl.grid"\na: "A"'))).toBe('sgl.grid');
  });

  it('reads @layout: { engine: "..." } (object form)', () => {
    expect(documentEngineOverride(modelOf('@layout: { engine: "sgl.grid" }\na: "A"'))).toBe('sgl.grid');
  });

  it('ignores a non-string engine value rather than throwing', () => {
    expect(documentEngineOverride(modelOf('@layout: { engine: 5 }\na: "A"'))).toBeUndefined();
  });

  describe('bare engine names (DD-12 N22)', () => {
    const REGISTERED = new Set(['sgl.elk', 'sgl.grid']);
    const known = (id: string): boolean => REGISTERED.has(id);
    const engineOf = (source: string) => documentEngineOverride(modelOf(source), known);

    it('a bare name maps to the registered `sgl.*` id, quoted or not, in either spelling', () => {
      expect(engineOf('@layout: { engine: grid }\na: "A"')).toBe('sgl.grid');
      expect(engineOf('@layout: { engine: "elk" }\na: "A"')).toBe('sgl.elk');
      expect(engineOf('@layout.engine: elk\na: "A"')).toBe('sgl.elk');
    });

    it('a full id is passed through unchanged', () => {
      expect(engineOf('@layout: { engine: "sgl.grid" }\na: "A"')).toBe('sgl.grid');
    });

    it('a bare name whose `sgl.*` engine is not registered is passed through, as an unknown id is (SGL4011)', () => {
      expect(engineOf('@layout: { engine: fixed }\na: "A"')).toBe('fixed');
      expect(engineOf('@layout: { engine: "org.example.x" }\na: "A"')).toBe('org.example.x');
    });

    it('`layered` is not an alias for `elk` (H7)', () => {
      expect(engineOf('@layout: { engine: "layered" }\na: "A"')).toBe('layered');
    });

    it('a registered id wins over the `sgl.` mapping', () => {
      const withBare = (id: string): boolean => id === 'grid' || id === 'sgl.grid';
      expect(documentEngineOverride(modelOf('@layout: { engine: grid }\na: "A"'), withBare)).toBe('grid');
    });
  });
});


/** Applies `setRootConfigString`'s change to `source`, the way the picker's
 *  transaction does. */
function write(source: string, keyPath: readonly string[], value: string): string {
  const change = setRootConfigString(parse(source).ast, source, keyPath, value);
  return source.slice(0, change.from) + change.insert + source.slice(change.to);
}

/** Every diagnostic the whole front end (parse, resolve, compile) emits. */
function allDiagnostics(source: string): readonly string[] {
  const parsed = parse(source);
  const resolved = resolve(parsed.ast);
  const compiled = compile(resolved.model);
  return [...parsed.diagnostics, ...resolved.diagnostics, ...compiled.diagnostics].map((d) => d.code);
}

describe('setRootConfigString (DD-08 §10)', () => {
  describe('@theme', () => {
    it('none: inserts one new line at the start', () => {
      const source = 'a: "A"\n';
      expect(setRootConfigString(parse(source).ast, source, ['theme'], 'neutral-dark')).toEqual({ from: 0, to: 0, insert: '@theme: "neutral-dark"\n' });
      expect(documentThemeOverride(modelOf(write(source, ['theme'], 'neutral-dark')))).toBe('neutral-dark');
    });

    it('existing string entry: replaces only its value span', () => {
      const applied = write('@theme: "neutral-light"\na: "A"\n', ['theme'], 'neutral-dark');
      expect(applied).toBe('@theme: "neutral-dark"\na: "A"\n');
      expect(documentThemeOverride(modelOf(applied))).toBe('neutral-dark');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('existing bareword entry: replaced in place too, not shadowed by a second entry', () => {
      const applied = write('@theme: dark\na: "A"\n', ['theme'], 'neutral-dark');
      expect(applied).toBe('@theme: "neutral-dark"\na: "A"\n');
      expect(allDiagnostics(applied)).toEqual([]);
    });
  });

  describe('@layout.engine — all three shapes: none, dotted, object', () => {
    it('none: inserts one dotted line at the start; a second write edits it rather than adding another', () => {
      const once = write('a: "A"\n', ['layout', 'engine'], 'sgl.grid');
      expect(once).toBe('@layout.engine: "sgl.grid"\na: "A"\n');
      const twice = write(once, ['layout', 'engine'], 'sgl.elk');
      expect(twice).toBe('@layout.engine: "sgl.elk"\na: "A"\n');
      expect(documentEngineOverride(modelOf(twice))).toBe('sgl.elk');
      expect(allDiagnostics(twice)).toEqual([]);
    });

    it('dotted: replaces the existing value span', () => {
      const applied = write('@layout.engine: "sgl.grid"\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout.engine: "sgl.elk"\na: "A"\n');
      expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('object with an engine property: edits the property in place', () => {
      const applied = write('@layout: { engine: "sgl.grid", direction: right }\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout: { engine: "sgl.elk", direction: right }\na: "A"\n');
      expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('object with a bareword engine: edits the property in place', () => {
      const applied = write('@layout: { engine: grid }\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout: { engine: "sgl.elk" }\na: "A"\n');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('object without an engine property (one line): adds the property to that object, no second @layout entry', () => {
      const applied = write('@layout: { direction: right }\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout: { engine: "sgl.elk", direction: right }\na: "A"\n');
      expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('object without an engine property (multi-line): adds it on its own line with the same indentation', () => {
      const applied = write('@layout: {\n  direction: right\n}\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout: {\n  engine: "sgl.elk"\n  direction: right\n}\na: "A"\n');
      expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('empty object: fills it', () => {
      const applied = write('@layout: {}\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout: { engine: "sgl.elk" }\na: "A"\n');
      expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
      expect(allDiagnostics(applied)).toEqual([]);
    });

    it('set twice (object, then dotted): edits the later one, which is the one that wins', () => {
      const applied = write('@layout: { engine: "x" }\n@layout.engine: "sgl.grid"\na: "A"\n', ['layout', 'engine'], 'sgl.elk');
      expect(applied).toBe('@layout: { engine: "x" }\n@layout.engine: "sgl.elk"\na: "A"\n');
      expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
    });
  });
});
