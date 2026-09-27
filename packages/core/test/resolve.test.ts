import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Document, Entry } from '../src/ast.js';
import type { DiagnosticCode } from '../src/diagnostics.js';
import { nodeIdFromPath } from '../src/ids.js';
import type { ClassModel, ConfigBag, ContainerModel, DocumentModel, EdgeModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { fromJson, toJson } from '../src/json.js';
import { resolve } from '../src/resolve.js';
import { CLEAN_DOCS } from './corpus-docs.js';

const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const corpus = (name: string): string => readFileSync(`${corpusDir}${name}`, 'utf8');
const unresolvedCorpus = (name: string): string => readFileSync(`${corpusDir}unresolved/${name}`, 'utf8');

/** `SGL2001`, `SGL2003` and every `SGL3xxx` are DD-03's (endpoint resolution
 *  and wildcard expansion need the whole tree) even though the first two fall
 *  in the 2xxx range — DD-02 §8 says so explicitly. `resolve()` never touches
 *  them, so these `corpus/unresolved/*.sgl` fixtures are Stage C's to check. */
const COMPILER_OWNED_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'SGL2001',
  'SGL2003',
  'SGL3001',
  'SGL3003',
  'SGL3004',
  'SGL3005',
  'SGL3006',
  'SGL3007',
]);

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

