import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../src/diagnostics.js';
import { compileImports, createImportCache, createImportLinker, resolveImports, type ImportCache } from '../src/imports.js';
import { fromJson, toJson } from '../src/json.js';
import type { ContainerModel, DocumentModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { hasImports, resolve } from '../src/resolve.js';
import { memoryHost, type MemoryHost } from './import-host.js';

/**
 * A9 imports, the core (DD-02 §10, I7–I18, I31), against an in-memory host.
 * Caps and cycles are `imports-limits.test.ts`; the corpus documents that
 * import one another are `imports-corpus.test.ts`.
 */

interface Linked {
  readonly model: DocumentModel;
  readonly resolveDiags: readonly Diagnostic[];
  readonly compileDiags: readonly Diagnostic[];
  readonly graph: ReturnType<typeof compileImports>['graph'];
  readonly host: MemoryHost;
}

function link(main: string, docs: Record<string, string>, cache?: ImportCache, host: MemoryHost = memoryHost(docs)): Linked {
  const { ast, diagnostics: syntax } = parse(main);
  expect(syntax).toEqual([]);
  const linker = createImportLinker(host, { self: 'main', ...(cache !== undefined ? { cache } : {}) });
  const { model, diagnostics: resolveDiags } = resolveImports(ast, linker);
  const { graph, diagnostics: compileDiags } = compileImports(model);
  return { model, resolveDiags, compileDiags, graph, host };
}

const codes = (diags: readonly Diagnostic[]): string[] => diags.map((d) => d.code);
const paths = (c: ContainerModel): string[] => c.children.flatMap((k) => [k.path.join('.'), ...paths(k)]);

const LIB = `
@title: "Shared library"
@vars: { brand: "#4F46E5", tier: "prod" }
@classes: {
  Service: { @shape: round, @style.stroke: $brand }
  Critical: { @extends: Service, @style.strokeWidth: 3 }
}
`;

const AWS = `
@title: "AWS"
@vars: { orange: "#FF9900" }
@classes: { Lambda: { @shape: hexagon, @style.fill: $orange } }
lambda: { @type: Lambda }
queue: { @label: "SQS" }
lambda -> queue
`;

describe('@imports: the two forms (DD-02 I10, I11)', () => {
  it('a string path brings classes and root variables, unqualified', () => {
    const { model, resolveDiags, compileDiags, graph } = link(
      '@imports: ["./shared/lib.sgl"]\napi: Critical\ndb: { @label: "${tier} db", @style.stroke: $brand }\n',
      { lib: LIB },
    );
    expect(resolveDiags).toEqual([]);
    expect(compileDiags).toEqual([]);
    expect(Object.keys(model.classes)).toEqual(['Service', 'Critical']);
    expect(model.classes.Service?.config).toEqual({ shape: 'round', style: { stroke: '#4F46E5' } });
    expect(graph.nodes['api' as never]).toMatchObject({ classes: ['Service', 'Critical'], shape: 'round' });
    expect(model.root.children.find((c) => c.key === 'db')?.config).toEqual({ label: 'prod db', style: { stroke: '#4F46E5' } });
  });

  it('an object with `as` brings `ns.Name` classes, `$ns.name` variables and a container `ns` holding the nodes and edges', () => {
    const { model, resolveDiags, compileDiags, graph } = link(
      '@imports: [{ path: "./aws-icons.sgl", as: aws }]\nfn: aws.Lambda\nx: { @style.fill: $aws.orange }\nfn -> aws.lambda\n',
      { 'aws-icons': AWS },
    );
    expect(resolveDiags).toEqual([]);
    expect(compileDiags).toEqual([]);
    expect(Object.keys(model.classes)).toEqual(['aws.Lambda']);
    expect(model.root.children.map((c) => c.key)).toEqual(['aws', 'fn', 'x']);
    const aws = model.root.children[0] as ContainerModel;
    expect(aws.config).toEqual({ label: 'AWS' });
    expect(aws.origin?.path).toBe('./aws-icons.sgl');
    expect(paths(aws)).toEqual(['aws.lambda', 'aws.queue']);
    expect(model.root.children[2]?.config).toEqual({ style: { fill: '#FF9900' } });
    expect(graph.nodes['aws.lambda' as never]).toMatchObject({ classes: ['aws.Lambda'], shape: 'hexagon', parent: 'aws' });
    expect(graph.nodes['fn' as never]).toMatchObject({ classes: ['aws.Lambda'] });
    // The root's own edges first, then by declaring container (DD-03 §5).
    expect(graph.edges.map((e) => `${e.from.node}->${e.to.node}`)).toEqual(['fn->aws.lambda', 'aws.lambda->aws.queue']);
    expect(graph.order.slice(0, 3)).toEqual(['aws', 'aws.lambda', 'aws.queue']);
  });

  it('the container is labelled with the key when the import has no @title', () => {
    const { model } = link('@imports: [{ path: "./x.sgl", as: ex }]\n', { x: 'a\nb\na -> b\n' });
    expect(model.root.children[0]?.config).toEqual({ label: 'ex' });
  });

  it('an import without `as` does not bring nodes or edges, and says so (SGL2026, info)', () => {
    const { model, resolveDiags } = link('@imports: ["./aws.sgl"]\nfn: Lambda\n', { aws: AWS });
    expect(model.root.children.map((c) => c.key)).toEqual(['fn']);
    expect(resolveDiags.map((d) => [d.code, d.severity])).toEqual([['SGL2026', 'info']]);
  });

  it('an import with `as` and no nodes grafts nothing', () => {
    const { model, resolveDiags } = link('@imports: [{ path: "./lib.sgl", as: lib }]\nx: lib.Service\n', { lib: LIB });
    expect(resolveDiags).toEqual([]);
    expect(model.root.children.map((c) => c.key)).toEqual(['x']);
  });

  it('the canonical JSON spelling of both forms reads the same', () => {
    const json = '{ "@imports": ["./lib.sgl", { "path": "./aws.sgl", "as": "aws" }], "fn": { "@type": ["aws.Lambda", "Service"] } }';
    const { graph, resolveDiags } = link(json, { lib: LIB, aws: AWS });
    expect(resolveDiags).toEqual([]);
    expect(graph.nodes['fn' as never]).toMatchObject({ classes: ['aws.Lambda', 'Service'] });
  });
});

describe('transitive imports (I15)', () => {
  const B = '@imports: [{ path: "./c.sgl", as: c }]\n@vars: { own: 1 }\n@classes: { B: {} }\nb1\n';
  const C = '@vars: { x: "cx" }\n@classes: { X: { @shape: diamond } }\nc1\n';

  it('qualifiers compose: A sees b.c.X, $b.c.x and nodes under b.c', () => {
    const { model, resolveDiags, graph } = link('@imports: [{ path: "./b.sgl", as: b }]\nn: { @type: b.c.X, @label: $b.c.x }\n', { b: B, c: C });
    expect(resolveDiags).toEqual([]);
    expect(Object.keys(model.classes).sort()).toEqual(['b.B', 'b.c.X']);
    expect(paths(model.root)).toEqual(['b', 'b.c', 'b.c.c1', 'b.b1', 'n']);
    expect(graph.nodes['n' as never]).toMatchObject({ classes: ['b.c.X'], shape: 'diamond' });
    expect(model.root.children.find((c) => c.key === 'n')?.config.label).toBe('cx');
  });

  it("an unqualified import's names are exported by its importer as its own", () => {
    const B2 = '@imports: ["./c.sgl"]\n';
    const { model, resolveDiags } = link('@imports: ["./b.sgl"]\nn: { @type: X, @label: $x }\n', { b: B2, c: C });
    // Two SGL2026s would be B's and A's; B's is info inside B, not counted (I17).
    expect(codes(resolveDiags)).toEqual([]);
    expect(Object.keys(model.classes)).toEqual(['X']);
    expect(model.root.children.find((c) => c.key === 'n')?.config.label).toBe('cx');
  });

  it('an imported document never sees its importer: no dynamic scope', () => {
    const lib = '@classes: { S: { @style.stroke: $mine } }\n';
    const { resolveDiags } = link('@imports: ["./lib.sgl"]\n@vars: { mine: "red" }\n', { lib });
    expect(codes(resolveDiags)).toEqual(['SGL2021']);
    expect(resolveDiags[0]?.message).toContain('Unknown variable `$mine`');
  });
});

describe('precedence and shadowing (I13)', () => {
  it("your own @vars shadow an import's silently; a later import shadows an earlier one", () => {
    const one = '@vars: { c: "one", d: "one" }\n';
    const two = '@vars: { c: "two" }\n';
    const { model, resolveDiags } = link('@imports: ["./one.sgl", "./two.sgl"]\n@vars: { d: "mine" }\nn: { @label: "${c} ${d}" }\n', { one, two });
    expect(resolveDiags).toEqual([]);
    expect(model.root.children[0]?.config.label).toBe('two mine');
  });

  it('your own class replaces an imported one whole (SGL2023, info)', () => {
    const { model, resolveDiags } = link('@imports: ["./lib.sgl"]\n@classes: { Service: { @shape: diamond } }\n', { lib: LIB });
    expect(resolveDiags.map((d) => [d.code, d.severity])).toEqual([['SGL2023', 'info']]);
    expect(model.classes.Service).toEqual({ name: 'Service', extends: [], config: { shape: 'diamond' } });
    expect(Object.keys(model.classes)).toEqual(['Critical', 'Service']);
  });

  it('a later import replaces an earlier one, with the same info', () => {
    const { model, resolveDiags } = link('@imports: ["./lib.sgl", "./other.sgl"]\n', { lib: LIB, other: '@classes: { Service: { @shape: ellipse } }\n' });
    expect(codes(resolveDiags)).toEqual(['SGL2023']);
    expect(model.classes.Service?.config).toEqual({ shape: 'ellipse' });
  });

  it("an unqualified import's @extends binds late: shadowing its base changes what it extends", () => {
    const { graph, resolveDiags } = link('@imports: ["./lib.sgl"]\n@classes: { Service: { @shape: diamond } }\nn: Critical\n', { lib: LIB });
    expect(codes(resolveDiags)).toEqual(['SGL2023']);
    expect(graph.nodes['n' as never]).toMatchObject({ classes: ['Service', 'Critical'], shape: 'diamond' });
  });

  it('a cycle created by shadowing a base is SGL2004 (error), from the merged table', () => {
    const { resolveDiags, compileDiags } = link('@imports: ["./lib.sgl"]\n@classes: { Service: { @extends: Critical } }\n', { lib: LIB });
    expect(codes(resolveDiags)).toEqual(['SGL2023', 'SGL2004']);
    expect(codes(compileDiags)).toEqual([]);
  });

  it('extending instead of replacing: import with `as` and extend `lib.Service`', () => {
    const { graph, resolveDiags } = link('@imports: [{ path: "./lib.sgl", as: lib }]\n@classes: { Service: { @extends: lib.Service, @style.fill: "#eee" } }\nn: Service\n', { lib: LIB });
    expect(resolveDiags).toEqual([]);
    expect(graph.nodes['n' as never]).toMatchObject({ classes: ['lib.Service', 'Service'], shape: 'round' });
  });
});

describe('clashes (I14)', () => {
  it('two imports with the same `as`: the second is skipped (SGL2022)', () => {
    const { model, resolveDiags } = link('@imports: [{ path: "./lib.sgl", as: x }, { path: "./aws.sgl", as: x }]\n', { lib: LIB, aws: AWS });
    expect(codes(resolveDiags)).toEqual(['SGL2022']);
    expect(Object.keys(model.classes)).toEqual(['x.Service', 'x.Critical']);
    expect(model.root.children).toEqual([]);
  });

  it('an `as` equal to your own root node key: not grafted (SGL2031), classes and variables still arrive', () => {
    const { model, resolveDiags } = link('@imports: [{ path: "./aws.sgl", as: aws }]\naws: { @label: $aws.orange }\nf: aws.Lambda\n', { aws: AWS });
    expect(codes(resolveDiags)).toEqual(['SGL2031']);
    expect(resolveDiags[0]?.message).toBe('`aws` is already a node in this document; the nodes and edges of `./aws.sgl` were not imported.');
    expect(model.root.children.map((c) => c.key)).toEqual(['aws', 'f']);
    expect(model.root.children[0]?.origin).toBeUndefined();
    expect(model.root.children[0]?.config.label).toBe('#FF9900');
  });

  it('a class name you declare with a `.` is reserved for imports: SGL2011, the class ignored', () => {
    const { model, resolveDiags } = link('@classes: { "a.b": { @shape: round }, ok: {} }\n', {});
    expect(codes(resolveDiags)).toEqual(['SGL2011']);
    expect(Object.keys(model.classes)).toEqual(['ok']);
  });

  it('with an empty @imports too, and with no linker', () => {
    const { model, diagnostics } = resolveImports(parse('@imports: []\n@classes: { "a.b": {} }\nn: { @type: "a.b" }\n').ast);
    expect(codes(diagnostics)).toEqual(['SGL2011', 'SGL2002']);
    expect(model.classes).toEqual({});
  });

  it('a document without @imports resolves as it always did: a quoted "a.b" is still its own class (off the boot path, step A)', () => {
    const { model, diagnostics } = resolve(parse('@classes: { "a.b": { @shape: round } }\nn: a.b\n').ast);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(model.classes)).toEqual(['a.b']);
    expect(model.root.children[0]?.config.type).toEqual(['a.b']);
  });
});

