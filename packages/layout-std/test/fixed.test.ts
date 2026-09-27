import { asNodeId, type NodeId, type Rect } from '@sgl/core';
import {
  DEFAULT_ENGINE_TIMEOUT_MS,
  engineNotes,
  validateResult,
  type LayoutContext,
  type LayoutInput,
  type LayoutResult,
} from '@sgl/layout-api';
import { conformanceContext, runHostSequence, siblingOverlaps } from '@sgl/layout-api/conformance';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { layoutInputFor, layoutInputForSource, METRICS, withContainerMin } from '../../layout-elk/test/corpus-input.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { FIXED_ENGINE_ID, fixedDescriptor } from '../src/descriptor.js';
import { fixedEngine } from '../src/fixed.js';
import { gridEngine } from '../src/grid.js';

/**
 * `fixed` (DD-12 §4, B5 branch 2): pinned nodes at their pin, relative to the
 * parent's content box (H2); unpinned nodes packed below them with one
 * `SGL4020` each (H1); containers sized from their children; ports on the
 * frame; edges and labels by the host.
 */

const ctx = (options: Readonly<Record<string, unknown>> = {}): LayoutContext => conformanceContext(options, METRICS);
const raw = (input: LayoutInput, options: Readonly<Record<string, unknown>> = {}): Promise<LayoutResult> => fixedEngine.layout(input, ctx(options));
const frame = (r: LayoutResult, id: string): Rect => r.nodes[asNodeId(id)]!.frame;
const n = (id: string): NodeId => asNodeId(id);

/** The pin documents the corpus holds for `fixed` (DD-12 §12). */
const PIN_DOCS = listCorpusDocs().filter((d) => d.startsWith('layout/pin-') || d === 'layout/forty-three-pinned.sgl');

