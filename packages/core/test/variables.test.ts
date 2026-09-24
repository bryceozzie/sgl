import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import type { ConfigBag, ContainerModel, DocumentModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { fromJson, resolve, toJson } from '../src/resolve.js';

/**
 * A8 — variables (language spec §5, DD-02 §3.5). `$name` substitutes a whole
 * value and keeps its type; `${name}` interpolates inside a string; `@vars`
 * is lexically scoped per container, and a `@vars` entry sees enclosing
 * scopes and the entries declared before it in its own block.
 */

const resolveSrc = (src: string) => resolve(parse(src).ast);
const codes = (src: string): string[] => resolveSrc(src).diagnostics.map((d) => d.code);

function child(container: ContainerModel, ...path: string[]): ContainerModel {
  let cur = container;
  for (const key of path) {
    const next = cur.children.find((c) => c.key === key);
    if (next === undefined) throw new Error(`no child ${key}`);
    cur = next;
  }
  return cur;
}

const node = (model: DocumentModel, ...path: string[]): ContainerModel => child(model.root, ...path);

function stripSpans<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSpans) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'span' || k === 'spans') continue;
      out[k] = stripSpans(v);
    }
    return out as T;
  }
  return value;
}

describe('whole-value substitution preserves the value type', () => {
  it('substitutes a string, number, bool, object and array as themselves', () => {
    const { model, diagnostics } = resolveSrc(
      [
        '@vars: {',
        '  c: "#DC2626"',
        '  w: 3',
        '  off: true',
        '  s: { fill: "#eee", stroke: "#111" }',
        '  tags: ["x", 2]',
        '}',
        'a: {',
        '  @style.stroke: $c',
        '  @style.strokeWidth: $w',
        '  @hidden: $off',
        '  @meta: { tags: $tags }',
        '}',
        'b: { @style: $s }',
      ].join('\n'),
    );
    expect(diagnostics).toEqual([]);
    const a = node(model, 'a');
    expect(a.config.style).toEqual({ stroke: '#DC2626', strokeWidth: 3 });
    expect(a.config.hidden).toBe(true);
    expect(a.config.meta).toEqual({ tags: ['x', 2] });
    expect(node(model, 'b').config.style).toEqual({ fill: '#eee', stroke: '#111' });
  });

  it('never emits the retired SGL2009', () => {
    expect(codes('@vars: { hot: "red" }\na: { @style.stroke: $hot }\n')).toEqual([]);
  });

  it('a typed value keeps its type through validation: a number var satisfies a number key', () => {
    const { model, diagnostics } = resolveSrc('@vars: { n: 2 }\na: { @order: $n }\n');
    expect(diagnostics).toEqual([]);
    expect(node(model, 'a').config.order).toBe(2);
  });

  it('a JSON string that is exactly `$name` is the same reference (the canonical-JSON spelling)', () => {
    const { model, diagnostics } = resolveSrc('{ "@vars": { "n": 2 }, "a": { "@order": "$n" } }');
    expect(diagnostics).toEqual([]);
    expect(node(model, 'a').config.order).toBe(2);
  });
});

describe('interpolation inside strings', () => {
  it('interpolates strings, numbers and bools by their canonical text', () => {
    const { model, diagnostics } = resolveSrc(
      '@vars: { tier: "prod", n: 2.5, on: false }\napi: { @label: "API (${tier}) x${n} ${on}" }\n',
    );
    expect(diagnostics).toEqual([]);
    expect(node(model, 'api').config.label).toBe('API (prod) x2.5 false');
  });

  it('interpolates node and edge label shorthands', () => {
    const { model, diagnostics } = resolveSrc('@vars: { t: "prod" }\na: "A ${t}"\nb\na -> b: "via ${t}"\n');
    expect(diagnostics).toEqual([]);
    expect(node(model, 'a').config.label).toBe('A prod');
    expect(model.root.edges[0]?.config.label).toBe('via prod');
  });

  it('interpolating an object or array is an error, and the value is dropped, like an unknown name', () => {
    const { model, diagnostics } = resolveSrc('@vars: { o: { x: 1 }, l: [1] }\na: { @label: "[${o}|${l}]" }\nb: { @label: "${l}" }\n');
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['SGL2015', 'error'],
      ['SGL2015', 'error'],
    ]);
    expect('label' in node(model, 'a').config).toBe(false);
    expect('label' in node(model, 'b').config).toBe(false);
  });

  it('a `$` that does not start a reference is literal text', () => {
    const { model, diagnostics } = resolveSrc('a: { @label: "costs $5, ${ x }, $$" }\n');
    expect(diagnostics).toEqual([]);
    expect(node(model, 'a').config.label).toBe('costs $5, ${ x }, $$');
  });
});