describe('the grafted subtree (I12)', () => {
  const PATHS = 'x: { y: {}, z: {} }\nw\n/x.y -> w\nx: { y -> /w, z -> ../w, ../../out -> y }\n';

  it('an absolute path is prefixed; a ../ that climbs out of the import is kept as written and contained', () => {
    const { model, graph, compileDiags } = link('@imports: [{ path: "./p.sgl", as: p }]\nout\n', { p: PATHS });
    const p = model.root.children[0] as ContainerModel;
    expect(p.edges.map((e) => e.from.segments.map((s) => (s.kind === 'Name' ? s.value : '*')))).toEqual([['p', 'x', 'y']]);
    expect(p.edges[0]?.from.root).toBe(true);
    const x = p.children[0] as ContainerModel;
    expect(x.edges[2]?.fromText).toBe('../../out');
    expect(graph.edges.map((e) => `${e.from.node}->${e.to.node}`)).toEqual(['p.x.y->p.w', 'p.x.y->p.w', 'p.x.z->p.w']);
    // The escape is compile()'s SGL2001, contained in one SGL2021 (I17).
    expect(compileDiags.map((d) => [d.code, d.severity])).toEqual([['SGL2021', 'warning']]);
    expect(compileDiags[0]?.message).toContain('Cannot find `../../out`');
  });

  it('every span in the subtree is the @imports item, span-table keys included', () => {
    const main = '@imports: [\n  { path: "./aws.sgl", as: aws }\n]\n';
    const { model, graph } = link(main, { aws: AWS });
    const item = { from: main.indexOf('{ path'), to: main.indexOf('}') + 1 };
    expect(model.imports?.[0]?.span).toEqual(item);
    expect(model.spans.get('n:aws')).toEqual(item);
    expect(model.spans.get('n:aws.lambda')).toEqual(item);
    expect(model.spans.get('e:aws#0')).toEqual(item);
    expect(model.spans.get('c:aws.Lambda')).toEqual(item);
    expect(graph.nodes['aws.queue' as never]?.span).toEqual(item);
    expect(graph.edges[0]?.span).toEqual(item);
    expect(model.classes['aws.Lambda']?.origin).toEqual({ path: './aws.sgl', span: item });
  });
});

