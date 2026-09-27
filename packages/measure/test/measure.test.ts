import { describe, expect, it } from 'vitest';
import type { EdgeId, LabelId, NodeId, SemanticGraph } from '@sgl/core';
import type { ComputedStyle, StyledGraph } from '@sgl/theme';
import { corpusStyledGraph, listCorpusDocs } from '../../theme/test/corpus.js';
import { CanvasMeasurer, canvasIsAvailable } from '../src/canvas-measurer.js';
import { createDefaultMeasurer } from '../src/default-measurer.js';
import { glyphCount, layoutLines, type MeasureRun } from '../src/line-model.js';
import { labelBox, labelRunKey, labelRuns, premeasure, textStyleOf } from '../src/premeasure.js';
import { canonicalRunKey, hashRuns, UNCONSTRAINED } from '../src/run-key.js';
import {
  fontClassOf,
  StaticMetricsMeasurer,
  staticAdvance,
  STATIC_METRICS,
} from '../src/static-measurer.js';
import { TableMeasurer } from '../src/table-measurer.js';
import { layoutWrapped } from '@sgl/text/wrap';
import { MeasureMiss, type StyledRun, type TextStyle } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// `fixtureGraph` below is still built by hand: it exists to engineer three specific
// edge cases the corpus does not contain (Stage D, 07 §5) — a label with zero runs
// (impossible from real `.sgl` source: `compile()` gives an empty `@label` no
// `labelId` at all, never an empty `runs` array), and precise control over which
// two labels share text and style. Everything that only needs *some* real,
// compiler-shaped `StyledGraph` now draws on `corpus/` via `corpusStyledGraph`
// (`packages/theme/test/corpus.ts`) — see "premeasure: over the corpus" below.
// ---------------------------------------------------------------------------

const BASE_STYLE: TextStyle = {
  fontFamily: 'Inter, sans-serif',
  fontSize: 13,
  fontWeight: 500,
  fontStyle: 'normal',
  lineHeight: 1.3,
  letterSpacing: 0,
};

const run = (text: string, style: TextStyle = BASE_STYLE): StyledRun => ({ text, style });

const id = <T extends string>(s: string): T => s as T;

/** Only the six text properties matter to this package; the rest of a real
 *  `ComputedStyle` is irrelevant here, so the bags are minimal. */
function textStyle(over: Partial<TextStyle> = {}): ComputedStyle {
  const s = { ...BASE_STYLE, ...over };
  return {
    geometry: {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      fontStyle: s.fontStyle,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
    },
    paint: { color: '#1B2330' },
    geometryHash: 'fixture-geometry',
    paintHash: 'fixture-paint',
  };
}

const SPAN = { from: 0, to: 0 };

/**
 * Six labels: a plain node title, a two-line node title, a container title at a
 * different weight and size, an edge label, a label whose text repeats another's
 * verbatim (so the table must fold it onto one entry), and an empty-run label.
 */
