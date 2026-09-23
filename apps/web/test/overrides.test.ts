import { parse, resolve } from '@sgl/core';
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
});

describe('setRootConfigString (DD-08 §10)', () => {
  it('inserts a new line at the start when no entry exists', () => {
    const source = 'a: "A"\n';
    const { ast } = parse(source);
    const change = setRootConfigString(ast, ['theme'], 'neutral-dark');
    expect(change).toEqual({ from: 0, to: 0, insert: '@theme: "neutral-dark"\n' });
  });

  it('replaces only the value span of an existing string entry', () => {
    const source = '@theme: "neutral-light"\na: "A"\n';
    const { ast } = parse(source);
    const change = setRootConfigString(ast, ['theme'], 'neutral-dark');
    const applied = source.slice(0, change.from) + change.insert + source.slice(change.to);
    expect(applied).toBe('@theme: "neutral-dark"\na: "A"\n');
  });

  it('the applied change round-trips through parse/resolve to the new override', () => {
    const source = '@theme: "neutral-light"\na: "A"\n';
    const { ast } = parse(source);
    const change = setRootConfigString(ast, ['theme'], 'neutral-dark');
    const applied = source.slice(0, change.from) + change.insert + source.slice(change.to);
    expect(documentThemeOverride(modelOf(applied))).toBe('neutral-dark');
  });

  it('a dotted @layout.engine entry is replaced precisely, not duplicated', () => {
    const source = '@layout.engine: "sgl.grid"\na: "A"\n';
    const { ast } = parse(source);
    const change = setRootConfigString(ast, ['layout', 'engine'], 'sgl.elk');
    const applied = source.slice(0, change.from) + change.insert + source.slice(change.to);
    expect(applied).toBe('@layout.engine: "sgl.elk"\na: "A"\n');
    expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');
  });
});
