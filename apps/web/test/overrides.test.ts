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

  it('K2: an @layout: { engine: "..." } object entry is edited in place, not duplicated', () => {
    const source = '@layout: { engine: "sgl.grid", direction: right }\na: "A"\n';
    const { ast } = parse(source);
    const change = setRootConfigString(ast, ['layout', 'engine'], 'sgl.elk');
    const applied = source.slice(0, change.from) + change.insert + source.slice(change.to);
    expect(applied).toBe('@layout: { engine: "sgl.elk", direction: right }\na: "A"\n');
    expect(documentEngineOverride(modelOf(applied))).toBe('sgl.elk');

    // K2's actual point: no duplicate-key diagnostic — the app's own picker
    // action must never make the user's document emit one.
    const { model, diagnostics } = resolve(parse(applied).ast);
    expect(diagnostics).toEqual([]);
    void model;
  });

  it('K2: with neither a dotted nor an object entry, only one new line is inserted (no duplication on a second write)', () => {
    const source = 'a: "A"\n';
    const { ast: ast1 } = parse(source);
    const change1 = setRootConfigString(ast1, ['layout', 'engine'], 'sgl.grid');
    const applied1 = source.slice(0, change1.from) + change1.insert + source.slice(change1.to);
    expect(applied1).toBe('@layout.engine: "sgl.grid"\na: "A"\n');

    // Writing again finds the entry it just created and edits it in place.
    const { ast: ast2 } = parse(applied1);
    const change2 = setRootConfigString(ast2, ['layout', 'engine'], 'sgl.elk');
    const applied2 = applied1.slice(0, change2.from) + change2.insert + applied1.slice(change2.to);
    expect(applied2).toBe('@layout.engine: "sgl.elk"\na: "A"\n');
    const { diagnostics } = resolve(parse(applied2).ast);
    expect(diagnostics).toEqual([]);
  });
});