function fixtureGraph(): StyledGraph {
  const node = (name: string, labelId: string | null): [NodeId, SemanticGraph['nodes'][NodeId]] => [
    id<NodeId>(name),
    {
      id: id<NodeId>(name),
      path: name.split('.'),
      parent: name.includes('.') ? id<NodeId>(name.slice(0, name.lastIndexOf('.'))) : null,
      children: [],
      depth: name.split('.').length - 1,
      shape: 'rect',
      classes: [],
      labelId: labelId === null ? null : id<LabelId>(labelId),
      ports: [],
      config: {},
      hidden: false,
      span: SPAN,
    },
  ];

  const graph: SemanticGraph = {
    nodes: Object.fromEntries([
      node('platform', 'l:platform'),
      node('platform.api', 'l:platform.api'),
      node('platform.worker', 'l:platform.worker'),
      node('store', 'l:store'),
      node('ghost', 'l:ghost'),
    ]),
    edges: [
      {
        id: id<EdgeId>('e-0001'),
        from: { node: id<NodeId>('platform.api') },
        to: { node: id<NodeId>('store') },
        directed: 'forward',
        classes: [],
        labelId: id<LabelId>('l:e-0001'),
        config: {},
        declaredIn: null,
        hidden: false,
        span: SPAN,
      },
    ],
    rootChildren: [id<NodeId>('platform'), id<NodeId>('store'), id<NodeId>('ghost')],
    order: [
      id<NodeId>('platform'),
      id<NodeId>('platform.api'),
      id<NodeId>('platform.worker'),
      id<NodeId>('store'),
      id<NodeId>('ghost'),
    ],
    labels: {
      // Container title — heavier and smaller, per neutral-light's container.title.
      [id<LabelId>('l:platform')]: {
        id: id<LabelId>('l:platform'),
        owner: { kind: 'node', id: id<NodeId>('platform') },
        role: 'title',
        runs: [{ text: 'Platform' }],
      },
      [id<LabelId>('l:platform.api')]: {
        id: id<LabelId>('l:platform.api'),
        owner: { kind: 'node', id: id<NodeId>('platform.api') },
        role: 'title',
        runs: [{ text: 'API Gateway\nedge · public' }],
      },
      // Byte-identical text and style to `l:platform.api` — one table entry, two labels.
      [id<LabelId>('l:platform.worker')]: {
        id: id<LabelId>('l:platform.worker'),
        owner: { kind: 'node', id: id<NodeId>('platform.worker') },
        role: 'title',
        runs: [{ text: 'API Gateway\nedge · public' }],
      },
      [id<LabelId>('l:store')]: {
        id: id<LabelId>('l:store'),
        owner: { kind: 'node', id: id<NodeId>('store') },
        role: 'title',
        runs: [{ text: 'Postgres 東京 🚀' }],
      },
      // No runs at all — still has to land in the table, or it is an RPC miss.
      [id<LabelId>('l:ghost')]: {
        id: id<LabelId>('l:ghost'),
        owner: { kind: 'node', id: id<NodeId>('ghost') },
        role: 'title',
        runs: [],
      },
      [id<LabelId>('l:e-0001')]: {
        id: id<LabelId>('l:e-0001'),
        owner: { kind: 'edge', id: id<EdgeId>('e-0001') },
        role: 'edge',
        runs: [{ text: 'writes' }],
      },
    },
    meta: { nodeCount: 5, edgeCount: 1, containerCount: 1 },
  };

  return {
    graph,
    styles: {},
    labelStyles: {
      [id<LabelId>('l:platform')]: textStyle({ fontSize: 12, fontWeight: 600 }),
      [id<LabelId>('l:platform.api')]: textStyle(),
      [id<LabelId>('l:platform.worker')]: textStyle(),
      [id<LabelId>('l:store')]: textStyle(),
      [id<LabelId>('l:ghost')]: textStyle(),
      [id<LabelId>('l:e-0001')]: textStyle({ fontSize: 11, fontWeight: 400 }),
    },
    canvas: { background: '#F7F8FA' },
    themeId: 'neutral-light',
    geometryHash: 'fixture-geometry',
    paintHash: 'fixture-paint',
  };
}

// ---------------------------------------------------------------------------
// Run keys
// ---------------------------------------------------------------------------

