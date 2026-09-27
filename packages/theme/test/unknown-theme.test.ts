import { parse, resolve, type Diagnostic } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { unknownThemeDiagnostics } from '../src/document-theme.js';
import { BUILT_IN } from '../src/themes/index.js';

/**
 * F31 (human decision 2026-09-27): a document's `@theme` that names no
 * built-in theme is `SGL5007`, a warning at the `@theme` key, and the
 * document still draws in the default theme (the callers' fallback, which
 * this does not change).
 */

function check(source: string): { readonly source: string; readonly diagnostics: readonly Diagnostic[]; readonly resolved: readonly Diagnostic[] } {
  const { ast } = parse(source);
  const { model, diagnostics: resolved } = resolve(ast);
  return { source, diagnostics: unknownThemeDiagnostics(ast, model), resolved };
}

describe('SGL5007: an unknown @theme name (F31)', () => {
  it.each(Object.keys(BUILT_IN).sort())('a known theme, %s, is not warned about', (id) => {
    expect(check(`@theme: "${id}"\na\n`).diagnostics).toEqual([]);
    expect(check(`@theme: ${id}\na\n`).diagnostics).toEqual([]); // the unquoted word too
  });

  it('a document with no @theme is not warned about', () => {
    expect(check('a -> b\n').diagnostics).toEqual([]);
    expect(check('').diagnostics).toEqual([]);
  });

  it('a typo is one warning at the @theme key, naming the unknown name', () => {
    const { source, diagnostics } = check('a\n@theme: "neutral-drak"\nb\n');
    expect(diagnostics).toEqual([
      { code: 'SGL5007', severity: 'warning', message: 'Unknown theme `neutral-drak`; using the default.', span: diagnostics[0]!.span },
    ]);
    expect(source.slice(diagnostics[0]!.span.from, diagnostics[0]!.span.to)).toBe('@theme');
  });

  it('declared twice, the last entry is the one in force, and the one warned about', () => {
    const source = '@theme: "neutral-dark"\n@theme: "nope"\n';
    const { diagnostics } = check(source);
    expect(diagnostics.map((d) => [d.code, d.span.from])).toEqual([['SGL5007', source.lastIndexOf('@theme')]]);
    // and the other way round: the last one is known, so nothing
    expect(check('@theme: "nope"\n@theme: "neutral-dark"\n').diagnostics).toEqual([]);
  });

  it('a name only an Object property has (not a built-in theme) is unknown too', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(check(`@theme: "${name}"\n`).diagnostics.map((d) => d.code), name).toEqual(['SGL5007']);
    }
  });

  it('case and whitespace are not forgiven: the lookup is exact', () => {
    expect(check('@theme: "Neutral-Dark"\n').diagnostics.map((d) => d.message)).toEqual(['Unknown theme `Neutral-Dark`; using the default.']);
    expect(check('@theme: "neutral-dark "\n').diagnostics.map((d) => d.code)).toEqual(['SGL5007']);
  });

  it('a $variable is checked by the name it substitutes to, at the key', () => {
    const source = '@vars: { t: "neon" }\n@theme: $t\n';
    const { diagnostics } = check(source);
    expect(diagnostics.map((d) => [d.message, source.slice(d.span.from, d.span.to)])).toEqual([['Unknown theme `neon`; using the default.', '@theme']]);
    expect(check('@vars: { t: "print" }\n@theme: $t\n').diagnostics).toEqual([]);
  });

  it('a @theme that is not a string is the resolver\'s SGL2011, not this', () => {
    const { diagnostics, resolved } = check('@theme: 42\n');
    expect(diagnostics).toEqual([]);
    expect(resolved.map((d) => d.code)).toEqual(['SGL2011']);
  });

  it('a @theme on a node is the resolver\'s SGL2012 (root only), not this', () => {
    const { diagnostics, resolved } = check('a: { @theme: "nope" }\n');
    expect(diagnostics).toEqual([]);
    expect(resolved.map((d) => d.code)).toEqual(['SGL2012']);
  });
});