describe('failed imports are warnings, and so is everything they cause (I17)', () => {
  it('unresolved: SGL2017, and a qualified class, variable or edge into it is SGL2024', () => {
    const { resolveDiags, compileDiags } = link('@imports: [{ path: "./nope.sgl", as: aws }]\nf: aws.Lambda\ng: { @label: $aws.x }\nf -> aws.lambda\n', {});
    expect(resolveDiags.map((d) => [d.code, d.severity])).toEqual([
      ['SGL2017', 'warning'],
      ['SGL2024', 'warning'],
      ['SGL2024', 'warning'],
    ]);
    expect(compileDiags.map((d) => [d.code, d.severity])).toEqual([['SGL2024', 'warning']]);
    expect(compileDiags[0]?.message).toBe('`aws.lambda` may come from `./nope.sgl`, which could not be imported; it was skipped.');
  });

  it('a failed unqualified import turns an unknown bare class or variable into SGL2024', () => {
    const { resolveDiags } = link('@imports: ["./nope.sgl"]\nf: Lambda\ng: { @label: $x }\n', {});
    expect(codes(resolveDiags)).toEqual(['SGL2017', 'SGL2024', 'SGL2024']);
    expect(resolveDiags[1]?.message).toBe('`Lambda` may come from `./nope.sgl`, which could not be imported; it was skipped.');
  });

  it('with every import resolved, an unknown name is still an error', () => {
    const { resolveDiags } = link('@imports: ["./lib.sgl"]\nf: Lambda\n', { lib: LIB });
    expect(resolveDiags.map((d) => [d.code, d.severity])).toEqual([['SGL2002', 'error']]);
  });

  it("an import's own problems are one SGL2021, with the count and the first", () => {
    const bad = '@classes: { S: { @extends: Nope } }\nn: Missing\nm: { @label: $u }\n';
    const { resolveDiags } = link('@imports: ["./bad.sgl"]\n', { bad });
    expect(resolveDiags.map((d) => [d.code, d.severity])).toEqual([
      ['SGL2026', 'info'],
      ['SGL2021', 'warning'],
    ]);
    expect(resolveDiags[1]?.message).toBe('`./bad.sgl` has 3 problems of its own; the first: Unknown class `Nope`. Declare it in `@classes`.');
  });

  it("compile()'s diagnostics on grafted elements are an SGL2021 too", () => {
    const { compileDiags } = link('@imports: [{ path: "./g.sgl", as: g }]\n', { g: 'a: { @shape: star }\na -> nowhere\n' });
    expect(compileDiags.map((d) => [d.code, d.severity])).toEqual([['SGL2021', 'warning']]);
    expect(compileDiags[0]?.message).toMatch(/^`\.\/g\.sgl` has 2 problems of its own; the first: /);
  });

  it('with no linker, every @imports item is SGL2017 (I9)', () => {
    const { model, diagnostics } = resolveImports(parse('@imports: ["./a.sgl", { path: "./b.sgl", as: b }]\nn: b.X\n').ast);
    expect(codes(diagnostics)).toEqual(['SGL2017', 'SGL2017', 'SGL2024']);
    expect(model.imports?.map((i) => [i.path, i.failed])).toEqual([
      ['./a.sgl', true],
      ['./b.sgl', true],
    ]);
  });
});