describe('resolve() over the corpus', () => {
  it.each(CLEAN_DOCS)('%s resolves with no error diagnostics', (name) => {
    const { ast } = parse(corpus(name));
    const { diagnostics } = resolve(ast);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it.each(CLEAN_DOCS)('%s — resolver golden (canonical JSON)', async (name) => {
    const { ast } = parse(corpus(name));
    const { model } = resolve(ast);
    await expect(toJson(model)).toMatchFileSnapshot(`./__goldens__/resolve/${name}.json`);
  });

  it.each(CLEAN_DOCS)('%s — double-run: resolve and toJson are byte-identical', (name) => {
    const src = corpus(name);
    const { ast: ast1 } = parse(src);
    const { ast: ast2 } = parse(src);
    const r1 = resolve(ast1);
    const r2 = resolve(ast2);
    expect(stripSpans(r1.model)).toEqual(stripSpans(r2.model));
    expect(toJson(r1.model)).toBe(toJson(r2.model));
    expect(toJson(r1.model)).toBe(toJson(r1.model));
  });

  it.each(CLEAN_DOCS)('%s — round-trips through canonical JSON (DD-09 §3.3 invariant 1)', (name) => {
    const { ast } = parse(corpus(name));
    const { model } = resolve(ast);
    const roundTripped = fromJson(toJson(model)).model;
    expect(stripSpans(roundTripped)).toEqual(stripSpans(model));
  });

  it('shuffling root-level declaration order leaves node and edge sets unchanged (invariant 2)', () => {
    for (const name of CLEAN_DOCS) {
      const { ast } = parse(corpus(name));
      fc.assert(
        fc.property(fc.shuffledSubarray(ast.entries, { minLength: ast.entries.length }), (shuffled) => {
          const shuffledAst: Document = { ...ast, entries: shuffled as Entry[] };
          const base = resolve(ast).model;
          const permuted = resolve(shuffledAst).model;
          expect(canonicalNodeAndEdgeSet(base)).toEqual(canonicalNodeAndEdgeSet(permuted));
        }),
        { numRuns: 25 },
      );
    }
  });
});

/** `JSON.stringify` with object keys sorted at every level, so two configs
 *  built by inserting the same keys in a different order compare equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The set of node paths and edges, order-independent — what invariant 2 in
 *  DD-09 §3.3 asks for (`resolve()` has no node/edge *IDs* yet; those are
 *  Stage C's, so this compares the model-level equivalent: paths and edges). */
function canonicalNodeAndEdgeSet(model: DocumentModel): { nodes: string[]; edges: string[] } {
  const nodes: string[] = [];
  const edges: string[] = [];
  const walk = (c: ContainerModel): void => {
    nodes.push(`${c.path.join('.')}\x1f${stableStringify(stripSpans(c.config))}`);
    for (const e of c.edges) edges.push(stableStringify(stripSpans(e)));
    for (const child of c.children) walk(child);
  };
  walk(model.root);
  return { nodes: nodes.sort(), edges: edges.sort() };
}

describe('corpus/unresolved/*.sgl — resolver-owned diagnostics (DD-02 §8)', () => {
  const files = readdirSync(`${corpusDir}unresolved`);
  for (const file of files) {
    const src = unresolvedCorpus(file);
    const expected = /\/\/ expects: (SGL\d+)/.exec(src)?.[1] as DiagnosticCode | undefined;
    if (expected === undefined) throw new Error(`${file} has no "// expects:" header`);
    if (COMPILER_OWNED_CODES.has(expected)) continue; // Stage C's to check.

    it(`${file} emits exactly ${expected}`, () => {
      const { ast } = parse(src);
      const { diagnostics } = resolve(ast);
      expect(diagnostics.map((d) => d.code)).toEqual([expected]);
      const [diag] = diagnostics;
      expect(diag?.span.from).toBeGreaterThanOrEqual(0);
      expect(diag?.span.to).toBeLessThanOrEqual(src.length);
      expect(diag?.span.from).toBeLessThanOrEqual(diag?.span.to as number);
    });
  }
});

describe('redeclaration merges (DD-02 §3.2)', () => {
  const resolveSrc = (src: string) => resolve(parse(src).ast);

  it('later config wins over earlier (scalar override)', () => {
    const { model } = resolveSrc('a: { @label: "First" }\na: { @label: "Second" }\n');
    expect(model.root.children[0]?.config.label).toBe('Second');
  });

  it('children union across redeclarations', () => {
    const { model } = resolveSrc('a: { x: {} }\na: { y: {} }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.children.map((c) => c.key)).toEqual(['x', 'y']);
  });

  it('edges accumulate across redeclarations', () => {
    const { model } = resolveSrc('a: { x\n y\n x -> y }\na: { x -> y }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.edges).toHaveLength(2);
  });

  it('deep object merge for nested config (dotted spelling)', () => {
    const { model } = resolveSrc('a: { @style.fill: red }\na: { @style.stroke: blue }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.style).toEqual({ fill: 'red', stroke: 'blue' });
  });

  it('deep object merge for nested config (literal-object spelling, DD-02 §2/§3.2)', () => {
    const { model } = resolveSrc('a: { @style: { fill: red } }\na: { @style: { stroke: blue } }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.style).toEqual({ fill: 'red', stroke: 'blue' });
  });

  it('the two spellings are indistinguishable after merging, as DD-02 §2 requires', () => {
    const dotted = resolveSrc('a: { @style.fill: red }\na: { @style.stroke: blue }\n').model;
    const literal = resolveSrc('a: { @style: { fill: red } }\na: { @style: { stroke: blue } }\n').model;
    expect(stripSpans(dotted.root.children[0]?.config)).toEqual(stripSpans(literal.root.children[0]?.config));
  });

  it('a nested object merges recursively, more than one level deep', () => {
    const { model } = resolveSrc('a: { @a11y: { label: "x" } }\na: { @a11y: { description: "y" } }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.a11y).toEqual({ label: 'x', description: 'y' });
  });

  it('arrays replace on redeclaration; they do not concatenate', () => {
    const { model } = resolveSrc('a: { @meta: [1, 2] }\na: { @meta: [3] }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.meta).toEqual([3]);
  });

  it('@type replaces on redeclaration (later class list wins outright)', () => {
    const { model } = resolveSrc(
      '@classes: { X: {} Y: {} }\na: { @type: X }\na: { @type: Y }\n',
    );
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.type).toEqual(['Y']);
  });

  it('a whole-value scalar-to-object replacement does not emit SGL2006', () => {
    const { diagnostics } = resolveSrc('a: { @meta: "flag" }\na: { @meta: { note: "x" } }\n');
    expect(diagnostics.map((d) => d.code)).not.toContain('SGL2006');
  });

  it('a redeclared class body deep-merges its config too (DD-02 §4)', () => {
    const { model } = resolveSrc(
      '@classes: {\n  Service: { @style.fill: red }\n  Service: { @style.stroke: blue }\n}\na: Service\n',
    );
    expect((model.classes.Service as ClassModel).config.style).toEqual({ fill: 'red', stroke: 'blue' });
  });

  it('emits SGL2005 once per redeclaration, not per key', () => {
    const { diagnostics } = resolveSrc('a: {}\na: {}\na: {}\n');
    expect(diagnostics.filter((d) => d.code === 'SGL2005')).toHaveLength(2);
  });
});

describe('edge chain expansion (DD-02 §5)', () => {
  const resolveSrc = (src: string) => resolve(parse(src).ast).model;

  it('expands every operator to the documented `directed` value', () => {
    const model = resolveSrc('a\nb\nc\nd\na -> b\nb <- c\nc <-> d\nd -- a\n');
    const [ab, cb, cd, da] = model.root.edges as EdgeModel[];
    expect(ab?.directed).toBe('forward');
    expect(ab?.from.segments[0]?.kind === 'Name' && ab.from.segments[0].value).toBe('a');
    // `<-` swaps: `b <- c` means `c -> b`.
    expect(cb?.from.segments[0]?.kind === 'Name' && cb.from.segments[0].value).toBe('c');
    expect(cb?.to.segments[0]?.kind === 'Name' && cb.to.segments[0].value).toBe('b');
    expect(cd?.directed).toBe('both');
    expect(da?.directed).toBe('none');
  });

  it('a chain of n ops yields n edges with ordinals 0..n-1', () => {
    const model = resolveSrc('a\nb\nc\nd\na -> b -> c -> d\n');
    expect(model.root.edges.map((e) => e.ordinal)).toEqual([0, 1, 2]);
  });

  it('a label on a chain is copied onto every edge in it', () => {
    const model = resolveSrc('a\nb\nc\na -> b -> c: "hop"\n');
    expect(model.root.edges.map((e) => e.config.label)).toEqual(['hop', 'hop']);
  });

  it('mixed chains: each op in a mixed chain gets its own directed value', () => {
    const model = resolveSrc('a\nb\nc\na -> b <-> c\n');
    expect(model.root.edges.map((e) => e.directed)).toEqual(['forward', 'both']);
  });
});

describe('classes (DD-02 §4)', () => {
  const resolveSrc = (src: string) => resolve(parse(src).ast);

  it('captures @extends in declaration order', () => {
    const { model } = resolveSrc(
      '@classes: { A: {} B: {} C: { @extends: [A, B] } }\nx: C\n',
    );
    expect((model.classes.C as ClassModel).extends).toEqual(['A', 'B']);
  });

  it('drops an unknown @extends reference with SGL2002', () => {
    const { model, diagnostics } = resolveSrc('@classes: { A: { @extends: Ghost } }\nx: A\n');
    expect((model.classes.A as ClassModel).extends).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toContain('SGL2002');
  });

  it('breaks a two-class cycle at the back-edge and reports SGL2004 once', () => {
    const { model, diagnostics } = resolveSrc('@classes: { A: { @extends: B } B: { @extends: A } }\nx: A\n');
    const cycleDiags = diagnostics.filter((d) => d.code === 'SGL2004');
    expect(cycleDiags).toHaveLength(1);
    // One of the two edges survives; the graph is acyclic afterwards.
    const a = (model.classes.A as ClassModel).extends;
    const b = (model.classes.B as ClassModel).extends;
    expect(a.length + b.length).toBe(1);
  });

  it('a three-class cycle is broken with exactly one diagnostic', () => {
    const { diagnostics } = resolveSrc(
      '@classes: { A: { @extends: B } B: { @extends: C } C: { @extends: A } }\nx: A\n',
    );
    expect(diagnostics.filter((d) => d.code === 'SGL2004')).toHaveLength(1);
  });

  it('diamond inheritance keeps both parents, declaration order preserved', () => {
    const { model } = resolveSrc(
      '@classes: { Base: {} Left: { @extends: Base } Right: { @extends: Base } Diamond: { @extends: [Left, Right] } }\nx: Diamond\n',
    );
    expect((model.classes.Diamond as ClassModel).extends).toEqual(['Left', 'Right']);
  });
});

describe('config-key registry (DD-02 §7)', () => {
  const resolveSrc = (src: string) => resolve(parse(src).ast);

  it('an unknown top-level key is kept with SGL2010', () => {
    const { model, diagnostics } = resolveSrc('a: { @sparkle: true }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.sparkle).toBe(true);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2010']);
  });

  it('an unknown key under @size is kept with SGL2010 naming it (spec §4; fix round 1, item 1)', () => {
    const { model, diagnostics } = resolveSrc('a: { @size: { width: 80, fill: "#FF0000", aspectRatio: 1 } }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.size).toEqual({ width: 80, fill: '#FF0000', aspectRatio: 1 });
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([['SGL2010', expect.stringContaining('`@size.fill`')]]);
  });

  it('a wrong-type value is dropped with SGL2011', () => {
    const { model, diagnostics } = resolveSrc('a: { @hidden: "yes" }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.hidden).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2011']);
  });

  it('an out-of-scope key is dropped with SGL2012', () => {
    const { model, diagnostics } = resolveSrc('a: { @classes: { X: {} } }\n');
    const a = model.root.children[0] as ContainerModel;
    expect(a.config.classes).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2012']);
  });

  describe('@pin (DD-12 N4)', () => {
    const PIN_MSG = '`@pin` expects `{ x, y }` numbers within ±100 000; ignored.';
    const pinOf = (src: string) => {
      const { model, diagnostics } = resolveSrc(src);
      const a = model.root.children[0] as ContainerModel;
      return { pin: a.config.pin, diags: diagnostics.map((d) => [d.code, d.message, src.slice(d.span.from, d.span.to)]) };
    };

    it('a well-formed pin is kept as written, with no diagnostic', () => {
      expect(pinOf('a: { @pin: { x: 10, y: -20 } }\n')).toEqual({ pin: { x: 10, y: -20 }, diags: [] });
    });

    it('the bounds are inclusive: ±100 000 is kept', () => {
      expect(pinOf('a: { @pin: { x: 100000, y: -100000 } }\n')).toEqual({ pin: { x: 100000, y: -100000 }, diags: [] });
      expect(pinOf('a: { @pin: { x: 0.5, y: 0 } }\n').diags).toEqual([]);
    });

    it.each([
      ['x missing', '{ y: 1 }'],
      ['y missing', '{ x: 1 }'],
      ['x a string', '{ x: "1", y: 1 }'],
      ['y a boolean', '{ x: 1, y: true }'],
      ['x over the bound', '{ x: 100001, y: 0 }'],
      ['y under the bound', '{ x: 0, y: -100000.5 }'],
      ['a number', '5'],
      ['an array', '[1, 2]'],
      ['a string', '"10,20"'],
    ])('%s: the whole pin is dropped with SGL2011 at the key', (_, value) => {
      expect(pinOf(`a: { @pin: ${value} }\n`)).toEqual({ pin: undefined, diags: [['SGL2011', PIN_MSG, '@pin']] });
    });

    it('an unknown sub-key is SGL2010 naming it, and the pin is kept', () => {
      expect(pinOf('a: { @pin: { x: 1, y: 2, z: 3 } }\n')).toEqual({
        pin: { x: 1, y: 2, z: 3 },
        diags: [['SGL2010', expect.stringContaining('`@pin.z`'), '@pin']],
      });
    });

    it('dotted sub-keys fold into one pin', () => {
      expect(pinOf('a: { @pin.x: 3, @pin.y: 4 }\n').pin).toEqual({ x: 3, y: 4 });
    });

    it('a variable is substituted before the check', () => {
      const { model, diagnostics } = resolveSrc('@vars: { origin: { x: 5, y: 6 }, far: { x: 1000000, y: 0 } }\na: { @pin: $origin }\nb: { @pin: $far }\n');
      expect((model.root.children[0] as ContainerModel).config.pin).toEqual({ x: 5, y: 6 });
      expect((model.root.children[1] as ContainerModel).config.pin).toBeUndefined();
      expect(diagnostics.map((d) => d.code)).toEqual(['SGL2011']);
    });

    it('a container may be pinned', () => {
      expect(pinOf('a: { @pin: { x: 1, y: 2 }, b: "B" }\n')).toEqual({ pin: { x: 1, y: 2 }, diags: [] });
    });

    it.each([
      ['an edge', 'a: "A"\nb: "B"\na -> b: { @pin: { x: 1, y: 2 } }\n'],
      ['a class', '@classes: { P: { @pin: { x: 1, y: 2 } } }\na: P\n'],
      ['the root', '@pin: { x: 1, y: 2 }\na: "A"\n'],
    ])('on %s it is SGL2012 and dropped', (_, src) => {
      const { diagnostics } = resolveSrc(src);
      expect(diagnostics.map((d) => [d.code, src.slice(d.span.from, d.span.to)])).toEqual([['SGL2012', '@pin']]);
    });
  });

  it('@direction folds into @layout.direction, an explicit one wins', () => {
    const { model } = resolveSrc('a: { @direction: down, @layout.direction: up }\n');
    const a = model.root.children[0] as ContainerModel;
    expect((a.config.layout as ConfigBag).direction).toBe('up');
    expect(a.config.direction).toBeUndefined();
  });

  it('@direction also folds at the document root, not just on a node', () => {
    const { model, diagnostics } = resolveSrc('@direction: right\n');
    expect((model.root.config.layout as ConfigBag).direction).toBe('right');
    expect(model.root.config.direction).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).not.toContain('SGL2012');
  });
});

describe('"@edges" arrays — the canonical-JSON form of an edge (DD-02 §6)', () => {
  it('round-trips a wildcard endpoint as itself', () => {
    const { model } = resolve(parse('lane1: { a\n b }\nswitch\nlane1.* -> switch\n').ast);
    const json = toJson(model);
    expect(json).toContain('"from": "lane1.*"');
    const back = fromJson(json).model;
    expect(stripSpans(back)).toEqual(stripSpans(model));
  });

  it('anchors from/to spans in the real source, not the synthetic re-parse', () => {
    // A source laid out so the synthetic "lane1.* -> __sgl_edges_placeholder__"
    // parse would, if its offsets leaked through, land in-bounds by
    // coincidence — so this also exercises `collectSpans` below finding it.
    const src = 'lane1: { a\n b }\nswitch\n"@edges": [ { "from": "lane1.*", "to": "switch", "directed": "forward" } ]\n';
    const { model } = resolve(parse(src).ast);
    const edge = model.root.edges[0] as EdgeModel;
    for (const span of [edge.from.span, edge.to.span, ...edge.from.segments.map((s) => s.span)]) {
      expect(span.from).toBeGreaterThanOrEqual(0);
      expect(span.to).toBeLessThanOrEqual(src.length);
      expect(span.from).toBeLessThanOrEqual(span.to);
    }
    // Precisely: the "from" span is the `"lane1.*"` string literal itself.
    expect(src.slice(edge.from.span.from, edge.from.span.to)).toBe('"lane1.*"');
    expect(src.slice(edge.to.span.from, edge.to.span.to)).toBe('"switch"');
  });
});

describe('every span in a resolved model lies inside its source', () => {
  function collectSpans(model: DocumentModel): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    const walkPath = (p: EdgeModel['from']): void => {
      out.push(p.span);
      for (const step of p.segments) out.push(step.span);
    };
    const walk = (c: ContainerModel): void => {
      for (const e of c.edges) {
        walkPath(e.from);
        walkPath(e.to);
      }
      for (const child of c.children) walk(child);
    };
    walk(model.root);
    return out;
  }

  it.each([...CLEAN_DOCS, 'checkout.sgl'])('%s', (name) => {
    const src = corpus(name);
    const { model } = resolve(parse(src).ast);
    for (const span of collectSpans(model)) {
      expect(span.from).toBeGreaterThanOrEqual(0);
      expect(span.to).toBeLessThanOrEqual(src.length);
      expect(span.from).toBeLessThanOrEqual(span.to);
    }
  });

  it('holds for a document built from "@edges" arrays', () => {
    const src = corpus('json-form.sgl.json');
    const { model } = resolve(parse(src).ast);
    for (const span of collectSpans(model)) {
      expect(span.from).toBeGreaterThanOrEqual(0);
      expect(span.to).toBeLessThanOrEqual(src.length);
    }
  });
});

describe('span-table keys share NodeId escaping with Stage C (DD-03 §2.1)', () => {
  it('escapes `\\` before `.`, matching nodeIdFromPath exactly', () => {
    expect(nodeIdFromPath(['a\\b', 'c'])).toBe('a\\\\b.c');
    expect(nodeIdFromPath(['a.b'])).toBe('a\\.b');
  });

  it("resolve()'s span table keys are built with nodeIdFromPath, not a private re-implementation", () => {
    const src = '"a.b": {}\n';
    const { model } = resolve(parse(src).ast);
    const child = model.root.children[0] as ContainerModel;
    expect(model.spans.has(`n:${nodeIdFromPath(child.path)}`)).toBe(true);
    expect(model.spans.has(`n:${child.path.join('.')}`)).toBe(false); // unescaped would collide
  });
});

describe('path printing mirrors the Identifier token exactly (grammar `-` rule)', () => {
  it('a trailing or doubled dash is quoted, not printed bare', () => {
    const { model } = resolve(parse('"a-": {}\nb\n"a-" -> b\n').ast);
    const json = toJson(model);
    expect(json).toContain('"from": "\\"a-\\""');
    const back = fromJson(json).model;
    const edge = back.root.edges[0] as EdgeModel;
    const name = edge.from.segments[0];
    expect(name?.kind === 'Name' && name.value).toBe('a-');
  });

  it('an ordinary hyphenated identifier still prints bare', () => {
    const { model } = resolve(parse('a-b\nc\na-b -> c\n').ast);
    expect(toJson(model)).toContain('"from": "a-b"');
  });
});
