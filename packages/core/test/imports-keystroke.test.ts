import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scaleDocument } from '../../../bench/scale-document.js';
import { compile } from '../src/compile.js';
import { compileImports, createImportCache, createImportLinker, resolveImports, type ImportHost } from '../src/imports.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';
import { fileSystemHost } from './fs-host.js';
import { memoryHost } from './import-host.js';

/**
 * A9's keystroke bench (DD-02 §10.8, I8): a 50-node document importing a
 * 500-node library (`bench/imports/`, written by `bench/generate.js`), typed
 * into with its imports unchanged. The app keeps one linker per open
 * document and one `ImportCache` (DD-08 §15.2), so a keystroke costs the
 * importer's own parse, resolve and compile plus **lookups only**: no parse
 * and no resolve of the import. That is asserted, by the cache's counters
 * and the host's calls; the time is printed (`[A9-BENCH]`), as the other
 * benches do, and held only to DD-09 §2's keystroke budget, 60 ms at 50
 * nodes, which these stages use a small part of (layout is debounced and off
 * the keystroke path).
 *
 * Fix round 1 (item 14): every simulated keystroke is checked to change the
 * source; the `as:` case (the library's 500 nodes grafted on every
 * keystroke) and eight 1 500-node libraries `as:` are measured too. Those
 * scale with the imported node count: grafted, the document *is* that many
 * nodes on every keystroke, and compiling them is most of it (measured: the
 * graft is cheaper than resolving the same nodes written in the document;
 * `compileImports` costs what `compile()` costs for them). A known cost,
 * DD-02 §10.8 and execution plan §2.1 F23.
 */

const dir = fileURLToPath(new URL('../../../bench/imports/', import.meta.url));
const IMPORTER = `${dir}importer50.sgl`;
const KEYSTROKES = 40;

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

/** The document after `i` keystrokes: one more character in a label. */
const typed = (source: string, i: number): string => source.replace('"Node number 7"', `"Node number 7${'x'.repeat(i)}"`);

/** Types `KEYSTROKES` characters into `source` through one linker and one
 *  cache, and returns the medians; asserts each keystroke changed the text,
 *  and that, after the first, nothing imported is parsed or resolved again. */
function typeInto(source: string, host: ImportHost, self: string, check?: (graph: ReturnType<typeof compileImports>['graph']) => void, keystrokes = KEYSTROKES) {
  let lookups = 0;
  const counted: ImportHost = {
    lookup(path, from) {
      lookups += 1;
      return host.lookup(path, from);
    },
  };
  const cache = createImportCache();
  const linker = createImportLinker(counted, { self, cache });
  const keystroke = (text: string) => {
    const start = performance.now();
    const { ast } = parse(text);
    const { model, diagnostics } = resolveImports(ast, linker);
    const { graph } = compileImports(model);
    return { ms: performance.now() - start, diagnostics, graph };
  };
  const cold = keystroke(source);
  const stats = { ...cache.stats };
  const perKeystroke = lookups;
  const warm: number[] = [];
  let previous = source;
  for (let i = 1; i <= keystrokes; i += 1) {
    const text = typed(source, i);
    expect(text).not.toBe(previous); // the keystroke really changed the document
    previous = text;
    const before = lookups;
    const run = keystroke(text);
    warm.push(run.ms);
    expect(cache.stats).toEqual(stats); // nothing parsed or resolved again…
    expect(lookups - before).toBe(perKeystroke); // …the imports looked up, as many times as the first run
    check?.(run.graph);
  }
  return { cold, stats, perKeystroke, median: median(warm) };
}

describe('a keystroke with unchanged imports (A9, DD-02 §10.8)', () => {
  expect(existsSync(IMPORTER), 'run `pnpm generate:corpus` first').toBe(true);
  const source = readFileSync(IMPORTER, 'utf8');

  it('costs lookups only, and stays inside the 50-node keystroke budget', () => {
    const r = typeInto(source, fileSystemHost(IMPORTER), IMPORTER, (graph) => expect(graph.nodes['g0.n0' as never]).toMatchObject({ shape: 'round' }));
    expect(r.cold.diagnostics.map((d) => d.code)).toEqual(['SGL2026']); // the library's nodes are not imported
    expect(r.cold.graph.nodes['g0.n0' as never]).toMatchObject({ classes: ['Service', 'Critical'], shape: 'round' });
    expect(r.stats).toEqual({ parses: 1, resolves: 1 });
    expect(r.perKeystroke).toBe(1);

    // The same document without its import, through core alone: what the
    // keystroke costs anyway.
    const plain = source.replace('@imports: ["./lib500.sgl"]\n', '').replace('@type: Critical, ', '');
    const base: number[] = [];
    for (let i = 1; i <= KEYSTROKES; i += 1) {
      const start = performance.now();
      compile(resolve(parse(typed(plain, i)).ast).model);
      base.push(performance.now() - start);
    }
    console.log(
      `[A9-BENCH] keystroke, 50-node importer of a 500-node import, imports unchanged: median ${r.median.toFixed(2)} ms ` +
        `(same document without the import ${median(base).toFixed(2)} ms; first resolve, cold, ${r.cold.ms.toFixed(2)} ms; ${KEYSTROKES} keystrokes, Node, parse + resolve + compile)`,
    );
    expect(r.median).toBeLessThan(60);
  });

  it('with `as:`, the 500 nodes grafted on every keystroke (fix round 1, item 14)', () => {
    const asSource = source.replace('@imports: ["./lib500.sgl"]', '@imports: [{ path: "./lib500.sgl", as: lib }]').replace('@type: Critical', '@type: lib.Critical');
    const r = typeInto(asSource, fileSystemHost(IMPORTER), IMPORTER, (graph) => expect(graph.order.length).toBe(50 + 5 + 500 + 50 + 1));
    expect(r.cold.diagnostics).toEqual([]);
    console.log(`[A9-BENCH] keystroke, 50-node importer of a 500-node import \`as: lib\` (500 nodes grafted): median ${r.median.toFixed(2)} ms (${KEYSTROKES} keystrokes, Node)`);
  });

  it('eight 1 500-node libraries `as:` (12 000 grafted nodes): measured, a known cost (fix round 1, item 14)', () => {
    const docs: Record<string, string> = {};
    for (let i = 0; i < 8; i += 1) docs[`lib${i}`] = scaleDocument(1500);
    const main = `@imports: [${Array.from({ length: 8 }, (_, i) => `{ path: "./lib${i}.sgl", as: l${i} }`).join(', ')}]\n${scaleDocument(50)}`;
    const r = typeInto(main, memoryHost(docs), 'main', undefined, 6);
    expect(r.stats).toEqual({ parses: 1, resolves: 8 });
    console.log(`[A9-BENCH] keystroke, 50-node importer of eight 1 500-node imports \`as:\` (12 000 nodes grafted): median ${r.median.toFixed(2)} ms (6 keystrokes, Node)`);
  }, 60_000);
});
