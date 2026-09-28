import { beforeAll, describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import type { ConfigBag, ContainerModel, DocumentModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { fromJson, toJson } from '../src/json.js';
import { resolve } from '../src/resolve.js';

/**
 * A8 fix round 1: variables under hostile or unusual input — exponential
 * expansion, huge strings, many scopes — and the rules language spec §5
 * states for redeclaration, recovery and dropped values.
 */

const resolveSrc = (src: string) => resolve(parse(src).ast);
const codes = (src: string): string[] => resolveSrc(src).diagnostics.map((d) => d.code);

function node(model: DocumentModel, ...path: string[]): ContainerModel {
  let cur = model.root;
  for (const key of path) {
    const next = cur.children.find((c) => c.key === key);
    if (next === undefined) throw new Error(`no child ${key}`);
    cur = next;
  }
  return cur;
}

/** The fastest of three runs of `resolve()` alone, in ms of CPU time (parse
 *  excluded; a warm-up run first). CPU time (process.cpuUsage), not wall
 *  time, so a machine busy with other suites does not inflate it (07 §2). */
function timeResolve(input: string | ReturnType<typeof parse>['ast']): { ms: number; result: ReturnType<typeof resolve> } {
  const ast = typeof input === 'string' ? parse(input).ast : input;
  let best = Number.POSITIVE_INFINITY;
  let result = resolve(ast);
  for (let i = 0; i < 3; i += 1) {
    const t0 = process.cpuUsage();
    result = resolve(ast);
    const { user, system } = process.cpuUsage(t0);
    best = Math.min(best, (user + system) / 1000);
  }
  return { ms: best, result };
}

const arrayChain = (n: number): string =>
  Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 'v0: 1' : `v${i}: [$v${i - 1}, $v${i - 1}]`)).join(', ');
const stringChain = (n: number): string =>
  Array.from({ length: n + 1 }, (_, i) => (i === 0 ? 's0: "ab"' : `s${i}: "\${s${i - 1}}\${s${i - 1}}"`)).join(', ');