describe('what @imports may hold (§10.2)', () => {
  it.each([
    ['not an array', '@imports: "./a.sgl"', ['SGL2011']],
    ['an item of neither form', '@imports: [3, null]', ['SGL2011', 'SGL2011']],
    ['a missing path', '@imports: [{ as: a }]', ['SGL2011']],
    ['a path that is not a string', '@imports: [{ path: 3 }]', ['SGL2011']],
    ['an `as` that is not an identifier', '@imports: [{ path: "./a.sgl", as: "a b" }]', ['SGL2011']],
    ['a qualified `as`', '@imports: [{ path: "./a.sgl", as: a.b }]', ['SGL2011']],
    ['`as: true`', '@imports: [{ path: "./a.sgl", as: true }]', ['SGL2011']],
    ['an unknown key', '@imports: [{ path: "./a.sgl", from: x }]', ['SGL2011']],
    ['a variable', '@vars: { p: "./a.sgl" }\n@imports: [$p]', ['SGL2011']],
    ['below the root', 'n: { @imports: ["./a.sgl"] }', ['SGL2012']],
  ])('%s is refused', (_name, main, expected) => {
    const { resolveDiags } = link(main, { a: 'a' });
    expect(codes(resolveDiags)).toEqual(expected);
  });

  it('"$x" is the literal path `$x`', () => {
    const { resolveDiags, model } = link('@imports: ["$x"]\n', { $x: '@classes: { D: {} }' });
    expect(resolveDiags).toEqual([]);
    expect(Object.keys(model.classes)).toEqual(['D']);
  });

  it('a redeclared @imports: later wins', () => {
    const { model } = link('@imports: ["./lib.sgl"]\n@imports: [{ path: "./aws.sgl", as: aws }]\n', { lib: LIB, aws: AWS });
    expect(model.imports?.map((i) => i.path)).toEqual(['./aws.sgl']);
    expect(Object.keys(model.classes)).toEqual(['aws.Lambda']);
  });
});