describe('lexical scope', () => {
  it('a container`s own @vars shadow the parent`s, for itself, its children and its edges', () => {
    const { model, diagnostics } = resolveSrc(
      [
        '@vars: { c: "red", t: "root" }',
        'outer: {',
        '  @vars: { c: "blue" }',
        '  @label: "${c}"',
        '  inner: {',
        '    @vars: { c: "green" }',
        '    leaf: { @style.stroke: $c, @label: "${t}" }',
        '  }',
        '  x: { @style.stroke: $c }',
        '  y',
        '  x -> y: { @style.stroke: $c }',
        '}',
        'sibling: { @style.stroke: $c }',
      ].join('\n'),
    );
    expect(diagnostics).toEqual([]);
    expect(node(model, 'outer').config.label).toBe('blue');
    expect(node(model, 'outer', 'inner', 'leaf').config.style).toEqual({ stroke: 'green' });
    expect(node(model, 'outer', 'inner', 'leaf').config.label).toBe('root');
    expect(node(model, 'outer', 'x').config.style).toEqual({ stroke: 'blue' });
    expect(node(model, 'outer').edges[0]?.config.style).toEqual({ stroke: 'blue' });
    expect(node(model, 'sibling').config.style).toEqual({ stroke: 'red' });
  });

  it('a use may come before the @vars that declares it in the same container', () => {
    const { model, diagnostics } = resolveSrc('a: { @label: $t }\n@vars: { t: "late" }\n');
    expect(diagnostics).toEqual([]);
    expect(node(model, 'a').config.label).toBe('late');
  });

  it('a redeclared container sees @vars from either of its declarations', () => {
    const { model } = resolveSrc('a: { @vars: { t: "x" } }\na: { @label: $t }\n');
    expect(node(model, 'a').config.label).toBe('x');
  });

  it('class bodies substitute from the root scope', () => {
    const { model, diagnostics } = resolveSrc(
      '@vars: { hot: "#DC2626" }\n@classes: { Hot: { @style.stroke: $hot, @label: "${hot}!" } }\na: Hot\n',
    );
    expect(diagnostics).toEqual([]);
    expect(model.classes.Hot?.config).toEqual({ style: { stroke: '#DC2626' }, label: '#DC2626!' });
  });

  it('@vars is not valid on a class or an edge', () => {
    expect(codes('@classes: { K: { @vars: { a: 1 } } }\n')).toEqual(['SGL2012']);
    expect(codes('a\nb\na -> b: { @vars: { a: 1 } }\n')).toEqual(['SGL2012']);
  });
});

