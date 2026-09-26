import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../src/diagnostics.js';
import { compileImports, createImportCache, createImportLinker, resolveImports, type ImportCache } from '../src/imports.js';
import { toJson } from '../src/json.js';
import { parse } from '../src/parse.js';
import { fileSystemHost } from './fs-host.js';

/**
 * `corpus/imports/` (A9, DD-02 §10.8): documents that import one another,
 * run by the file-system host. Every document's diagnostics, all stages,
 * exactly; `main.sgl`'s resolve and compile goldens; the canonical-JSON
 * round trip with the same host (I31); and a double run. The coverage gate
 * (`diagnostics-coverage.test.ts`) runs the same documents the same way.
 */

const dir = fileURLToPath(new URL('../../../corpus/imports/', import.meta.url));
const FILES = readdirSync(dir)
  .filter((f) => /\.sgl(\.json)?$/.test(f))
  .sort();

function run(name: string, source = readFileSync(`${dir}${name}`, 'utf8'), cache?: ImportCache) {
  const path = `${dir}${name}`;
  const { ast, diagnostics: syntax } = parse(source);
  const resolved = resolveImports(ast, createImportLinker(fileSystemHost(path), { self: path, ...(cache !== undefined ? { cache } : {}) }));
  const compiled = compileImports(resolved.model);
  return { model: resolved.model, graph: compiled.graph, diagnostics: [...syntax, ...resolved.diagnostics, ...compiled.diagnostics] };
}

const codes = (diags: readonly Diagnostic[]): string[] => diags.map((d) => `${d.code} ${d.severity}`);

/** Every document's diagnostics, in order: a fixture's own `// expects:`
 *  code among them, and nothing else unaccounted for. */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  'ambiguous.sgl': ['SGL2018 warning'],
  'aws-icons.sgl': [],
  // Its own problem, an error in it; problems.sgl sees one SGL2021.
  'broken-lib.sgl': ['SGL2002 error'],
  'clash.sgl': ['SGL2022 warning'],
  'cycle-a.sgl': ['SGL2019 warning'],
  'cycle-b.sgl': ['SGL2019 warning'],
  'deep.sgl': ['SGL2020 warning'],
  'deep-1.sgl': [],
  'deep-2.sgl': [],
  'deep-3.sgl': [],
  'deep-4.sgl': [],
  'deep-5.sgl': [],
  'deep-6.sgl': [],
  'deep-7.sgl': [],
  'deep-8.sgl': [],
  'dup.sgl': [],
  'dup.sgl.json': [],
  'main.sgl': [],
  'node-clash.sgl': ['SGL2031 warning'],
  'nodes-without-as.sgl': ['SGL2026 info'],
  'nothing.sgl': [],
  'problems.sgl': ['SGL2021 warning'],
  'remote.sgl': ['SGL2025 warning'],
  'shadow.sgl': ['SGL2023 info'],
  'shared-classes.sgl': [],
  'too-many-items.sgl': ['SGL2028 warning', 'SGL2030 warning'],
  'too-many.sgl': ['SGL2028 warning'],
  'too-wide.sgl': ['SGL2029 warning'],
  // The class and the edge through the failed namespace: SGL2024, from
  // the resolve and from the compile (I17). Nothing is an error.
  'unresolved.sgl': ['SGL2017 warning', 'SGL2024 warning', 'SGL2024 warning'],
  'wide.sgl': [],
};

describe('corpus/imports (A9, DD-02 §10.8)', () => {
  it('every document has an expectation, and every expectation a document', () => {
    expect(FILES).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(FILES)('%s: exactly its diagnostics', (name) => {
    const source = readFileSync(`${dir}${name}`, 'utf8');
    const { diagnostics } = run(name, source);
    expect(codes(diagnostics)).toEqual(EXPECTED[name]);
    const header = /\/\/ expects: (SGL\d{4})/.exec(source)?.[1];
    if (header !== undefined) expect(diagnostics.map((d) => d.code)).toContain(header);
  });

  it('main.sgl: the resolve and compile goldens', async () => {
    const { model, graph } = run('main.sgl');
    await expect(toJson(model)).toMatchFileSnapshot('./__goldens__/resolve/imports/main.sgl.json');
    await expect(`${JSON.stringify(graph, null, 2)}\n`).toMatchFileSnapshot('./__goldens__/compile/imports/main.sgl.json');
  });

  it('main.sgl: what arrived, where', () => {
    const { model, graph } = run('main.sgl');
    expect(Object.keys(model.classes)).toEqual(['Service', 'Critical', 'aws.Lambda']);
    expect(model.root.children.map((c) => c.key)).toEqual(['aws', 'api', 'worker', 'db']);
    expect(graph.nodes['api' as never]).toMatchObject({ classes: ['Service', 'Critical'], shape: 'round' });
    expect(graph.nodes['worker' as never]).toMatchObject({ classes: ['aws.Lambda'], shape: 'hexagon' });
    expect(model.root.children.find((c) => c.key === 'api')?.config.label).toBe('API (prod)');
    expect(model.root.children.find((c) => c.key === 'db')?.config.style).toEqual({ stroke: '#FF9900' });
    expect(graph.edges.map((e) => `${e.from.node}->${e.to.node}`)).toEqual(['api->worker', 'worker->aws.queue', 'api->db', 'aws.lambda->aws.queue']);
  });

  it.each(FILES)('%s: the canonical-JSON round trip, with the same host (I31)', (name) => {
    const first = run(name);
    const json = toJson(first.model);
    const again = run(name, json);
    expect(toJson(again.model)).toBe(json);
    expect(JSON.stringify(again.graph.order)).toBe(JSON.stringify(first.graph.order));
    expect(Object.keys(again.model.classes)).toEqual(Object.keys(first.model.classes));
  });

  /** Everything a run produces, as one string. */
  const bytes = (r: ReturnType<typeof run>): string =>
    JSON.stringify([toJson(r.model), r.graph, [...r.model.spans], r.diagnostics]);

  /** DD-02 I8, I18: the app keeps one `ImportCache` for the pipeline's life,
   *  across keystrokes and document switches (it keeps what the last two
   *  root runs used). Every document is run through one shared cache first,
   *  in both orders, so each run below starts from what other documents'
   *  runs left in it: after a switch, then on a keystroke. Both are
   *  byte-identical to a cold run, and the keystroke parses nothing. */
  const shared = createImportCache();
  for (const name of [...FILES, ...[...FILES].reverse()]) run(name, undefined, shared);

  it.each(FILES)('%s: a double run through a warm shared cache is byte-identical to a cold one; the second parses nothing', (name) => {
    const cold = bytes(run(name));
    const afterSwitch = bytes(run(name, undefined, shared));
    const parses = shared.stats.parses;
    const keystroke = bytes(run(name, undefined, shared));
    expect(afterSwitch).toBe(cold);
    expect(keystroke).toBe(cold);
    expect(shared.stats.parses).toBe(parses);
  });

  it.each(FILES)('%s: a double run is byte-identical', (name) => {
    const a = run(name);
    const b = run(name);
    expect(toJson(a.model)).toBe(toJson(b.model));
    expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph));
    expect(JSON.stringify([...a.model.spans])).toBe(JSON.stringify([...b.model.spans]));
    expect(JSON.stringify(a.diagnostics)).toBe(JSON.stringify(b.diagnostics));
  });
});