describe('strings are references to an import only through its namespace (I16)', () => {
  it('"$user.name" and "${user.name}" stay literal text when `user` is not an import namespace', () => {
    const { model, diagnostics } = resolve(parse('@vars: { user: "u" }\na: "$user.name"\nb: "hi ${user.name}"\nc: { @label: "$user.name" }\n').ast);
    expect(diagnostics).toEqual([]);
    expect(model.root.children.map((c) => c.config.label)).toEqual(['$user.name', 'hi ${user.name}', '$user.name']);
    expect(model.root.children.map((c) => c.authored)).toEqual([undefined, undefined, undefined]);
  });

  it('…and are references when it is', () => {
    const { model, resolveDiags } = link('@imports: [{ path: "./u.sgl", as: user }]\na: "$user.name"\nb: "hi ${user.name}"\n', { u: '@vars: { name: "Ada" }' });
    expect(resolveDiags).toEqual([]);
    expect(model.root.children.map((c) => c.config.label)).toEqual(['Ada', 'hi Ada']);
  });

  it('the $ns.name token is always a reference: unknown when there is no such namespace', () => {
    const { diagnostics } = resolve(parse('a: { @label: $user.name }\n').ast);
    expect(codes(diagnostics)).toEqual(['SGL2013']);
  });
});