describe('order within a @vars block', () => {
  it('a later entry may reference an earlier one, and an enclosing scope', () => {
    const { model, diagnostics } = resolveSrc(
      [
        '@vars: { base: "#111", env: "prod" }',
        'a: {',
        '  @vars: { stroke: $base, border: { stroke: $stroke, w: 2 }, title: "${env}-${stroke}" }',
        '  @style: $border',
        '  @label: $title',
        '}',
      ].join('\n'),
    );
    expect(diagnostics).toEqual([]);
    expect(node(model, 'a').config.style).toEqual({ stroke: '#111', w: 2 });
    expect(node(model, 'a').config.label).toBe('prod-#111');
  });

  it('a reference to a later entry is an error even when an enclosing scope has the name', () => {
    const { model, diagnostics } = resolveSrc('@vars: { b: 1 }\na: { @vars: { a: $b, b: 2 }, @order: $a }\n');
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['SGL2014', 'error']]);
    expect(diagnostics[0]?.message).toBe('Variable `$b` is not declared before `a` in its `@vars` block; the value was dropped.');
    expect(node(model, 'a').config.order).toBeUndefined();
  });

  it('a self reference is an error, and the value is dropped', () => {
    const { model, diagnostics } = resolveSrc('@vars: { a: $a }\nx: { @label: $a }\n');
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['SGL2014', 'error']]);
    expect(node(model, 'x').config.label).toBeUndefined();
  });

  it('a mutual reference is an error at its first entry; the second fails with it silently', () => {
    const { model, diagnostics } = resolveSrc('@vars: { a: $b, b: "${a}" }\nx: { @label: $b }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2014']);
    expect(node(model, 'x').config.label).toBeUndefined();
  });

  it('a long reference chain and a long cycle neither overflow the stack', () => {
    const n = 20_000;
    const chain = Array.from({ length: n }, (_, i) => (i === 0 ? 'v0: 1' : `v${i}: $v${i - 1}`)).join(', ');
    const ok = resolveSrc(`@vars: { ${chain} }\nx: { @order: $v${n - 1} }\n`);
    expect(ok.diagnostics).toEqual([]);
    expect(node(ok.model, 'x').config.order).toBe(1);

    // Every entry but the last refers forward, and each forward reference is
    // its own error; the last refers back to a failed `v0`, silently.
    const cycle = Array.from({ length: n }, (_, i) => `v${i}: $v${(i + 1) % n}`).join(', ');
    const bad = resolveSrc(`@vars: { ${cycle} }\n`);
    expect(bad.diagnostics).toHaveLength(n - 1);
    expect(new Set(bad.diagnostics.map((d) => d.code))).toEqual(new Set(['SGL2014']));
  });

  it('a variable name must be an identifier (an integer-like name could never be referenced)', () => {
    expect(codes('@vars: { "1": 2, ok: 1 }\n')).toEqual(['SGL2011']);
  });

  it('@vars that is not an object is SGL2011', () => {
    expect(codes('@vars: 5\n')).toEqual(['SGL2011']);
  });
});

describe('unknown variables', () => {
  it('an undeclared name is an error and the value is dropped, as if the key were absent', () => {
    const { model, diagnostics } = resolveSrc('a: { @label: $missing, @style: { stroke: $missing, fill: "red" } }\n');
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['SGL2013', 'error'],
      ['SGL2013', 'error'],
    ]);
    const a = node(model, 'a');
    expect('label' in a.config).toBe(false);
    expect(a.config.style).toEqual({ fill: 'red' });
  });

  it('an unknown name inside an interpolation drops the whole string', () => {
    const { model, diagnostics } = resolveSrc('a: { @label: "x ${missing}" }\n');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2013']);
    expect('label' in node(model, 'a').config).toBe(false);
  });

  it('a variable is not visible outside the container that declares it', () => {
    expect(codes('a: { @vars: { t: 1 } }\nb: { @order: $t }\n')).toEqual(['SGL2013']);
  });

  it('SGL2013 spans the reference', () => {
    const src = 'a: { @label: $missing }\n';
    const [d] = resolveSrc(src).diagnostics;
    expect(src.slice(d?.span.from, d?.span.to)).toBe('$missing');
  });
});

describe('keys, paths and names are never substituted', () => {
  it('a quoted key spelled like a variable is a literal node name', () => {
    const { model, diagnostics } = resolveSrc('@vars: { c: "x" }\n"$c": { @label: $c }\n"${c}"\n"$c" -> "${c}"\n');
    expect(diagnostics).toEqual([]);
    expect(model.root.children.map((c) => c.key)).toEqual(['$c', '${c}']);
    expect(node(model, '$c').config.label).toBe('x');
    const { graph, diagnostics: compileDiags } = compile(model);
    expect(compileDiags).toEqual([]);
    expect(graph.edges.map((e) => [e.from.node, e.to.node])).toEqual([['$c', '${c}']]);
  });

  it('an object property key spelled like a variable is kept as written', () => {
    const { model } = resolveSrc('@vars: { k: "v" }\na: { @meta: { "$k": $k } }\n');
    expect(node(model, 'a').config.meta).toEqual({ $k: 'v' });
  });

  it('`$` in a bare key or a path is a syntax error, as before', () => {
    expect(parse('$a: {}\n').diagnostics.length).toBeGreaterThan(0);
    expect(parse('a\na -> $b\n').diagnostics.length).toBeGreaterThan(0);
  });
});

