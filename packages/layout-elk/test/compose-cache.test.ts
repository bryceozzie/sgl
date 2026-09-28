import { parse, resolve } from '@sgl/core';
import { layoutPlan, rootLayoutOptions, type EngineSchemas, type LayoutContext, type LayoutEngine, type LayoutInput } from '@sgl/layout-api';
import { composeLayout, LayoutCache, layoutView, viewIndex, type LayoutPlan } from '@sgl/layout-api/compose';
import { conformanceContext } from '@sgl/layout-api/conformance';
import { fixedEngine, gridEngine, radialEngine, treeEngine } from '@sgl/layout-std';
import { beforeAll, describe, expect, it } from 'vitest';
import { editScaleDocument, scaleDocument } from '../../../bench/scale-document.js';
import { elkEngine } from '../src/index.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { layoutInputFor, layoutInputForSource, METRICS } from './corpus-input.js';

/**
 * The per-box layout cache (DD-14 C32, `perf/b8-cache`) with the real
 * engines. Its rules on small stub engines are in
 * `layout-api/test/compose.test.ts`; here:
 *
 * - **the differential test:** random documents of `grid`, `elk`, `fixed`,
 *   `tree` and `radial` boxes, under a `grid`, `elk` or `fixed` root, edited
 *   at random, keystroke by keystroke; each version is composed with the one
 *   cache the sequence keeps and without any, and the two must be identical
 *   (`JSON.stringify` and `toStrictEqual`, which compares numbers with
 *   `Object.is`);
 * - **the keystroke test:** in CPU time, best of three, an edit inside one of
 *   50 `elk` boxes costs well under a quarter of laying all 50 out;
 * - **the bench** (`SGL_BENCH=1` only): section 8.2's documents, cold, warm
 *   and one edit of each kind, with and without the cache, in Node.
 */

const ENGINES: readonly LayoutEngine[] = [elkEngine, gridEngine, fixedEngine, treeEngine, radialEngine];
const engineById = (id: string): LayoutEngine | undefined => ENGINES.find((e) => e.id === id);
const schemasOf = (id: string): EngineSchemas | undefined => {
  const e = engineById(id);
  return e === undefined ? undefined : { id: e.id, ...(e.optionsSchema && { optionsSchema: e.optionsSchema }), ...(e.hintsSchema && { hintsSchema: e.hintsSchema }) };
};

interface Request {
  readonly root: LayoutEngine;
  readonly input: LayoutInput;
  readonly options: Readonly<Record<string, unknown>>;
  readonly plan: LayoutPlan;
}

/** The input, the root's options and the plan, as the app builds them. */
function requestFor(source: string, root: LayoutEngine): Request {
  const { ast } = parse(source);
  const { model } = resolve(ast);
  const options = rootLayoutOptions(ast, model.root.config, schemasOf(root.id)!).options;
  const plan = layoutPlan(ast, model, { engine: root.id, options }, schemasOf).scopes;
  return { root, input: layoutInputForSource(source), options, plan };
}

const ctx = (options: Readonly<Record<string, unknown>>): LayoutContext => conformanceContext(options, METRICS);
const compose = (r: Request, cache?: LayoutCache) => composeLayout(r.root, r.input, r.options, r.plan, engineById, ctx(r.options), cache);

// ---------------------------------------------------------------------------
// The differential test.
// ---------------------------------------------------------------------------

/** mulberry32: a seeded, reproducible sequence (the test's own, not an engine's). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BoxEngine = 'grid' | 'elk' | 'fixed' | 'tree' | 'radial';
const BOX_ENGINES: readonly BoxEngine[] = ['grid', 'elk', 'fixed', 'tree', 'radial'];

interface Leaf {
  name: string;
  label: string;
  pin?: { x: number; y: number };
}
interface Box {
  name: string;
  engine: BoxEngine;
  option: string | undefined;
  leaves: Leaf[];
  inner: Box | undefined;
}
interface Doc {
  root: 'grid' | 'elk' | 'fixed';
  /** The root's own `@layout` option: a box of the root's engine that does
   *  not set it inherits it (C6), with no change to its own text. */
  rootOption: string | undefined;
  comments: number;
  tops: string[];
  boxes: Box[];
  edges: [string, string][];
}

const OPTIONS: Readonly<Record<BoxEngine, readonly (string | undefined)[]>> = {
  grid: [undefined, 'columns: 1', 'columns: 3', 'gap: 8'],
  elk: [undefined, 'direction: right', 'direction: up'],
  fixed: [undefined, 'gap: 12'],
  tree: [undefined, 'direction: right', 'rankSpacing: 50'],
  radial: [undefined, 'rankSpacing: 90', 'nodeSpacing: 20'],
};