describe('canonical JSON (I31)', () => {
  it('@imports is printed as written, and grafted containers and imported classes are left out', () => {
    const main = '@title: "Main"\n@imports: ["./lib.sgl", { path: "./aws.sgl", as: aws }]\n@classes: { Mine: {} }\nfn: aws.Lambda\n';
    const docs = { lib: LIB, aws: AWS };
    const { model } = link(main, docs);
    const json = toJson(model);
    expect(JSON.parse(json)).toEqual({
      '@sgl': '1.0',
      '@title': 'Main',
      '@imports': ['./lib.sgl', { path: './aws.sgl', as: 'aws' }],
      '@classes': { Mine: {} },
      fn: { '@type': ['aws.Lambda'] },
    });
    const again = link(json, docs).model;
    expect(toJson(again)).toBe(json);
    expect(stripSpans(again)).toEqual(stripSpans(model));
  });

  it('without a host the round trip still keeps @imports (fromJson)', () => {
    const json = toJson(resolveImports(parse('@imports: ["./lib.sgl", { path: "./a.sgl", as: a }]\n').ast).model);
    expect(JSON.parse(json)['@imports']).toEqual(['./lib.sgl', { path: './a.sgl', as: 'a' }]);
    expect(toJson(fromJson(json).model)).toBe(json);
  });

  it("core's own resolve() does not link: it keeps @imports as root configuration, with no effect", () => {
    const { model, diagnostics } = resolve(parse('@imports: ["./lib.sgl"]\nn: Service\n').ast);
    expect(codes(diagnostics)).toEqual(['SGL2002']);
    expect(model.imports).toBeUndefined();
    expect(JSON.parse(toJson(model))['@imports']).toEqual(['./lib.sgl']);
  });

  it('a document without @imports has no `imports` field at all', () => {
    expect('imports' in resolve(parse('a -> b\na\nb\n').ast).model).toBe(false);
  });
});

describe('determinism and the cache (I8, I18)', () => {
  const docs = { lib: LIB, aws: AWS, b: '@imports: [{ path: "./aws.sgl", as: a }]\n@classes: { B: { @extends: a.Lambda } }\nbb\n' };
  const main = '@imports: ["./lib.sgl", { path: "./aws.sgl", as: aws }, { path: "./b.sgl", as: b }]\nfn: aws.Lambda\nx: b.B\nfn -> b.bb\n';

  it('a double run is byte-identical', () => {
    const one = link(main, docs);
    const two = link(main, docs);
    expect(toJson(one.model)).toBe(toJson(two.model));
    expect(JSON.stringify(one.graph)).toBe(JSON.stringify(two.graph));
    expect(JSON.stringify([...one.model.spans])).toBe(JSON.stringify([...two.model.spans]));
    expect(JSON.stringify([one.resolveDiags, one.compileDiags])).toBe(JSON.stringify([two.resolveDiags, two.compileDiags]));
  });

  it('a second resolve with an unchanged closure parses nothing and only looks up', () => {
    const cache = createImportCache();
    const host = memoryHost(docs);
    const cold = link(main, docs, cache, host);
    const lookups = host.calls;
    expect(cache.stats).toEqual({ parses: 3, resolves: 4 });
    const warm = link(`${main}later\n`, docs, cache, host);
    expect(cache.stats).toEqual({ parses: 3, resolves: 4 });
    expect(host.calls).toBe(lookups * 2);
    expect(JSON.stringify(warm.graph.nodes['x' as never])).toBe(JSON.stringify(cold.graph.nodes['x' as never]));
    // What the cache gave is what a cold run of the same text gives.
    const fresh = link(`${main}later\n`, docs);
    expect(toJson(warm.model)).toBe(toJson(fresh.model));
    expect(JSON.stringify(warm.graph)).toBe(JSON.stringify(fresh.graph));
    expect(JSON.stringify([...warm.model.spans])).toBe(JSON.stringify([...fresh.model.spans]));
  });

  it('a changed import is resolved again, and only it', () => {
    const cache = createImportCache();
    link(main, docs, cache);
    const changed = { ...docs, lib: `${LIB}\n@classes: { Extra: {} }\n` };
    const { model } = link(main, changed, cache);
    expect(cache.stats).toEqual({ parses: 4, resolves: 5 });
    expect(Object.keys(model.classes)).toContain('Extra');
  });

  it('warm and cold agree even when the importer uses an imported variable nobody else had computed', () => {
    const lib = '@vars: { a: "x", b: "${a}${a}" }\n';
    const cache = createImportCache();
    const first = link('@imports: ["./lib.sgl"]\nn: { @label: $b }\n', { lib }, cache);
    const second = link('@imports: ["./lib.sgl"]\nn: { @label: $b }\n', { lib }, cache);
    expect(second.model.root.children[0]?.config.label).toBe('xx');
    expect(toJson(second.model)).toBe(toJson(first.model));
  });
});