describe('item 1: exponential expansion is bounded', () => {
  it('a declared-but-unused doubling chain costs nothing (n = 40, array form)', () => {
    const { ms, result } = timeResolve(`@vars: { ${arrayChain(40)} }\na\n`);
    expect(result.diagnostics).toEqual([]);
    expect(ms).toBeLessThan(50);
  });

  it('a used doubling chain stops at the budget with one SGL2016 (n = 40, array form)', () => {
    const { ms, result } = timeResolve(`@vars: { ${arrayChain(40)} }\na: { @meta: $v40 }\nb: { @meta: $v40 }\n`);
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([['SGL2016', 'error']]);
    expect('meta' in node(result.model, 'a').config).toBe(false);
    expect('meta' in node(result.model, 'b').config).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it('the string form stops at the budget too (n = 40)', () => {
    const { ms, result } = timeResolve(`@vars: { ${stringChain(40)} }\na: { @label: $s40 }\n`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['SGL2016']);
    expect('label' in node(result.model, 'a').config).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it('2^12 elements used 2 000 times hits the cap once; the uses before it keep their value', () => {
    const uses = Array.from({ length: 2000 }, (_, i) => `n${i}: { @meta: $v12 }`).join('\n');
    const { model, diagnostics } = resolveSrc(`@vars: { ${arrayChain(12)} }\n${uses}\n`);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2016']);
    expect(node(model, 'n0').config.meta).toHaveLength(2);
    expect('meta' in node(model, 'n1999').config).toBe(false);
  });

  it('a document well inside the budget is unaffected: every use of a big variable substitutes', () => {
    const uses = Array.from({ length: 100 }, (_, i) => `n${i}: { @meta: $v10 }`).join('\n');
    const { model, diagnostics } = resolveSrc(`@vars: { ${arrayChain(10)} }\n${uses}\n`);
    expect(diagnostics).toEqual([]);
    expect(JSON.stringify(node(model, 'n99').config.meta)).toBe(JSON.stringify(node(model, 'n0').config.meta));
  });

  it('the budget counts per document: canonical JSON keeps the references as written', () => {
    const src = `@vars: { ${arrayChain(30)} }\na: { @meta: $v30 }\n`;
    const { model } = resolveSrc(src);
    const again = fromJson(toJson(model));
    expect(again.diagnostics.map((d) => d.code)).toEqual(['SGL2016']);
    expect(toJson(again.model)).toBe(toJson(model));
    expect(toJson(model)).toContain('"@meta": "$v30"');
  });
});

describe('item 2: string doubling never throws', () => {
  it('n = 28 reports SGL2016 instead of a RangeError', () => {
    expect(() => resolveSrc(`@vars: { ${stringChain(28)} }\na: { @label: "x\${s28}" }\n`)).not.toThrow();
    expect(codes(`@vars: { ${stringChain(28)} }\na: { @label: "x\${s28}" }\n`)).toEqual(['SGL2016']);
  });
});

describe('item 3: many scopes over many variables', () => {
  // A scope is its own entries plus a pointer to its parent's (`VarScope`);
  // the regression is a scope that copies every enclosing variable, 5 000 ×
  // 20 000 map entries. Hardened for a loaded machine (07 §2): the source is
  // built and parsed in `beforeAll` (~1 s, outside the timed region and the
  // test's timeout) and `resolve()` is timed in CPU time, best of three.
  // Linear is ~90–100 ms; with the copy reintroduced as a mutation it took
  // ~12.6 s, so 1 s (was 500 ms of wall time) still catches it.
  let ast: ReturnType<typeof parse>['ast'];
  beforeAll(() => {
    const vars = Array.from({ length: 20_000 }, (_, i) => `r${i}: ${i}`).join(', ');
    const siblings = Array.from({ length: 5_000 }, (_, i) => `c${i}: { @vars: { x: ${i} }, @order: $x, @meta: { r: $r${i} } }`).join('\n');
    ast = parse(`@vars: { ${vars} }\n${siblings}\n`).ast;
  }, 60_000);

  it('20 000 root variables and 5 000 scoped siblings resolve in under 1 s of CPU time', () => {
    const { ms, result } = timeResolve(ast);
    expect(result.diagnostics).toEqual([]);
    expect(node(result.model, 'c4999').config.order).toBe(4999);
    expect(node(result.model, 'c4999').config.meta).toEqual({ r: 4999 });
    expect(ms).toBeLessThan(1000);
  }, 60_000);
});

describe('item 6: redeclared @vars merge like any config', () => {
  it('later wins key by key, and the merged block applies to every declaration', () => {
    const { model, diagnostics } = resolveSrc('a: { @vars: { x: 1, y: $x } }\na: { @vars: { x: 2 }, @order: $y }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2005']);
    expect(node(model, 'a').config.order).toBe(2);
  });

  it('order within the block is order of first appearance across the declarations', () => {
    expect(codes('a: { @vars: { y: 1 } }\na: { @vars: { x: $y }, @order: $x }\n')).toEqual(['SGL2005']);
    expect(codes('a: { @vars: { x: $y } }\na: { @vars: { y: 1 }, @order: $x }\n')).toEqual(['SGL2005', 'SGL2014']);
  });
});

describe('item 7: rules spec §5 states', () => {
  it('the node shorthand `b: $c` is a syntax error; recovery takes the next line`s key as a class reference', () => {
    const src = '@vars: { c: "x" }\nb: $c\nd: "D"\ne\n';
    const { ast, diagnostics: parseDiags } = parse(src);
    const { model, diagnostics } = resolve(ast);
    expect([...parseDiags, ...diagnostics].map((d) => d.code)).toEqual(['SGL1002', 'SGL1002', 'SGL2002']);
    expect(model.root.children.map((c) => c.key)).toEqual(['b', 'D', 'e']);
  });

  it('variable names are ASCII identifiers', () => {
    expect(codes('@vars: { "é": 1, ok: 1 }\n')).toEqual(['SGL2011']);
  });

  it('a number interpolates as String(n), exponent forms included', () => {
    const { model } = resolveSrc('@vars: { tiny: 0.0000001, big: 1000000000000000000000, n: -0.5 }\na: { @label: "${tiny} ${big} ${n}" }\n');
    expect(node(model, 'a').config.label).toBe(`${String(1e-7)} ${String(1e21)} -0.5`);
    expect(node(model, 'a').config.label).toBe('1e-7 1e+21 -0.5');
  });

  it('a @vars value is resolved in its declaring scope, not where it is used', () => {
    const { model, diagnostics } = resolveSrc('@vars: { a: 1, b: $a }\nx: { @vars: { a: 2 }, @order: $b }\n');
    expect(diagnostics).toEqual([]);
    expect(node(model, 'x').config.order).toBe(1);
  });

  it('`@vars: $o` is SGL2011', () => {
    expect(codes('@vars: $o\n')).toEqual(['SGL2011']);
    expect(codes('a: { @vars: $o }\n')).toEqual(['SGL2011']);
  });

  it('a dropped nested property leaves its parent object in place', () => {
    const { model } = resolveSrc('a: { @meta: { o: { p: $nope }, q: 1 } }\n');
    expect(node(model, 'a').config.meta).toEqual({ o: {}, q: 1 });
  });
});

describe('item 8: gaps the mutants found', () => {
  it('substitutes a reference nested two and three levels deep', () => {
    const { model } = resolveSrc('@vars: { v: 7 }\na: { @meta: { x: { y: $v, z: { w: [$v] } } } }\n');
    expect(node(model, 'a').config.meta).toEqual({ x: { y: 7, z: { w: [7] } } });
  });

  it('two uses of one object variable never share an object', () => {
    const { model } = resolveSrc('@vars: { o: { k: [1] } }\na: { @meta: $o }\nb: { @meta: $o }\n');
    ((node(model, 'a').config.meta as ConfigBag).k as number[]).push(2);
    expect(node(model, 'b').config.meta).toEqual({ k: [1] });
  });

  it('a chain `a -> b -> c: { … $nope }` reports SGL2013 exactly once', () => {
    expect(codes('a\nb\nc\na -> b -> c: { @meta: $nope }\n')).toEqual(['SGL2013']);
  });
});

describe('item 9: a JSON edge endpoint that is not a path', () => {
  const src = '{ "a": {}, "b": {}, "@edges": [ { "from": "$a", "to": "b" } ] }';

  it('is SGL2001 naming the text as written, and the edge is skipped', () => {
    const { model } = resolveSrc(src);
    const { graph, diagnostics } = compile(model);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2001']);
    expect(diagnostics[0]?.message).toContain('`$a`');
    expect(graph.edges).toEqual([]);
  });

  it('keeps the original text through canonical JSON', () => {
    const json = toJson(resolveSrc(src).model);
    expect(json).toContain('"from": "$a"');
    expect(toJson(fromJson(json).model)).toBe(json);
  });
});