function generator(seed: number) {
  const rand = prng(seed);
  const int = (n: number): number => Math.floor(rand() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  let fresh = 0;
  const leaf = (engine: BoxEngine): Leaf => {
    fresh += 1;
    return { name: `n${fresh}`, label: pick(['A', 'Beta', 'Gamma delta', 'e']), ...(engine === 'fixed' && rand() < 0.7 && { pin: { x: int(5) * 30, y: int(4) * 30 } }) };
  };
  const box = (depth: number): Box => {
    fresh += 1;
    const engine = pick(BOX_ENGINES);
    return { name: `b${fresh}`, engine, option: pick(OPTIONS[engine]), leaves: Array.from({ length: 2 + int(4) }, () => leaf(engine)), inner: depth < 1 && rand() < 0.3 ? box(depth + 1) : undefined };
  };
  /** Every leaf's path, box by box (the inner box's leaves under its parent's). */
  const paths = (d: Doc): string[][] =>
    d.boxes.flatMap((b) => {
      const own = [b.leaves.map((l) => `${b.name}.${l.name}`)];
      return b.inner === undefined ? own : [...own, b.inner.leaves.map((l) => `${b.name}.${b.inner!.name}.${l.name}`)];
    });
  const randomEdge = (d: Doc): [string, string] | undefined => {
    const groups = paths(d).filter((g) => g.length > 1);
    if (groups.length === 0) return undefined;
    if (rand() < 0.75) {
      const g = pick(groups);
      const i = int(g.length - 1);
      return [g[i]!, g[i + 1 + int(g.length - 1 - i)]!];
    }
    return [pick(pick(groups)), pick([...pick(groups), ...d.tops])];
  };
  const initial = (): Doc => {
    const d: Doc = { root: pick(['grid', 'elk', 'elk', 'fixed'] as const), rootOption: undefined, comments: 0, tops: ['top0'], boxes: Array.from({ length: 3 + int(3) }, () => box(0)), edges: [] };
    for (let i = 0; i < 6; i += 1) {
      const e = randomEdge(d);
      if (e !== undefined) d.edges.push(e);
    }
    return d;
  };
  const anyBox = (d: Doc): Box => {
    const all = d.boxes.flatMap((b) => (b.inner === undefined ? [b] : [b, b.inner]));
    return pick(all);
  };
  /** One keystroke-sized edit, in place; its name, for the failure message. */
  const edit = (d: Doc): string => {
    const b = anyBox(d);
    switch (int(11)) {
      case 10:
        if (rand() < 0.25) {
          d.root = pick(['grid', 'elk', 'fixed'] as const);
          d.rootOption = undefined;
          return 'the root engine';
        }
        d.rootOption = pick(OPTIONS[d.root]);
        return "the root's options";
      case 0:
        b.leaves.push(leaf(b.engine));
        return `add a node to ${b.name}`;
      case 1:
        if (b.leaves.length > 1) {
          const [gone] = b.leaves.splice(int(b.leaves.length), 1);
          d.edges = d.edges.filter(([f, t]) => !f.endsWith(`.${gone!.name}`) && !t.endsWith(`.${gone!.name}`));
        }
        return `remove a node from ${b.name}`;
      case 2:
        pick(b.leaves).label += pick(['x', ' more', 'W']);
        return `relabel a node in ${b.name}`;
      case 3:
        b.option = pick(OPTIONS[b.engine]);
        return `options of ${b.name}`;
      case 4:
        d.tops.unshift(`top${d.tops.length}`);
        return 'a top-level node before every box';
      case 5:
        d.comments += 1;
        return 'a comment line at the top';
      case 6: {
        const e = randomEdge(d);
        if (e !== undefined) d.edges.push(e);
        return 'add an edge';
      }
      case 7:
        if (d.edges.length > 0) d.edges.splice(int(d.edges.length), 1);
        return 'remove an edge';
      case 8:
        b.engine = pick(BOX_ENGINES);
        b.option = undefined;
        return `engine of ${b.name}`;
      default: {
        const l = pick(b.leaves);
        if (l.pin === undefined) l.pin = { x: int(5) * 30, y: int(4) * 30 };
        else delete l.pin;
        return `pin in ${b.name}`;
      }
    }
  };
  return { initial, edit };
}

function source(d: Doc): string {
  const lines: string[] = [];
  for (let i = 0; i < d.comments; i += 1) lines.push(`// edit ${i}`);
  lines.push(`@layout: { engine: ${d.root}${d.rootOption === undefined ? '' : `, ${d.rootOption}`} }`);
  d.tops.forEach((t, i) => lines.push(`${t}: { @label: "Top"${d.root === 'fixed' ? `, @pin: { x: ${i * 90}, y: 0 }` : ''} }`));
  const emit = (b: Box, indent: string, i: number): void => {
    lines.push(`${indent}${b.name}: {`);
    lines.push(`${indent}  @layout: { engine: ${b.engine}${b.option === undefined ? '' : `, ${b.option}`} }`);
    if (d.root === 'fixed' && indent === '') lines.push(`${indent}  @pin: { x: ${i * 400}, y: 200 }`);
    for (const l of b.leaves) lines.push(`${indent}  ${l.name}: { @label: "${l.label}"${l.pin === undefined ? '' : `, @pin: { x: ${l.pin.x}, y: ${l.pin.y} }`} }`);
    if (b.inner !== undefined) emit(b.inner, `${indent}  `, 0);
    lines.push(`${indent}}`);
  };
  d.boxes.forEach((b, i) => emit(b, '', i));
  for (const [f, t] of d.edges) lines.push(`${f} -> ${t}`);
  return `${lines.join('\n')}\n`;
}

const ROOTS: Readonly<Record<Doc['root'], LayoutEngine>> = { grid: gridEngine, elk: elkEngine, fixed: fixedEngine };
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const STEPS = 40;

describe('the per-box cache: cached and uncached composition agree exactly (differential)', () => {
  it.each(SEEDS)('seed %i: 40 random edits over grid, elk, fixed, tree and radial boxes', async (seed) => {
    const { initial, edit } = generator(seed);
    const doc = initial();
    const cache = new LayoutCache();
    const engines = new Set<string>();
    let what = 'the first version';
    for (let step = 0; step <= STEPS; step += 1) {
      if (step > 0) what = edit(doc);
      const text = source(doc);
      const request = requestFor(text, ROOTS[doc.root]);
      for (const s of request.plan) engines.add(s.engine);
      const cached = await compose(request, cache);
      const fresh = await compose(request);
      const label = `seed ${seed}, step ${step} (${what}):\n${text}`;
      expect(JSON.stringify(cached), label).toBe(JSON.stringify(fresh));
      expect(cached, label).toStrictEqual(fresh);
    }
    // Not vacuous: boxes were reused, and some laid out again.
    expect(cache.hits).toBeGreaterThan(20);
    expect(cache.misses).toBeGreaterThan(5);
    expect(engines.size).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('the seeds cover every box engine, notes (fixed boxes with loose nodes), and a box inside a box', () => {
    const engines = new Set<string>();
    let nested = 0;
    let loose = 0;
    for (const seed of SEEDS) {
      const { initial, edit } = generator(seed);
      const doc = initial();
      for (let step = 0; step <= STEPS; step += 1) {
        if (step > 0) edit(doc);
        for (const b of doc.boxes) {
          for (const x of b.inner === undefined ? [b] : [b, b.inner]) {
            engines.add(x.engine);
            if (x.engine === 'fixed' && x.leaves.some((l) => l.pin === undefined)) loose += 1;
          }
          if (b.inner !== undefined) nested += 1;
        }
      }
    }
    expect([...engines].sort()).toEqual(['elk', 'fixed', 'grid', 'radial', 'tree']);
    expect(nested).toBeGreaterThan(0);
    expect(loose).toBeGreaterThan(0);
  });
});

describe("layoutView with a request's index builds the same view (perf/b8-cache)", () => {
  it('over every corpus document, the root and every container, with and without inner boxes', () => {
    let views = 0;
    for (const name of listCorpusDocs()) {
      const input = layoutInputFor(name);
      const { graph } = input;
      const index = viewIndex(graph);
      const containers = graph.order.filter((id) => graph.nodes[id]!.children.length > 0);
      for (const scope of [null, ...containers]) {
        const inner = new Map(containers.filter((id) => id !== scope).map((id) => [id, { w: 33, h: 21 }] as const));
        for (const boxes of [new Map(), inner]) {
          expect(layoutView(input, scope, boxes, index), `${name}, ${scope ?? 'root'}`).toStrictEqual(layoutView(input, scope, boxes));
          views += 1;
        }
      }
    }
    expect(views).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------
// The keystroke test (CPU time, best of three).
// ---------------------------------------------------------------------------

describe('the per-box cache: a keystroke inside one box lays out that box', () => {
  let base: Request;
  let edits: Request[];
  beforeAll(async () => {
    const text = scaleDocument(500, { boxes: 'elk' });
    base = requestFor(text, gridEngine);
    edits = [10, 20, 30].map((k) => requestFor(editScaleDocument(text, 'inside', k), gridEngine));
    await compose(base); // elkjs loaded, the JIT warm
  }, 60_000);

  const cpu = async (run: () => Promise<unknown>): Promise<number> => {
    const t0 = process.cpuUsage();
    await run();
    const { user, system } = process.cpuUsage(t0);
    return (user + system) / 1000;
  };

  // 50 `elk` boxes of 10: laying them all out is ~0.5 s of CPU; an edit
  // inside one, with the cache, is one ELK call, the `grid` root and the
  // keys (~20–40 ms). Without the cache the two are the same, so a limit of a
  // quarter tells them apart under any load (CPU time, not wall time).
  it('an edit inside one of 50 elk boxes costs well under a quarter of laying all 50 out', async () => {
    let full = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i += 1) full = Math.min(full, await cpu(() => compose(base)));
    const cache = new LayoutCache();
    let edit = Number.POSITIVE_INFINITY;
    for (const next of edits) {
      await compose(base, cache);
      edit = Math.min(edit, await cpu(() => compose(next, cache)));
    }
    expect(edit, `edit ${edit.toFixed(0)} ms of CPU against ${full.toFixed(0)} ms for all 50 boxes`).toBeLessThan(full / 4);
  }, 60_000);
});

describe("the per-box cache: what a request costs when every box is cached grows linearly", () => {
  let small: Request;
  let large: Request;
  const caches = new Map<Request, LayoutCache>();
  beforeAll(async () => {
    small = requestFor(scaleDocument(250, { boxes: 'grid' }), gridEngine);
    large = requestFor(scaleDocument(4000, { boxes: 'grid' }), gridEngine);
    caches.set(small, new LayoutCache()).set(large, new LayoutCache());
    for (const r of [small, large, small, large]) await compose(r, caches.get(r));
  }, 60_000);

  // With every box cached, a request is the composer's own work: the views
  // and keys, the root's layer, moving and merging. Building each box's
  // view by a pass over the whole graph made that quadratic (200 views of a
  // 2 000-node document took ~150 ms); `viewIndex` makes each view cost its
  // own size. 16× the nodes, measured in CPU time: 10–27× with the index,
  // 123–134× with the per-view pass; the verdict is the median of three
  // ratios, each best of three.
  it('16× the boxes, all cached, costs well under 50× as much CPU (median of three ratios, each best of three)', async () => {
    const best = async (r: Request): Promise<number> => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const t0 = process.cpuUsage();
        await compose(r, caches.get(r));
        const { user, system } = process.cpuUsage(t0);
        min = Math.min(min, (user + system) / 1000);
      }
      return min;
    };
    const ratios: number[] = [];
    for (let round = 0; round < 3; round += 1) ratios.push((await best(large)) / Math.max(await best(small), 0.5));
    ratios.sort((a, b) => a - b);
    console.warn(`[B8-CACHE-LINEAR] ${ratios.map((r) => r.toFixed(1)).join(' / ')}`);
    expect(ratios[1], `ratios ${ratios.map((r) => r.toFixed(1)).join(', ')}`).toBeLessThan(50);
    expect([caches.get(small)!.misses, caches.get(large)!.misses]).toEqual([25, 400]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The bench (SGL_BENCH=1): DD-14 section 8.2's documents in Node.
// ---------------------------------------------------------------------------

describe.skipIf(process.env['SGL_BENCH'] === undefined)('the per-box cache: section 8.2 bench in Node (SGL_BENCH=1)', () => {
  it('prints cold, warm and one edit of each kind, with and without the cache', async () => {
    const variants = [
      ['elk root, grid boxes', elkEngine, 'grid'],
      ['grid root, elk boxes', gridEngine, 'elk'],
      ['elk root, elk boxes', elkEngine, 'elk'],
    ] as const;
    await compose(requestFor(scaleDocument(100, { boxes: 'elk' }), gridEngine)); // elkjs loaded
    for (const [name, root, boxes] of variants) {
      const text = scaleDocument(2000, { boxes });
      const base = requestFor(text, root);
      for (const cached of [false, true]) {
        const cache = cached ? new LayoutCache() : undefined;
        const time = async (r: Request): Promise<number> => {
          const t0 = performance.now();
          await compose(r, cache);
          return performance.now() - t0;
        };
        const line = (what: string, times: readonly number[]): string => {
          const sorted = [...times].sort((a, b) => a - b);
          return `${what} best ${sorted[0]!.toFixed(0)} / median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms`;
        };
        const parts = [`cold ${(await time(base)).toFixed(0)} ms`, line('warm', [await time(base), await time(base), await time(base)])];
        for (const kind of ['inside', 'outside', 'options'] as const) {
          const times: number[] = [];
          for (const k of [50, 100, 150]) {
            times.push(await time(requestFor(editScaleDocument(text, kind, k), root)));
            await time(base);
          }
          parts.push(line(`edit ${kind}`, times));
        }
        console.warn(`[B8-CACHE-NODE] ${name}, 2 000 nodes, ${cached ? 'cached' : 'uncached'}: ${parts.join('; ')}${cache === undefined ? '' : ` (${cache.size} entries, ${(cache.bytes / 1e6).toFixed(1)} MB)`}`);
      }
    }
  }, 900_000);
});