describe('fixed: pinned nodes (DD-12 N1, N2, H2)', () => {
  it('puts a root node’s frame top-left at its pin', async () => {
    const r = await raw(layoutInputForSource('a: { @pin: { x: 0, y: 0 } }\nb: { @pin: { x: 200, y: 0 } }\nc: { @pin: { x: 100, y: 120 } }\n'));
    expect([frame(r, 'a').x, frame(r, 'a').y]).toEqual([0, 0]);
    expect([frame(r, 'b').x, frame(r, 'b').y]).toEqual([200, 0]);
    expect([frame(r, 'c').x, frame(r, 'c').y]).toEqual([100, 120]);
    expect(r.notes ?? []).toEqual([]);
  });

  it('sizes a pinned leaf exactly as grid does: a pin places, it never sizes (N8)', async () => {
    const source = 'a: { @label: "A wide label", @pin: { x: 5, y: 7 } }\nb: { @size: { width: 90, height: 30 }, @pin: { x: 300, y: 0 } }\n';
    const input = layoutInputForSource(source);
    const f = await raw(input);
    const g = await gridEngine.layout(input, ctx());
    for (const id of ['a', 'b']) expect([frame(f, id).w, frame(f, id).h]).toEqual([frame(g, id).w, frame(g, id).h]);
    expect([frame(f, 'b').w, frame(f, 'b').h]).toEqual([90, 30]);
  });

  it('places a child relative to its parent’s content box, so moving the parent moves it (N2)', async () => {
    const doc = (x: number, y: number) =>
      `box: {\n  @label: "Box"\n  @pin: { x: ${x}, y: ${y} }\n  a: { @label: "A", @pin: { x: 0, y: 0 } }\n  b: { @label: "B", @pin: { x: 120, y: 10 } }\n}\n`;
    const input = layoutInputForSource(doc(300, 100));
    const r = await raw(input);
    const box = r.nodes[n('box')]!;
    const [t, , , l] = input.sizing[n('box')]!.padding;
    expect([box.frame.x, box.frame.y]).toEqual([300, 100]);
    expect([frame(r, 'box.a').x, frame(r, 'box.a').y]).toEqual([300 + l, 100 + t]);
    expect([frame(r, 'box.b').x, frame(r, 'box.b').y]).toEqual([300 + l + 120, 100 + t + 10]);
    expect(box.contentFrame).toEqual({ x: 300 + l, y: 100 + t, w: box.frame.w - l - input.sizing[n('box')]!.padding[1], h: box.frame.h - t - input.sizing[n('box')]!.padding[2] });

    const moved = await raw(layoutInputForSource(doc(-40, 5)));
    for (const id of ['box.a', 'box.b']) {
      // Equal in exact arithmetic; the absolute origin costs a last bit.
      expect(frame(moved, id).x - frame(moved, 'box').x).toBeCloseTo(frame(r, id).x - frame(r, 'box').x, 9);
      expect(frame(moved, id).y - frame(moved, 'box').y).toBeCloseTo(frame(r, id).y - frame(r, 'box').y, 9);
    }
  });

  it('adds nested pins up: a grandchild is at the sum of the offsets and paddings (N7)', async () => {
    const source = 'outer: {\n  @pin: { x: 10, y: 20 }\n  inner: {\n    @pin: { x: 30, y: 40 }\n    leaf: { @pin: { x: 50, y: 60 } }\n  }\n}\n';
    const input = layoutInputForSource(source);
    const r = await raw(input);
    const po = input.sizing[n('outer')]!.padding;
    const pi = input.sizing[n('outer.inner')]!.padding;
    expect(frame(r, 'outer.inner.leaf').x).toBe(10 + po[3] + 30 + pi[3] + 50);
    expect(frame(r, 'outer.inner.leaf').y).toBe(20 + po[0] + 40 + pi[0] + 60);
  });

  it('pinned siblings may overlap, with no diagnostic (DD-12 §4.6)', async () => {
    const input = layoutInputForSource('a: { @pin: { x: 0, y: 0 } }\nb: { @pin: { x: 5, y: 5 } }\n');
    const { raw: r, result } = await runHostSequence(fixedEngine, input, {}, METRICS);
    expect(siblingOverlaps(input.graph, result)).toEqual([['a', 'b']]);
    expect(r.notes ?? []).toEqual([]);
    expect(validateResult(result, input.graph, fixedEngine.id)).toEqual([]);
  });
});

