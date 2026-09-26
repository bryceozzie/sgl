import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { compileImports, createImportCache, createImportLinker, resolveImports, type ImportHost } from '../src/imports.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';
import { fileSystemHost } from './fs-host.js';

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

describe('a keystroke with unchanged imports (A9, DD-02 §10.8)', () => {
  it('costs lookups only, and stays inside the 50-node keystroke budget', () => {
    expect(existsSync(IMPORTER), 'run `pnpm generate:corpus` first').toBe(true);
    const source = readFileSync(IMPORTER, 'utf8');
    const fs = fileSystemHost(IMPORTER);
    let lookups = 0;
    const host: ImportHost = {
      lookup(path, from) {
        lookups += 1;
        return fs.lookup(path, from);
      },
    };
    const cache = createImportCache();
    const linker = createImportLinker(host, { self: IMPORTER, cache });
    const keystroke = (text: string) => {
      const start = performance.now();
      const { ast } = parse(text);
      const { model, diagnostics } = resolveImports(ast, linker);
      const { graph } = compileImports(model);
      return { ms: performance.now() - start, model, diagnostics, graph };
    };

    const cold = keystroke(source);
    expect(cold.diagnostics.map((d) => d.code)).toEqual(['SGL2026']); // the library's nodes are not imported
    expect(cold.graph.nodes['g0.n0' as never]).toMatchObject({ classes: ['Service', 'Critical'], shape: 'round' });
    expect(cache.stats).toEqual({ parses: 1, resolves: 1 });

    const warm: number[] = [];
    for (let i = 1; i <= KEYSTROKES; i += 1) {
      const before = lookups;
      const run = keystroke(typed(source, i));
      warm.push(run.ms);
      expect(cache.stats).toEqual({ parses: 1, resolves: 1 }); // nothing parsed or resolved again…
      expect(lookups - before).toBe(1); // …the import looked up, once (the library has no imports of its own for the cache to re-check)
      expect(run.graph.nodes['g0.n0' as never]).toMatchObject({ shape: 'round' });
    }

    // The same document without its import, through core alone: what the
    // keystroke costs anyway.
    const plain = source.replace('@imports: ["./lib500.sgl"]\n', '').replace('@type: Critical, ', '');
    const base: number[] = [];
    for (let i = 1; i <= KEYSTROKES; i += 1) {
      const start = performance.now();
      compile(resolve(parse(typed(plain, i)).ast).model);
      base.push(performance.now() - start);
    }

    const [w, b] = [median(warm), median(base)];
    console.log(
      `[A9-BENCH] keystroke, 50-node importer of a 500-node import, imports unchanged: median ${w.toFixed(2)} ms ` +
        `(same document without the import ${b.toFixed(2)} ms; first resolve, cold, ${cold.ms.toFixed(2)} ms; ${KEYSTROKES} keystrokes, Node, parse + resolve + compile)`,
    );
    expect(w).toBeLessThan(60);
  });
});
