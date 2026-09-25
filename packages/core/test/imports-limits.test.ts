import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../src/diagnostics.js';
import { createImportLinker } from '../src/imports.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';
import { memoryHost } from './import-host.js';

/**
 * A9's caps and cycles (DD-02 §10.4, I19–I21): only relative paths, cycles
 * skipped, depth 8, 64 import instances and 2 Mi code units of imported
 * source per root resolve, and one variable-expansion budget for the whole
 * closure. Closure-wide problems (a cycle, a cap) are reported on the root
 * document, at the `@imports` item they were reached through.
 */

function run(main: string, docs: Record<string, string>): readonly Diagnostic[] {
  const linker = createImportLinker(memoryHost(docs), { self: 'main' });
  return resolve(parse(main).ast, { imports: linker }).diagnostics;
}
const codes = (diags: readonly Diagnostic[]): string[] => diags.map((d) => d.code);

describe('only relative paths (I19): SGL2025, and the import is skipped', () => {
  it.each([
    ['empty', ''],
    ['root-absolute', '/abs/lib.sgl'],
    ['backslash-absolute', '\\\\abs\\\\lib.sgl'],
    ['protocol-relative', '//host/lib.sgl'],
    ['a URL', 'https://example.com/lib.sgl'],
    ['a file URL', 'file:lib.sgl'],
    ['a drive', 'C:\\\\lib.sgl'],
    ['a drive-relative path', 'C:lib.sgl'],
  ])('%s', (_name, path) => {
    const diags = run(`@imports: ["${path}"]\nn: Lib\n`, { lib: '@classes: { Lib: {} }' });
    expect(diags.map((d) => [d.code, d.severity])).toEqual([
      ['SGL2025', 'warning'],
      ['SGL2024', 'warning'],
    ]);
  });

  it('a relative path is looked up', () => {
    expect(run('@imports: ["lib.sgl", "./lib", "../x/lib.SGL"]\n', { lib: '' })).toEqual([]);
  });
});

describe('cycles (I20): SGL2019 naming the chain, and that import skipped', () => {
  it('a document that imports itself', () => {
    const diags = run('@imports: ["./main.sgl"]\n', { main: '' });
    expect(codes(diags)).toEqual(['SGL2019']);
    expect(diags[0]?.message).toBe('`./main.sgl` imports itself via `this document -> ./main.sgl`; this import was skipped.');
  });

  it('two documents that import each other', () => {
    const main = '@imports: ["./b.sgl"]\n';
    const diags = run(main, { main, b: '@imports: ["./main.sgl"]\n' });
    expect(codes(diags)).toEqual(['SGL2019']);
    expect(diags[0]?.message).toBe('`./main.sgl` imports itself via `this document -> ./b.sgl -> ./main.sgl`; this import was skipped.');
    expect(diags[0]?.span).toEqual({ from: 11, to: 20 });
  });

  it('a long cycle that does not pass through the root', () => {
    const docs: Record<string, string> = {};
    for (let i = 1; i <= 6; i += 1) docs[`d${i}`] = `@imports: ["./d${i === 6 ? 2 : i + 1}.sgl"]\n`;
    const diags = run('@imports: ["./d1.sgl"]\n', docs);
    expect(codes(diags)).toEqual(['SGL2019']);
    expect(diags[0]?.message).toContain('`./d2.sgl -> ./d3.sgl -> ./d4.sgl -> ./d5.sgl -> ./d6.sgl -> ./d2.sgl`');
  });

  it('a diamond is not a cycle', () => {
    const diags = run('@imports: [{ path: "./b.sgl", as: b }, { path: "./c.sgl", as: c }]\n', {
      b: '@imports: ["./d.sgl"]\n',
      c: '@imports: ["./d.sgl"]\n',
      d: '@classes: { D: {} }\n',
    });
    expect(diags).toEqual([]);
  });
});

/** `n` documents in a chain, each importing the next. */
function chain(n: number): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let i = 1; i <= n; i += 1) docs[`c${i}`] = i < n ? `@imports: ["./c${i + 1}.sgl"]\n@classes: { C${i}: {} }\n` : `@classes: { C${i}: {} }\n`;
  return docs;
}

describe('caps (I21): the import that would cross one is skipped, with one SGL2020 per cap', () => {
  it('depth 8 passes and depth 9 does not', () => {
    expect(run('@imports: ["./c1.sgl"]\nn: C8\n', chain(8))).toEqual([]);
    const diags = run('@imports: ["./c1.sgl"]\nn: C8\n', chain(9));
    expect(codes(diags)).toEqual(['SGL2020']);
    expect(diags[0]?.message).toBe('Importing `./c9.sgl` would go past 8 levels of imports; it was skipped.');
  });

  it('64 import instances pass and a 65th does not', () => {
    const items = (n: number): string => `@imports: [${Array.from({ length: n }, () => '"./x.sgl"').join(', ')}]\n`;
    expect(run(items(64), { x: '' })).toEqual([]);
    const diags = run(items(66), { x: '' });
    expect(codes(diags)).toEqual(['SGL2020']);
    expect(diags[0]?.message).toBe('Importing `./x.sgl` would go past 64 imported documents; it was skipped.');
  });

  it('2 Mi code units of imported source, summed per instance', () => {
    const big = `// ${'x'.repeat(1024 * 1024)}\n`;
    expect(run('@imports: ["./a.sgl"]\n', { a: big })).toEqual([]);
    const diags = run('@imports: ["./a.sgl", "./a.sgl"]\n', { a: big });
    expect(codes(diags)).toEqual(['SGL2020']);
    expect(diags[0]?.message).toBe('Importing `./a.sgl` would go past 2097152 characters of imported source; it was skipped.');
  });

  it('a diamond chain at n = 30 finishes in milliseconds, one SGL2020 per cap it reaches', () => {
    const docs: Record<string, string> = {};
    for (let i = 1; i <= 30; i += 1) docs[`d${i}`] = i < 30 ? `@imports: ["./d${i + 1}.sgl", "./d${i + 1}.sgl"]\n` : '';
    const start = performance.now();
    const diags = run('@imports: ["./d1.sgl"]\n', docs);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(diags.map((d) => d.message)).toEqual([
      'Importing `./d9.sgl` would go past 8 levels of imports; it was skipped.',
      'Importing `./d8.sgl` would go past 64 imported documents; it was skipped.',
    ]);
  });
});

describe('one variable-expansion budget for the whole closure (I21)', () => {
  /** v0 is 1 Ki characters, each next one doubles, and the class body uses
   *  v9 (512 Ki): about 1.5 Mi units, inside the budget on its own. */
  const doubling = (prefix: string): string =>
    `@vars: { ${prefix}0: "${'x'.repeat(1024)}"${Array.from({ length: 9 }, (_, i) => `, ${prefix}${i + 1}: "\${${prefix}${i}}\${${prefix}${i}}"`).join('')} }\n@classes: { ${prefix.toUpperCase()}: { @label: $${prefix}9 } }\n`;

  it('each document alone is inside the budget', () => {
    expect(resolve(parse(doubling('v')).ast).diagnostics).toEqual([]);
    expect(resolve(parse(doubling('w')).ast).diagnostics).toEqual([]);
  });

  it('together they cross it: SGL2016 on the importer, whose own expansion went past what was left', () => {
    const diags = run(`@imports: ["./lib.sgl"]\n${doubling('w')}`, { lib: doubling('v') });
    expect(diags.map((d) => [d.code, d.severity])).toEqual([['SGL2016', 'error']]);
  });
});