describe('@type substitutes, and is still checked against @classes', () => {
  it('a class name from a variable applies; an unknown one is SGL2002', () => {
    const { model, diagnostics } = resolveSrc(
      '@vars: { k: "Svc", many: ["Svc", "Db"], bad: "Nope" }\n@classes: { Svc: {}, Db: {} }\na: { @type: $k }\nb: { @type: [$many] }\nc: { @type: $bad }\n',
    );
    expect(node(model, 'a').config.type).toEqual(['Svc']);
    expect(node(model, 'b').config.type).toEqual(['Svc', 'Db']);
    expect(node(model, 'c').config.type).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2002']);
  });
});

describe('canonical JSON keeps the source form (V6)', () => {
  const src = [
    '@vars: { brand: "#4F46E5", tier: "production", o: { a: 1 } }',
    '@classes: { K: { @style.stroke: $brand } }',
    'api: {',
    '  @vars: { local: $tier }',
    '  @style.stroke: $brand',
    '  @label: "API (${tier})"',
    '  @meta: { gone: $missing, o: $o }',
    '  x: "${local}"',
    '}',
    'db',
    'api -> db: "${tier} write"',
  ].join('\n');

  it('toJson prints `$name`, `${name}` and @vars as written', () => {
    const json = JSON.parse(toJson(resolveSrc(src).model)) as Record<string, ConfigBag>;
    expect(json['@vars']).toEqual({ brand: '#4F46E5', tier: 'production', o: { a: 1 } });
    expect(json['@classes']).toEqual({ K: { '@style': { stroke: '$brand' } } });
    const api = json.api as ConfigBag;
    expect(api['@vars']).toEqual({ local: '$tier' });
    expect(api['@style']).toEqual({ stroke: '$brand' });
    expect(api['@label']).toBe('API (${tier})');
    expect(api['@meta']).toEqual({ gone: '$missing', o: '$o' });
    expect((api.x as ConfigBag)['@label']).toBe('${local}');
    expect((json['@edges'] as unknown as ConfigBag[])[0]?.['@label']).toBe('${tier} write');
  });

  it('the model still carries the substituted values', () => {
    const { model } = resolveSrc(src);
    expect(node(model, 'api').config.style).toEqual({ stroke: '#4F46E5' });
    expect(node(model, 'api').config.label).toBe('API (production)');
    expect(node(model, 'api', 'x').config.label).toBe('production');
    expect(model.classes.K?.config.style).toEqual({ stroke: '#4F46E5' });
  });

  it('round-trips: fromJson(toJson(m)) is m, and toJson is a fixed point', () => {
    const { model, diagnostics } = resolveSrc(src);
    const again = fromJson(toJson(model));
    expect(stripSpans(again.model)).toEqual(stripSpans(model));
    expect(again.diagnostics.map((d) => d.code)).toEqual(diagnostics.map((d) => d.code));
    expect(toJson(again.model)).toBe(toJson(model));
  });

  it('a document with no variables serialises exactly as before (no authored copy)', () => {
    const { model } = resolveSrc('a: { @label: "x" }\n');
    expect(node(model, 'a').authored).toBeUndefined();
  });
});

describe('double-run determinism', () => {
  it('resolve and toJson are byte-identical across runs', () => {
    const src = '@vars: { a: 1, b: $a, c: "${b}" }\nx: { @vars: { a: 2 }, @order: $a, @label: $c }\n';
    const r1 = resolveSrc(src);
    const r2 = resolveSrc(src);
    expect(JSON.stringify(stripSpans(r1.model))).toBe(JSON.stringify(stripSpans(r2.model)));
    expect(JSON.stringify(r1.diagnostics)).toBe(JSON.stringify(r2.diagnostics));
    expect(toJson(r1.model)).toBe(toJson(r2.model));
  });
});