describe('fixed: containers (DD-12 N12, N13)', () => {
  it('derives a container’s size from its children’s far edges plus padding', async () => {
    const input = layoutInputForSource('box: {\n  @label: "B"\n  a: { @pin: { x: 10, y: 0 } }\n  b: { @pin: { x: 0, y: 50 } }\n}\n');
    const r = await raw(input);
    const [t, rt, b, l] = input.sizing[n('box')]!.padding;
    const a = frame(r, 'box.a');
    const bb = frame(r, 'box.b');
    const contentW = Math.max(10 + a.w, 0 + bb.w);
    const contentH = Math.max(0 + a.h, 50 + bb.h);
    expect(frame(r, 'box').w).toBe(l + contentW + rt);
    expect(frame(r, 'box').h).toBe(t + contentH + b);
  });

  it('is at least as wide as its title plus the content insets (N12, elk’s rule)', async () => {
    const input = layoutInputForSource('box: {\n  @label: "A very long container title indeed"\n  a: { @label: "A", @pin: { x: 0, y: 0 } }\n}\n');
    const r = await raw(input);
    const sizing = input.sizing[n('box')]!;
    const title = input.labelSizes[input.graph.nodes[n('box')]!.labelId!]!;
    const titleW = title.w + sizing.contentInset[1] + sizing.contentInset[3];
    expect(titleW).toBeGreaterThan(sizing.padding[3] + frame(r, 'box.a').w + sizing.padding[1]);
    expect(frame(r, 'box').w).toBe(titleW);
  });

  it('honours a container minimum', async () => {
    const input = withContainerMin(layoutInputForSource('box: {\n  a: { @pin: { x: 0, y: 0 } }\n}\n'), 'box', { w: 500, h: 400 });
    const r = await raw(input);
    expect([frame(r, 'box').w, frame(r, 'box').h]).toEqual([500, 400]);
  });

  it('a child pinned at a negative offset lies outside its container: SGL4003 from validation (N12)', async () => {
    const input = layoutInputFor('layout/pin-negative.sgl');
    const { result } = await runHostSequence(fixedEngine, input, {}, METRICS);
    expect(validateResult(result, input.graph, fixedEngine.id).map((d) => [d.code, d.message])).toEqual([
      ['SGL4003', '`box.a` extends outside its container after layout.'],
    ]);
  });

  it('fix round 1, item 1: unpinned siblings of a negative pin pack from x = 0, never outside the content box', async () => {
    // The reviewer's input: before the fix `b` packed from the leftmost pin
    // (x = -50) and was an SGL4003 too.
    const input = layoutInputForSource('box: {\n  @pin: { x: 0, y: 0 }\n  a: { @label: "A", @pin: { x: -50, y: -30 } }\n  b: "B"\n}\n');
    const { raw: r, result } = await runHostSequence(fixedEngine, input, {}, METRICS);
    const [t, , , l] = input.sizing[n('box')]!.padding;
    const a = r.nodes[n('box.a')]!.frame;
    expect(r.nodes[n('box.b')]!.frame.x).toBe(l);
    expect(r.nodes[n('box.b')]!.frame.y).toBe(t + (-30 + a.h) + 24);
    expect(validateResult(result, input.graph, fixedEngine.id).map((d) => [d.code, d.message])).toEqual([
      ['SGL4003', '`box.a` extends outside its container after layout.'],
    ]);
    // Nor above it: pinned nodes high above the origin leave the packing at y = 0.
    const high = await raw(layoutInputForSource('a: { @pin: { x: 10, y: -200 } }\nb\n'));
    expect([frame(high, 'b').x, frame(high, 'b').y]).toEqual([10, 0]);
    // A positive leftmost pin still sets where the packing starts.
    const right = await raw(layoutInputForSource('a: { @pin: { x: 30, y: 0 } }\nb\n'));
    expect(frame(right, 'b').x).toBe(30);
  });

  it('leaves hidden children out, and lays a container whose children are all hidden out as a leaf', async () => {
    const input = layoutInputForSource('box: {\n  @label: "Box"\n  a: { @hidden: true }\n}\nc: { @pin: { x: 0, y: 0 } }\n');
    const r = await raw(input);
    expect(r.nodes[n('box.a')]).toBeUndefined();
    expect(r.nodes[n('box')]!.contentFrame).toBeUndefined();
    // Sized as a leaf: its intrinsic size (no fixed, min or max here).
    const { intrinsic } = input.sizing[n('box')]!;
    expect([frame(r, 'box').w, frame(r, 'box').h]).toEqual([intrinsic.w, intrinsic.h]);
  });

  it('lays out a scope: the scope’s own frame at the origin, its children inside', async () => {
    const whole = layoutInputForSource('box: {\n  @pin: { x: 300, y: 300 }\n  a: { @pin: { x: 10, y: 20 } }\n}\n');
    const scoped: LayoutInput = { ...whole, scope: n('box') };
    const r = await raw(scoped);
    const [t, , , l] = whole.sizing[n('box')]!.padding;
    expect([frame(r, 'box').x, frame(r, 'box').y]).toEqual([0, 0]);
    expect([frame(r, 'box.a').x, frame(r, 'box.a').y]).toEqual([l + 10, t + 20]);
  });

  it('an empty document lays out to an empty result', async () => {
    const r = await raw(layoutInputFor('empty.sgl'));
    expect(r.nodes).toEqual({});
    expect(r.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('fixed: nodes without a pin (DD-12 N9, N11, H1)', () => {
  it('packs them below the lowest pinned sibling, one gap down, from the leftmost pin, as grid packs', async () => {
    const input = layoutInputFor('layout/pin-half.sgl');
    const r = await raw(input);
    const a = frame(r, 'a');
    const b = frame(r, 'b');
    const top = Math.max(0 + a.h, 40 + b.h) + 24;
    // ⌈√2⌉ = 2 columns, aligned to the start.
    expect([frame(r, 'c').x, frame(r, 'c').y]).toEqual([0, top]);
    expect([frame(r, 'd').x, frame(r, 'd').y]).toEqual([frame(r, 'c').w + 24, top]);
  });

  it('reads the gap option; an invalid one is the default 24', async () => {
    const input = layoutInputForSource('a: { @pin: { x: 7, y: 3 } }\nc\nd\n');
    const r = await raw(input, { gap: 10 });
    const top = 3 + frame(r, 'a').h + 10;
    expect([frame(r, 'c').x, frame(r, 'c').y]).toEqual([7, top]);
    expect(frame(r, 'd').x).toBe(7 + frame(r, 'c').w + 10);
    for (const gap of [-1, Number.NaN, '12', Number.POSITIVE_INFINITY]) {
      const d = await raw(input, { gap });
      expect(frame(d, 'c').y).toBe(3 + frame(d, 'a').h + 24);
    }
  });

  it('with no pinned sibling, packs them from the content origin', async () => {
    const input = layoutInputForSource('box: {\n  @pin: { x: 50, y: 50 }\n  a\n  b\n  c\n}\n');
    const r = await raw(input);
    const [t, , , l] = input.sizing[n('box')]!.padding;
    expect([frame(r, 'box.a').x, frame(r, 'box.a').y]).toEqual([50 + l, 50 + t]);
  });

  it('with no pins at all, places every node as grid does with align start', async () => {
    const input = layoutInputFor('chains.sgl');
    const f = await raw(input);
    const g = await gridEngine.layout(input, ctx({ align: 'start' }));
    expect(f.nodes).toEqual(g.nodes);
  });

  it('never overlaps a pinned sibling', async () => {
    for (const doc of PIN_DOCS) {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(fixedEngine, input, {}, METRICS);
      const pinned = (id: NodeId) => input.graph.nodes[id]!.config['pin'] !== undefined;
      expect(siblingOverlaps(input.graph, result, pinned), doc).toEqual([]);
    }
  });

  it('notes one SGL4020 per unpinned node, in declaration order, at the node’s span', async () => {
    const input = layoutInputFor('layout/pin-half.sgl');
    const r = await raw(input);
    expect(r.notes).toEqual([
      { code: 'SGL4020', span: input.graph.nodes[n('c')]!.span, params: { node: 'c' } },
      { code: 'SGL4020', span: input.graph.nodes[n('d')]!.span, params: { node: 'd' } },
    ]);
    // Through the host's check, as the app shows it.
    expect(engineNotes(r.notes).map((d) => [d.code, d.severity, d.message])).toEqual([
      ['SGL4020', 'warning', '`c` has no `@pin`; `fixed` placed it below the pinned nodes.'],
      ['SGL4020', 'warning', '`d` has no `@pin`; `fixed` placed it below the pinned nodes.'],
    ]);
  });

  it('notes an unpinned container and its unpinned children, each once', async () => {
    const r = await raw(layoutInputForSource('box: {\n  a\n  b: { @pin: { x: 0, y: 0 } }\n}\n'));
    expect((r.notes ?? []).map((note) => note.params?.['node'])).toEqual(['box', 'box.a']);
  });
});

describe('fixed: ports on the frame (DD-12 N15)', () => {
  it('spreads each side’s ports evenly, in declaration order, with the side’s outward normal', async () => {
    const input = layoutInputForSource('r: {\n  @pin: { x: 0, y: 0 }\n  @size: { width: 90, height: 60 }\n  @ports: { n1: north, e1: east, n2: north, w1: west, s1: south }\n}\n');
    const r = await raw(input);
    const f = frame(r, 'r');
    expect([f.w, f.h]).toEqual([90, 60]);
    expect(r.nodes[n('r')]!.ports).toEqual({
      n1: { point: { x: 30, y: 0 }, normal: { x: 0, y: -1 } },
      n2: { point: { x: 60, y: 0 }, normal: { x: 0, y: -1 } },
      e1: { point: { x: 90, y: 30 }, normal: { x: 1, y: 0 } },
      w1: { point: { x: 0, y: 30 }, normal: { x: -1, y: 0 } },
      s1: { point: { x: 45, y: 60 }, normal: { x: 0, y: 1 } },
    });
  });

  it('starts a port-terminated edge at the port (routeStraight), so ports.sgl attaches every edge', async () => {
    const input = layoutInputFor('ports.sgl');
    const { result } = await runHostSequence(fixedEngine, input, {}, METRICS);
    const edge = input.graph.edges.find((e) => e.from.port !== undefined)!;
    const port = result.nodes[edge.from.node]!.ports![edge.from.port!]!;
    expect(result.edges[edge.id]!.start).toEqual(port.point);
  });

  it('gives a node without ports no ports field', async () => {
    const r = await raw(layoutInputForSource('a: { @pin: { x: 0, y: 0 } }\n'));
    expect('ports' in r.nodes[n('a')]!).toBe(false);
  });
});

describe('fixed: the descriptor (DD-12 N17, N18, N19)', () => {
  it('is fixedEngine without layout()', () => {
    const { layout, ...rest } = fixedEngine;
    expect(typeof layout).toBe('function');
    expect(rest).toEqual(fixedDescriptor);
    expect('layout' in fixedDescriptor).toBe(false);
  });

  it('declares the id, name, capabilities and schemas DD-12 gives', () => {
    expect(FIXED_ENGINE_ID).toBe('sgl.fixed');
    expect(fixedDescriptor).toEqual({
      id: 'sgl.fixed',
      name: 'Fixed',
      version: '0.0.0',
      apiVersion: 1,
      capabilities: { containers: true, edgeRouting: 'straight', ports: true, labelPlacement: false, incremental: false, determinism: 'bitwise', pins: true },
      optionsSchema: { type: 'object', additionalProperties: false, properties: { gap: { type: 'number', minimum: 0, default: 24 } } },
      hintsSchema: { type: 'object', properties: {} },
    });
    // The host's timeout for it, as for grid (N19).
    expect(DEFAULT_ENGINE_TIMEOUT_MS['sgl.fixed']).toBe(2_000);
  });
});

describe('fixed over the corpus (DD-12 §12)', () => {
  it('holds the pin documents this suite assumes', () => {
    expect(PIN_DOCS).toEqual(
      expect.arrayContaining(['layout/pin-full.sgl', 'layout/pin-half.sgl', 'layout/pin-nested.sgl', 'layout/pin-negative.sgl', 'layout/forty-three-pinned.sgl']),
    );
  });

  for (const doc of listCorpusDocs()) {
    it(`${doc}: bitwise-identical across two runs, raw and quantized (N17)`, async () => {
      const input = layoutInputFor(doc);
      const a = await runHostSequence(fixedEngine, input, {}, METRICS);
      const b = await runHostSequence(fixedEngine, input, {}, METRICS);
      expect(JSON.stringify(b.raw)).toBe(JSON.stringify(a.raw));
      expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
      const errors = validateResult(a.result, input.graph, fixedEngine.id);
      expect(errors.map((d) => d.code)).toEqual(doc === 'layout/pin-negative.sgl' ? ['SGL4003'] : []);
    });
  }

  for (const doc of [...CLEAN_DOCS, ...PIN_DOCS]) {
    it(`${doc}: layout golden`, async () => {
      const { result } = await runHostSequence(fixedEngine, layoutInputFor(doc), {}, METRICS);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/fixed/${doc}.json`);
    });
  }
});