describe('hashRuns', () => {
  it('is stable for the same runs and constraints', () => {
    const runs = [run('API Gateway'), run('edge · public')];
    expect(hashRuns(runs, UNCONSTRAINED)).toBe(hashRuns(runs, UNCONSTRAINED));
    // A structurally equal but distinct object must key the same, or an unchanged
    // label would miss the table after every edit.
    expect(hashRuns([run('API Gateway'), run('edge · public')], {})).toBe(
      hashRuns(runs, UNCONSTRAINED),
    );
  });

  it('changes when any text property changes', () => {
    const base = hashRuns([run('Service')], UNCONSTRAINED);
    const variants: Partial<TextStyle>[] = [
      { fontFamily: 'Georgia, serif' },
      { fontSize: 13.5 },
      { fontWeight: 700 },
      { fontStyle: 'italic' },
      { lineHeight: 1.4 },
      { letterSpacing: 0.5 },
    ];
    for (const over of variants) {
      const key = hashRuns([run('Service', { ...BASE_STYLE, ...over })], UNCONSTRAINED);
      expect(key, JSON.stringify(over)).not.toBe(base);
    }
  });

  it('changes when the text, the run split, or the constraints change', () => {
    const base = hashRuns([run('Service')], UNCONSTRAINED);
    expect(hashRuns([run('service')], UNCONSTRAINED)).not.toBe(base);
    expect(hashRuns([run('Ser'), run('vice')], UNCONSTRAINED)).not.toBe(base);
    expect(hashRuns([run('Service')], { maxWidth: 200 })).not.toBe(base);
    expect(hashRuns([run('Service')], { maxWidth: 201 })).not.toBe(
      hashRuns([run('Service')], { maxWidth: 200 }),
    );
  });

  it('keys 0 and -0 the same', () => {
    expect(hashRuns([run('x', { ...BASE_STYLE, letterSpacing: -0 })], UNCONSTRAINED)).toBe(
      hashRuns([run('x', { ...BASE_STYLE, letterSpacing: 0 })], UNCONSTRAINED),
    );
  });

  it('hashes the canonical string DD-05 §2 specifies', () => {
    // Locked: the worker looks entries up with this, so the format is a
    // compatibility surface between the host and the worker, not a detail.
    expect(canonicalRunKey([run('Hi', BASE_STYLE)], UNCONSTRAINED)).toBe(
      'HiInter, sans-serif13500normal1.30*',
    );
    expect(hashRuns([run('Hi')], UNCONSTRAINED)).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

describe('the hard-break line model (DD-11 §7; the MVP one-run-per-line model before A18)', () => {
  /** Fixed advances, so the arithmetic is checkable by hand (DD-05 §8). */
  const stub: MeasureRun = (text, style) => ({
    width: text.length * style.fontSize,
    ascent: style.fontSize * 0.8,
  });

  it('puts each hard line on its own line, with no wrapping', () => {
    const layout = layoutLines(stub, [run('ab\ncde\nf')], UNCONSTRAINED);
    expect(layout.lines).toHaveLength(3);
    for (const line of layout.lines) {
      expect(line.runs).toHaveLength(1);
      expect(line.runs[0]?.x).toBe(0);
    }
    expect(layout.lines.map((l) => l.runs[0]?.text)).toEqual(['ab', 'cde', 'f']);
  });

  it('computes height and baselines from fontSize * lineHeight', () => {
    const style: TextStyle = { ...BASE_STYLE, fontSize: 10, lineHeight: 2 };
    const layout = layoutLines(stub, [run('a\nbb\nc', style)], {});

    // lineHeightPx = 10 * 2 = 20; ascent = 8.
    expect(layout.height).toBe(60);
    expect(layout.ascent).toBe(8);
    expect(layout.lines.map((l) => l.y)).toEqual([8, 28, 48]);
    // width = max(w_i); "bb" is the widest at 2 * 10.
    expect(layout.width).toBe(20);
    expect(layout.lines.map((l) => l.width)).toEqual([10, 20, 10]);
  });

  it('adds letter spacing between glyphs, not after the last one', () => {
    const spaced: TextStyle = { ...BASE_STYLE, fontSize: 10, letterSpacing: 3 };
    // 4 glyphs * 10 advance + 3 gaps * 3 spacing.
    expect(layoutLines(stub, [run('abcd', spaced)], UNCONSTRAINED).width).toBe(49);
    // A single glyph gets no gap at all.
    expect(layoutLines(stub, [run('a', spaced)], UNCONSTRAINED).width).toBe(10);
    expect(layoutLines(stub, [run('', spaced)], UNCONSTRAINED).width).toBe(0);
  });

  it('counts code points, so an astral character is one glyph', () => {
    expect(glyphCount('🚀🚀')).toBe(2);
    expect(glyphCount('ab')).toBe(2);
  });

  it('gives an empty run list an empty layout rather than NaN', () => {
    expect(layoutLines(stub, [], UNCONSTRAINED)).toEqual({
      width: 0,
      height: 0,
      lines: [],
      ascent: 0,
    });
  });

  it('still occupies a line for an empty string', () => {
    const style: TextStyle = { ...BASE_STYLE, fontSize: 10, lineHeight: 1.5 };
    const layout = layoutLines(stub, [run('a\n', style)], UNCONSTRAINED);
    expect(layout.lines).toHaveLength(2);
    expect(layout.height).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// StaticMetricsMeasurer
// ---------------------------------------------------------------------------

describe('StaticMetricsMeasurer', () => {
  it('has a complete advance table for every class', () => {
    for (const metrics of Object.values(STATIC_METRICS)) {
      expect(Object.keys(metrics.advances), metrics.id).toHaveLength(95);
      expect(metrics.ascent, metrics.id).toBeGreaterThan(0);
    }
  });

  it('scales the em table by fontSize', () => {
    const style: TextStyle = { ...BASE_STYLE, fontFamily: 'Helvetica, sans-serif', fontSize: 1000 };
    // Helvetica AFM: n = 556, i = 222.
    expect(staticAdvance('n', style)).toBeCloseTo(556, 6);
    expect(staticAdvance('ni', style)).toBeCloseTo(778, 6);
    expect(staticAdvance('n', { ...style, fontSize: 100 })).toBeCloseTo(55.6, 6);
  });

  it('classifies families with sans tested before serif', () => {
    // "sans-serif" contains "serif"; getting this backwards silently measures every
    // default-themed label against the Times table.
    expect(fontClassOf('Inter, system-ui, sans-serif')).toBe('sans');
    expect(fontClassOf('Georgia, serif')).toBe('serif');
    expect(fontClassOf("'JetBrains Mono', monospace")).toBe('mono');
    expect(fontClassOf('Wingdings')).toBe('sans');
  });

  it('gives every mono glyph the same advance', () => {
    const style: TextStyle = { ...BASE_STYLE, fontFamily: 'monospace', fontSize: 10 };
    expect(staticAdvance('iiii', style)).toBeCloseTo(staticAdvance('WWWW', style), 6);
  });

  it('makes bold wider and italic the same width', () => {
    const style: TextStyle = { ...BASE_STYLE, fontFamily: 'sans-serif', fontSize: 100 };
    expect(staticAdvance('Service', { ...style, fontWeight: 700 })).toBeGreaterThan(
      staticAdvance('Service', style),
    );
    expect(staticAdvance('Service', { ...style, fontStyle: 'italic' })).toBe(
      staticAdvance('Service', style),
    );
  });

  it('charges a full em for an ideograph and nothing for a combining mark', () => {
    const style: TextStyle = { ...BASE_STYLE, fontFamily: 'sans-serif', fontSize: 10 };
    expect(staticAdvance('東京', style)).toBeCloseTo(20, 6);
    expect(staticAdvance('é', style)).toBeCloseTo(staticAdvance('e', style), 6);
  });

  it('measures the same string identically on two instances', () => {
    const runs = [run('API Gateway'), run('edge · public')];
    const a = new StaticMetricsMeasurer().layoutRuns(runs, UNCONSTRAINED);
    const b = new StaticMetricsMeasurer().layoutRuns(runs, UNCONSTRAINED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.width).toBeGreaterThan(0);
  });

  it('never misses', () => {
    expect(new StaticMetricsMeasurer().has([run('anything')], UNCONSTRAINED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CanvasMeasurer under Node
// ---------------------------------------------------------------------------

describe('CanvasMeasurer without a canvas', () => {
  it('degrades to the static tables rather than throwing', () => {
    // This suite runs under Node with no DOM shims (vitest.config.ts), which is the
    // environment the degrade path exists for.
    expect(canvasIsAvailable()).toBe(false);

    const measurer = new CanvasMeasurer();
    expect(measurer.usingFallback).toBe(true);

    const layout = measurer.layoutRuns([run('API Gateway')], UNCONSTRAINED);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.lines).toHaveLength(1);
    expect(layout).toEqual(new StaticMetricsMeasurer().layoutRuns([run('API Gateway')], UNCONSTRAINED));
  });

  it('resolves ready() when there is no font set to await', async () => {
    await expect(new CanvasMeasurer().ready([BASE_STYLE])).resolves.toBeUndefined();
  });

  it('makes StaticMetricsMeasurer the default in Node', () => {
    expect(createDefaultMeasurer()).toBeInstanceOf(StaticMetricsMeasurer);
  });
});

// ---------------------------------------------------------------------------
// premeasure
// ---------------------------------------------------------------------------

describe('premeasure', () => {
  const styled = fixtureGraph();

  it('reads the six text properties off the label style', () => {
    expect(textStyleOf(styled.labelStyles[id<LabelId>('l:platform')])).toEqual({
      ...BASE_STYLE,
      fontSize: 12,
      fontWeight: 600,
    });
  });

  it('falls back rather than producing NaN for a missing style', () => {
    const style = textStyleOf(undefined);
    expect(Number.isFinite(style.fontSize)).toBe(true);
    expect(style.fontWeight).toBe(400);
  });

  it('covers 100% of labels — DD-00 §6, zero worker RPC misses', () => {
    const table = premeasure(styled, new StaticMetricsMeasurer());
    const worker = new TableMeasurer(table);

    const labelIds = Object.keys(styled.graph.labels);
    expect(labelIds.length).toBe(6);

    for (const labelId of labelIds) {
      const key = labelRunKey(styled, id<LabelId>(labelId));
      expect(table[key], `no entry for ${labelId}`).toBeDefined();
      // And the worker's own lookup path finds it, which is the thing that matters.
      expect(worker.has(labelRuns(styled, id<LabelId>(labelId)), UNCONSTRAINED), labelId).toBe(true);
      expect(() => worker.layoutRuns(labelRuns(styled, id<LabelId>(labelId)), UNCONSTRAINED)).not.toThrow();
    }
  });

  it('folds two labels with identical text and style onto one entry', () => {
    const table = premeasure(styled, new StaticMetricsMeasurer());
    expect(labelRunKey(styled, id<LabelId>('l:platform.api'))).toBe(
      labelRunKey(styled, id<LabelId>('l:platform.worker')),
    );
    // Six labels, but `platform.api` and `platform.worker` share one key.
    expect(Object.keys(table)).toHaveLength(5);
  });

  it('measures the two-line title as two lines', () => {
    const table = premeasure(styled, new StaticMetricsMeasurer());
    const layout = table[labelRunKey(styled, id<LabelId>('l:platform.api'))];
    expect(layout?.lines).toHaveLength(2);
    // Two lines at 13px * 1.3.
    expect(layout?.height).toBeCloseTo(33.8, 6);
    expect(layout?.lines[1]?.y).toBeCloseTo((layout?.lines[0]?.y ?? 0) + 16.9, 6);
  });

  it('emits keys in sorted order', () => {
    const keys = Object.keys(premeasure(styled, new StaticMetricsMeasurer()));
    expect(keys).toEqual([...keys].sort());
  });

  it('is byte-identical across two runs — DD-00 §3', () => {
    // The double-run check. Fresh measurers both times, so a cache cannot hide a
    // non-deterministic measurement behind a hit.
    const first = JSON.stringify(premeasure(fixtureGraph(), new StaticMetricsMeasurer()));
    const second = JSON.stringify(premeasure(fixtureGraph(), new StaticMetricsMeasurer()));
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// premeasure — over the corpus (Stage D, 07 §5)
//
// `fixtureGraph` above asserts the mechanics with a hand-picked, adversarial set of
// labels. This block asserts the DD-00 §6 measurement exit criterion literally,
// against every document the real front end actually compiles.
// ---------------------------------------------------------------------------

describe('premeasure: over the corpus (DD-00 §6)', () => {
  it('covers 100% of labels in the corpus — zero worker RPC misses', () => {
    for (const doc of listCorpusDocs()) {
      const { styled } = corpusStyledGraph(doc);
      const table = premeasure(styled, new StaticMetricsMeasurer({ lineModel: layoutWrapped }));
      const worker = new TableMeasurer(table);
      for (const id of Object.keys(styled.graph.labels)) {
        const labelId = id as LabelId;
        expect(table[labelRunKey(styled, labelId)], `${doc}: ${labelId}`).toBeDefined();
        // The worker looks a label up by its runs *and* its box (DD-11 T29).
        expect(worker.has(labelRuns(styled, labelId), labelBox(styled, labelId)), `${doc}: ${labelId}`).toBe(true);
      }
    }
  });

  it('folds two real labels that share text and style onto one table entry (wildcards.sgl)', () => {
    // `lane2.x` and `fan1.x` are unrelated leaves with no `@label`, so both default
    // to the title "x" with no class or `@style` to tell their look apart — the
    // same fold `fixtureGraph`'s `platform.api`/`platform.worker` engineers by hand,
    // produced here by two nodes the compiler actually built.
    const { styled } = corpusStyledGraph('wildcards.sgl');
    expect(labelRunKey(styled, 'l:lane2.x' as LabelId)).toBe(labelRunKey(styled, 'l:fan1.x' as LabelId));
    const table = premeasure(styled, new StaticMetricsMeasurer({ lineModel: layoutWrapped }));
    expect(Object.keys(table).length).toBeLessThan(Object.keys(styled.graph.labels).length);
  });

  it('measures a real multiline, unicode and RTL title (unicode.sgl)', () => {
    const { styled } = corpusStyledGraph('unicode.sgl');
    const table = premeasure(styled, new StaticMetricsMeasurer({ lineModel: layoutWrapped }));

    const multiline = table[labelRunKey(styled, 'l:multiline' as LabelId)];
    expect(multiline?.lines).toHaveLength(2);
    expect(multiline?.lines.map((l) => l.runs[0]?.text)).toEqual(['Line one', 'Line two']);

    const emoji = table[labelRunKey(styled, 'l:🚀' as LabelId)];
    expect(emoji?.width).toBeGreaterThan(0);

    // A quoted key with a dot escapes to `metrics\.v2` (DD-03 id escaping) —
    // asserted here because a wrong escape would silently miss the table.
    expect(table[labelRunKey(styled, 'l:metrics\\.v2' as LabelId)]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TableMeasurer
// ---------------------------------------------------------------------------

describe('TableMeasurer', () => {
  const styled = fixtureGraph();
  const table = premeasure(styled, new StaticMetricsMeasurer());

  it('throws MeasureMiss on the synchronous path for an unknown run', () => {
    const worker = new TableMeasurer(table);
    const unknown = [run('never pre-measured')];

    expect(worker.has(unknown, UNCONSTRAINED)).toBe(false);
    expect(() => worker.layoutRuns(unknown, UNCONSTRAINED)).toThrow(MeasureMiss);
    // The key travels with the error — it is what the RPC asks the host for.
    try {
      worker.layoutRuns(unknown, UNCONSTRAINED);
      expect.unreachable('should have missed');
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureMiss);
      expect((err as MeasureMiss).runKey).toBe(hashRuns(unknown, UNCONSTRAINED));
    }
  });

  it('serves a hit without consulting the host', () => {
    let calls = 0;
    const worker = new TableMeasurer(table, async (runs, box) => {
      calls += 1;
      return new StaticMetricsMeasurer().layoutRuns(runs, box);
    });
    worker.layoutRuns(labelRuns(styled, id<LabelId>('l:store')), UNCONSTRAINED);
    expect(calls).toBe(0);
  });

  it('fills a miss from the host and hits synchronously afterwards', async () => {
    const host = new StaticMetricsMeasurer();
    const worker = new TableMeasurer(table, (runs, box) => Promise.resolve(host.layoutRuns(runs, box)));
    const unknown = [run('synthesised at layout time')];

    const layout = await worker.layoutRunsAsync(unknown, UNCONSTRAINED);
    expect(layout.width).toBeGreaterThan(0);
    expect(() => worker.layoutRuns(unknown, UNCONSTRAINED)).not.toThrow();
    expect(worker.table[hashRuns(unknown, UNCONSTRAINED)]).toEqual(layout);
  });

  it('rejects with MeasureMiss when there is no host to ask', async () => {
    const worker = new TableMeasurer(table);
    await expect(worker.layoutRunsAsync([run('nope')], UNCONSTRAINED)).rejects.toBeInstanceOf(
      MeasureMiss,
    );
  });
});