describe('hasImports', () => {
  it.each([
    ['@imports: ["./a.sgl"]\n', true],
    ['{ "@imports": [] }', true],
    ['a: { @imports: ["./a.sgl"] }\n', false],
    ['a -> b\n', false],
  ])('%j → %s', (source, expected) => {
    expect(hasImports(parse(source).ast)).toBe(expected);
  });
});

function stripSpans<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSpans) as T;
  if (value instanceof Map) return value as T;
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

// ---------------------------------------------------------------------------
// A9 fix round 1
// ---------------------------------------------------------------------------

const errors = (diags: readonly Diagnostic[]): string[] => diags.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

describe('a failed import inside an import is a warning at every depth (fix round 1, item 1; I17)', () => {
  const lib = (inner: string) => `${inner}\nn: {}\n`;

  it('qualified, depth 2: `b.c.Lambda`, `$b.c.v`, "${b.c.v}" and `x -> b.c.q` are SGL2024', () => {
    const { resolveDiags, compileDiags } = link('@imports: [{ path: "./b.sgl", as: b }]\nx: b.c.Lambda\ny: { @label: $b.c.v }\nz: "${b.c.v}"\nx -> b.c.q\n', {
      b: lib('@imports: [{ path: "./nope.sgl", as: c }]'),
    });
    expect(errors([...resolveDiags, ...compileDiags])).toEqual([]);
    expect(codes(resolveDiags).sort()).toEqual(['SGL2021', 'SGL2024', 'SGL2024', 'SGL2024']);
    expect(codes(compileDiags)).toEqual(['SGL2024']);
    expect(resolveDiags.find((d) => d.code === 'SGL2024')?.message).toBe('`b.c.Lambda` may come from `./nope.sgl`, which could not be imported; it was skipped.');
  });

  it('qualified, depth 3: `b.c.d.X` and `x -> b.c.d.q`', () => {
    const { resolveDiags, compileDiags } = link('@imports: [{ path: "./b.sgl", as: b }]\nx: b.c.d.X\nx -> b.c.d.q\n', {
      b: lib('@imports: [{ path: "./c.sgl", as: c }]'),
      c: lib('@imports: [{ path: "./nope.sgl", as: d }]'),
    });
    expect(errors([...resolveDiags, ...compileDiags])).toEqual([]);
    expect(codes(resolveDiags).filter((c) => c === 'SGL2024')).toHaveLength(1);
    expect(codes(compileDiags)).toEqual(['SGL2024']);
  });

  it('unqualified, depth 2 and 3: a bare unknown class or variable is SGL2024', () => {
    for (const docs of [{ b: '@imports: ["./nope.sgl"]\n' }, { b: '@imports: ["./c.sgl"]\n', c: '@imports: ["./nope.sgl"]\n' }]) {
      const { resolveDiags } = link('@imports: ["./b.sgl"]\nx: Lambda\ny: { @label: $v }\n', docs);
      expect(errors(resolveDiags)).toEqual([]);
      expect(codes(resolveDiags).filter((c) => c === 'SGL2024')).toHaveLength(2);
    }
  });

  it('an unqualified import whose own qualified import failed: `c.Lambda`, `$c.v`, `x -> c.q`', () => {
    const { resolveDiags, compileDiags } = link('@imports: ["./b.sgl"]\nx: c.Lambda\ny: { @label: $c.v }\nx -> c.q\n', {
      b: '@imports: [{ path: "./nope.sgl", as: c }]\n',
    });
    expect(errors([...resolveDiags, ...compileDiags])).toEqual([]);
    expect(codes(resolveDiags).filter((c) => c === 'SGL2024')).toHaveLength(2);
    expect(codes(compileDiags)).toEqual(['SGL2024']);
  });

  it('with the inner import resolved, the same unknown names are still errors', () => {
    const { resolveDiags } = link('@imports: [{ path: "./b.sgl", as: b }]\nx: b.c.Nope\n', { b: lib('@imports: [{ path: "./c.sgl", as: c }]'), c: '' });
    expect(codes(resolveDiags)).toEqual(['SGL2002']);
  });
});

describe('compileImports stays linear with a failed import (fix round 1, item 2)', () => {
  it('16 000 edges into a failed namespace finish in under 500 ms', () => {
    const edges = Array.from({ length: 16_000 }, (_, i) => `a -> gone.n${i}`).join('\n');
    const { ast } = parse(`@imports: [{ path: "./nope.sgl", as: gone }]\na\n${edges}\n`);
    const { model } = resolveImports(ast, createImportLinker(memoryHost({}), { self: 'main' }));
    const start = performance.now();
    const { diagnostics } = compileImports(model);
    expect(performance.now() - start).toBeLessThan(500);
    expect(diagnostics).toHaveLength(16_000);
    expect(diagnostics.every((d) => d.code === 'SGL2024')).toBe(true);
  });
});

describe('a duplicate `as` counts as failed (fix round 1, item 3)', () => {
  it('names only the skipped import would have brought are SGL2024, not errors', () => {
    const { resolveDiags, compileDiags } = link('@imports: [{ path: "./lib.sgl", as: x }, { path: "./aws.sgl", as: x }]\nf: x.Lambda\nf -> x.lambda\n', { lib: LIB, aws: AWS });
    expect(errors([...resolveDiags, ...compileDiags])).toEqual([]);
    expect(codes(resolveDiags)).toEqual(['SGL2022', 'SGL2024']);
    expect(codes(compileDiags)).toEqual(['SGL2024']);
  });
});

describe('"${ns.x}" and $ns.x agree through an unqualified import (fix round 1, item 8; I16)', () => {
  it("a namespace an unqualified import brings is one of this document's: the string is a reference too", () => {
    const { model, resolveDiags } = link('@imports: ["./b.sgl"]\na: { @label: $c.x }\nb: "${c.x}!"\nd: "$c.x"\n', {
      b: '@imports: [{ path: "./c.sgl", as: c }]\n',
      c: '@vars: { x: "X" }\n',
    });
    expect(resolveDiags).toEqual([]);
    expect(model.root.children.map((c) => c.config.label)).toEqual(['X', 'X!', 'X']);
  });

  it('"$user.name" stays literal in a document with `as: lib` and its own `user` variable (fix round 1, item 12a)', () => {
    const { model, resolveDiags } = link('@imports: [{ path: "./lib.sgl", as: lib }]\n@vars: { user: "u" }\na: "$user.name"\nb: { @label: "hi ${user.name}" }\n', { lib: LIB });
    expect(resolveDiags).toEqual([]);
    expect(model.root.children.map((c) => c.config.label)).toEqual(['$user.name', 'hi ${user.name}']);
  });
});

describe('SGL2026 only for a library with nodes of its own (fix round 1, item 15)', () => {
  it('a class library whose only root children were grafted from its own imports says nothing', () => {
    const { resolveDiags } = link('@imports: ["./lib.sgl"]\n', { lib: '@imports: [{ path: "./aws.sgl", as: aws }]\n@classes: { L: {} }\n', aws: AWS });
    expect(resolveDiags).toEqual([]);
  });
});

describe('toJson keeps a malformed @imports as written (fix round 1, item 15; I31)', () => {
  it.each([
    ['@imports: ["./a.sgl", 3, { path: "./b.sgl", from: x }, { path: "./a.sgl", as: q }]\n', ['./a.sgl', 3, { path: './b.sgl', from: 'x' }, { path: './a.sgl', as: 'q' }]],
    ['@imports: "./a.sgl"\n', './a.sgl'],
  ])('%j', (main, written) => {
    const first = resolveImports(parse(main).ast, createImportLinker(memoryHost({ a: '' }), { self: 'main' }));
    const json = toJson(first.model);
    expect(JSON.parse(json)['@imports']).toEqual(written);
    const again = resolveImports(parse(json).ast, createImportLinker(memoryHost({ a: '' }), { self: 'main' }));
    expect(toJson(again.model)).toBe(json);
    expect(codes(again.diagnostics)).toEqual(codes(first.diagnostics));
  });
});
