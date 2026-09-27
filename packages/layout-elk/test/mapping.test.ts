import { asNodeId, type EdgeId, type LabelId, type NodeId } from '@sgl/core';
import { validateResult, type LayoutInput, type NodeSizing } from '@sgl/layout-api';
import { describe, expect, it } from 'vitest';
import { ELK_DEFAULT_OPTIONS, ELK_PORT_CONSTRAINTS, elkDescriptor, normalizeElkOptions, type ElkOptions } from '../src/descriptor.js';
import { fromElkGraph, labelBox, leafSize, toElkGraph, type ElkNode } from '../src/mapping.js';
import { layoutInputFor, layoutInputForSource, METRICS, withContainerMin } from './corpus-input.js';

/**
 * DD-06 §6.1 (input mapping) and §6.2 (output mapping), each against the
 * pure function alone — no elkjs. Inputs are built from real `.sgl` text
 * (Gate 1: no stage hand-builds a `SemanticGraph`); the ELK *output* side is
 * hand-built, because it is ELK's JSON, not ours, and a test that places a
 * label at a known ELK coordinate is exactly what K5 asks for.
 */

const opts = (over: Partial<ElkOptions> = {}): ElkOptions => ({ ...ELK_DEFAULT_OPTIONS, ...over });

function allElkNodes(node: ElkNode): ElkNode[] {
  return [node, ...(node.children ?? []).flatMap(allElkNodes)];
}

function findElk(root: ElkNode, id: string): ElkNode {
  const found = allElkNodes(root).find((n) => n.id === id);
  if (found === undefined) throw new Error(`no ElkNode '${id}'`);
  return found;
}

function sizingOf(input: LayoutInput, id: string): NodeSizing {
  const s = input.sizing[asNodeId(id)];
  if (s === undefined) throw new Error(`no sizing for '${id}'`);
  return s;
}

describe('normalizeElkOptions', () => {
  it('fills every default for an empty bag (DD-06 §6)', () => {
    expect(normalizeElkOptions({})).toEqual({
      direction: 'down',
      nodeSpacing: 40,
      rankSpacing: 70,
      edgeRouting: 'ORTHOGONAL',
      nodePlacement: 'BRANDES_KOEPF',
    });
  });

  it('keeps allowed values and replaces anything else with the default', () => {
    expect(
      normalizeElkOptions({ direction: 'left', nodeSpacing: 12, rankSpacing: 0, edgeRouting: 'POLYLINE', nodePlacement: 'NETWORK_SIMPLEX' }),
    ).toEqual({ direction: 'left', nodeSpacing: 12, rankSpacing: 0, edgeRouting: 'POLYLINE', nodePlacement: 'NETWORK_SIMPLEX' });
    expect(
      normalizeElkOptions({ direction: 'sideways', nodeSpacing: -1, rankSpacing: Number.NaN, edgeRouting: 'orthogonal', nodePlacement: 3, columns: 4 }),
    ).toEqual(ELK_DEFAULT_OPTIONS);
  });
});

describe('toElkGraph (DD-06 §6.1)', () => {
  it('sets the root options, with the seed pinned (K2) and INCLUDE_CHILDREN', () => {
    const graph = toElkGraph(layoutInputFor('checkout.sgl'), opts(), METRICS);
    expect(graph.id).toBe('root');
    expect(graph.layoutOptions).toEqual({
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.randomSeed': '1',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.edgeLabel': '4',
      'elk.nodeLabels.padding': '[top=0,left=0,bottom=0,right=0]',
    });
  });

  it('maps every option value', () => {
    for (const [direction, elk] of [['down', 'DOWN'], ['up', 'UP'], ['left', 'LEFT'], ['right', 'RIGHT']] as const) {
      expect(toElkGraph(layoutInputFor('single.sgl'), opts({ direction }), METRICS).layoutOptions?.['elk.direction']).toBe(elk);
    }
    const g = toElkGraph(
      layoutInputFor('single.sgl'),
      opts({ nodeSpacing: 11, rankSpacing: 22, edgeRouting: 'SPLINES', nodePlacement: 'LINEAR_SEGMENTS' }),
      METRICS,
    );
    expect(g.layoutOptions).toMatchObject({
      'elk.spacing.nodeNode': '11',
      'elk.layered.spacing.nodeNodeBetweenLayers': '22',
      'elk.edgeRouting': 'SPLINES',
      'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS',
    });
  });

  it('repeats the per-level spacing on every container (ELK does not inherit them under INCLUDE_CHILDREN)', () => {
    const input = layoutInputFor('nesting-3.sgl');
    const graph = toElkGraph(input, opts({ nodeSpacing: 11 }), METRICS);
    const containers = allElkNodes(graph).filter((n) => n.id !== 'root' && (n.children?.length ?? 0) > 0);
    expect(containers.length).toBeGreaterThanOrEqual(3);
    for (const c of containers) {
      expect(c.layoutOptions).toMatchObject({
        'elk.spacing.nodeNode': '11',
        'elk.layered.spacing.nodeNodeBetweenLayers': '70',
        'elk.spacing.edgeLabel': '4',
        'elk.nodeLabels.padding': '[top=0,left=0,bottom=0,right=0]',
      });
    }
  });

  it('gives every label non-empty text (ELK ignores a label whose text is empty)', () => {
    const input = layoutInputFor('checkout.sgl');
    const graph = toElkGraph(input, opts(), METRICS);
    const labels = [...allElkNodes(graph).flatMap((n) => n.labels ?? []), ...(graph.edges ?? []).flatMap((e) => e.labels ?? [])];
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.text).not.toBe('');
      expect(input.graph.labels[l.text as LabelId]).toBeDefined();
    }
  });

  it('sizes a leaf fixed ?? clamp(intrinsic, min, max), and places its title centred', () => {
    expect(leafSize({ intrinsic: { w: 50, h: 20 }, contentInset: [0, 0, 0, 0], padding: [0, 0, 0, 0] })).toEqual({ w: 50, h: 20 });
    expect(
      leafSize({ intrinsic: { w: 50, h: 20 }, min: { w: 80 }, max: { h: 10 }, contentInset: [0, 0, 0, 0], padding: [0, 0, 0, 0] }),
    ).toEqual({ w: 80, h: 10 });
    expect(leafSize({ intrinsic: { w: 50, h: 20 }, fixed: { w: 7 }, min: { w: 80 }, contentInset: [0, 0, 0, 0], padding: [0, 0, 0, 0] })).toEqual({
      w: 7,
      h: 20,
    });

    const input = layoutInputFor('single.sgl');
    const graph = toElkGraph(input, opts(), METRICS);
    const leaf = graph.children?.[0];
    expect(leaf).toBeDefined();
    const sizing = sizingOf(input, leaf!.id);
    expect({ w: leaf!.width, h: leaf!.height }).toEqual(leafSize(sizing));
    expect(leaf!.labels?.[0]?.layoutOptions).toEqual({ 'elk.nodeLabels.placement': '[H_CENTER, V_CENTER, INSIDE]' });
  });

  it("sends no container title to ELK: the title band is elk.padding.top, once, and the title's width is a minimum (fix round 1, item 1)", () => {
    const input = layoutInputFor('checkout.sgl');
    for (const direction of ['down', 'right'] as const) {
      const graph = toElkGraph(input, opts({ direction }), METRICS);
      const containers = allElkNodes(graph).filter((n) => n.id !== 'root' && (n.children?.length ?? 0) > 0);
      expect(containers.length).toBeGreaterThan(0);
      for (const c of containers) {
        const sizing = sizingOf(input, c.id);
        // No label: ELK would otherwise reserve a left column and add the band a second time.
        expect(c.labels).toBeUndefined();
        const [t, r, b, l] = sizing.padding;
        expect(c.layoutOptions?.['elk.padding']).toBe(`[top=${t},left=${l},bottom=${b},right=${r}]`);
        const title = input.labelSizes[input.graph.nodes[c.id as NodeId]!.labelId!]!;
        const minW = title.w + sizing.contentInset[1] + sizing.contentInset[3];
        expect(c.layoutOptions).toMatchObject({
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          'elk.nodeSize.minimum': direction === 'down' ? `(0,${minW})` : `(${minW},0)`,
        });
        expect(c.width).toBeUndefined(); // ELK sizes a container from its children.
      }
    }
  });

  it('grows a label box by the asymmetric part of its insets, and says where the text sits in it', () => {
    // Symmetric: the box is the label, centred.
    expect(labelBox([6, 8, 6, 8])).toEqual({ extra: [0, 0, 0, 0], align: 'middle', baseline: 'middle' });
    // A cylinder's top cap: 2·ry on top, ry below.
    expect(labelBox([16, 0, 8, 0])).toEqual({ extra: [8, 0, 0, 0], align: 'middle', baseline: 'bottom' });
    // Heavier on the left: the extra goes left and the text sits at the box's end.
    expect(labelBox([0, 2, 0, 10])).toEqual({ extra: [0, 0, 0, 8], align: 'end', baseline: 'middle' });
    expect(labelBox([0, 10, 0, 2])).toEqual({ extra: [0, 8, 0, 0], align: 'start', baseline: 'middle' });

    const input = layoutInputFor('shapes.sgl');
    const graph = toElkGraph(input, opts(), METRICS);
    const byShape = (shape: string): ElkNode => {
      const id = input.graph.order.find((n) => input.graph.nodes[n]?.shape === shape);
      if (id === undefined) throw new Error(`no ${shape}`);
      return findElk(graph, id);
    };
    for (const shape of ['cylinder', 'package']) {
      const elk = byShape(shape);
      const node = input.graph.nodes[elk.id as NodeId]!;
      const size = input.labelSizes[node.labelId!]!;
      const [t, , b] = sizingOf(input, elk.id).contentInset;
      expect(t).toBeGreaterThan(b);
      expect(elk.labels?.[0]?.height).toBe(size.h + (t - b));
      expect(elk.labels?.[0]?.width).toBe(size.w);
    }
  });

  it('sends a container minimum size swapped for DOWN/UP (ELK does not transpose it) and as-is for LEFT/RIGHT', () => {
    const input = withContainerMin(layoutInputForSource('box: {\n  a\n}\n'), 'box', { w: 300, h: 50 });
    for (const direction of ['down', 'up'] as const) {
      const box = findElk(toElkGraph(input, opts({ direction }), METRICS), 'box');
      expect(box.layoutOptions).toMatchObject({ 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': '(50,300)' });
    }
    for (const direction of ['left', 'right'] as const) {
      const box = findElk(toElkGraph(input, opts({ direction }), METRICS), 'box');
      expect(box.layoutOptions).toMatchObject({ 'elk.nodeSize.minimum': '(300,50)' });
    }
  });

  it('maps ports (FIXED_SIDE, zero-size, id node#port) and port-terminated edges', () => {
    const input = layoutInputFor('ports.sgl');
    const graph = toElkGraph(input, opts(), METRICS);
    const router = findElk(graph, 'router');
    expect(router.layoutOptions).toEqual({ 'elk.portConstraints': 'FIXED_SIDE' });
    expect(router.ports).toEqual([
      { id: 'router#in', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
      { id: 'router#out', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } },
      { id: 'router#mgmt', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'NORTH' } },
      { id: 'router#drain', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'SOUTH' } },
    ]);
    const edges = graph.edges ?? [];
    expect(edges.map((e) => [e.sources[0], e.targets[0]])).toEqual([
      ['client', 'router#in'],
      ['router#out', 'switch#uplink'],
      ['switch#down', 'server'],
      ['console', 'router#mgmt'],
      ['router#drain', 'server'],
    ]);
  });

  it('takes a portConstraints hint only from DD-06 §6\'s enum, and skips anything else (fix round 1, item 4)', () => {
    const doc = (value: string) =>
      layoutInputForSource(`box: {\n  @layout.portConstraints: "${value}"\n  @ports: { a: west }\n}\nplain: {\n  @layout.portConstraints: "${value}"\n}\n`);
    for (const value of ELK_PORT_CONSTRAINTS) {
      const graph = toElkGraph(doc(value), opts(), METRICS);
      expect(findElk(graph, 'box').layoutOptions?.['elk.portConstraints'], value).toBe(value);
      expect(findElk(graph, 'plain').layoutOptions?.['elk.portConstraints'], value).toBe(value);
    }
    const bogus = toElkGraph(doc('SIDEWAYS'), opts(), METRICS);
    expect(findElk(bogus, 'box').layoutOptions?.['elk.portConstraints']).toBe('FIXED_SIDE'); // it has ports
    expect(findElk(bogus, 'plain').layoutOptions).toBeUndefined(); // no ports, no valid hint
    expect((elkDescriptor.hintsSchema as { properties: { portConstraints: unknown } }).properties.portConstraints).toEqual({
      type: 'string',
      enum: ELK_PORT_CONSTRAINTS,
    });
  });

  it('puts every edge on the root (valid under INCLUDE_CHILDREN) and leaves out hidden nodes and edges', () => {
    const input = layoutInputFor('hidden.sgl');
    const graph = toElkGraph(input, opts(), METRICS);
    const ids = new Set(allElkNodes(graph).map((n) => n.id));
    for (const id of Object.keys(input.graph.nodes) as NodeId[]) {
      expect(ids.has(id)).toBe(!input.graph.nodes[id]!.hidden);
    }
    expect((graph.edges ?? []).map((e) => e.id)).toEqual(input.graph.edges.filter((e) => !e.hidden).map((e) => e.id));
    for (const n of allElkNodes(graph)) if (n.id !== 'root') expect(n.edges).toBeUndefined();
  });

  it('maps an edge priority hint to elk.layered.priority.direction', () => {
    const base = layoutInputFor('chains.sgl');
    const first = base.graph.edges[0]!;
    const input: LayoutInput = {
      ...base,
      graph: { ...base.graph, edges: [{ ...first, config: { layout: { priority: 5 } } }, ...base.graph.edges.slice(1)] },
    };
    const edge = toElkGraph(input, opts(), METRICS).edges?.[0];
    expect(edge?.layoutOptions).toEqual({ 'elk.layered.priority.direction': '5' });
    expect(toElkGraph(base, opts(), METRICS).edges?.[0]?.layoutOptions).toBeUndefined();
  });

  it('is a pure function of its input: the same graph twice is byte-identical', () => {
    const input = layoutInputFor('forty-three-level.sgl');
    expect(JSON.stringify(toElkGraph(input, opts(), METRICS))).toBe(JSON.stringify(toElkGraph(input, opts(), METRICS)));
  });
});

describe('fromElkGraph (DD-06 §6.2)', () => {
  // outer (container) > inner (leaf), plus a root-level leaf `x`, and two
  // labelled edges: `x -> outer.inner` and `outer.inner -> x`.
  const SOURCE = 'x: "X"\nouter: {\n  @label: "Outer"\n  inner: "Inner"\n}\nx -> outer.inner: "call"\nouter.inner -> x: "back"\n';
  const input = layoutInputForSource(SOURCE);
  const g = input.graph;
  const outer = asNodeId('outer');
  const inner = asNodeId('outer.inner');
  const x = asNodeId('x');
  const [e1, e2] = g.edges;

  /** ELK's output for that graph, hand-written: every coordinate below is
   *  arbitrary, so any agreement with it is the mapping reading ELK. */
  const elkOut: ElkNode = {
    id: 'root',
    width: 400,
    height: 300,
    children: [
      { id: x, x: 17, y: 5, width: 60, height: 30, labels: [{ text: 'l:x', width: 9, height: 13, x: 31, y: 2 }] },
      {
        id: outer,
        x: 100,
        y: 50,
        width: 200,
        height: 150,
        children: [{ id: inner, x: 20, y: 40, width: 70, height: 30, labels: [{ text: 'l:inner', width: 30, height: 13, x: 3, y: 11 }] }],
      },
    ],
    edges: [
      {
        id: e1!.id,
        sources: [x],
        targets: [inner],
        container: 'root',
        sections: [{ startPoint: { x: 47, y: 35 }, bendPoints: [{ x: 47, y: 60 }, { x: 155, y: 60 }], endPoint: { x: 155, y: 90 } }],
        labels: [{ text: 'l:e', width: 25, height: 12, x: 60, y: 61 }],
      },
      {
        id: e2!.id,
        sources: [inner],
        targets: [x],
        container: outer,
        sections: [{ startPoint: { x: 5, y: 5 }, endPoint: { x: 5, y: 1 } }],
        labels: [{ text: 'l:e2', width: 21, height: 11, x: 7, y: 9 }],
      },
    ],
  };

  const result = fromElkGraph(input, elkOut);

  it('accumulates parent offsets into absolute frames, and insets a container by NodeSizing.padding', () => {
    expect(result.nodes[x]?.frame).toEqual({ x: 17, y: 5, w: 60, h: 30 });
    expect(result.nodes[outer]?.frame).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(result.nodes[inner]?.frame).toEqual({ x: 120, y: 90, w: 70, h: 30 });
    const [t, r, b, l] = sizingOf(input, 'outer').padding;
    expect(result.nodes[outer]?.contentFrame).toEqual({ x: 100 + l, y: 50 + t, w: 200 - l - r, h: 150 - t - b });
    expect(result.nodes[x]?.contentFrame).toBeUndefined();
    expect(result.bounds).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });

  it("places every label at ELK's own coordinates (K5, first half)", () => {
    const at = (id: string) => result.labels.find((l) => l.labelId === id);
    const xLabel = g.nodes[x]!.labelId!;
    const outerLabel = g.nodes[outer]!.labelId!;
    const innerLabel = g.nodes[inner]!.labelId!;
    const edgeLabel = e1!.labelId!;
    const edge2Label = e2!.labelId!;
    // Node labels: the node's absolute origin plus ELK's label x/y; size as ELK sent it back.
    expect(at(xLabel)?.frame).toEqual({ x: 17 + 31, y: 5 + 2, w: 9, h: 13 });
    expect(at(innerLabel)?.frame).toEqual({ x: 120 + 3, y: 90 + 11, w: 30, h: 13 });
    expect(at(innerLabel)).toMatchObject({ align: 'middle', baseline: 'middle' });
    // A container title (fix round 1, item 1): not ELK's — ELK was never
    // given it — but top-left in ELK's container frame, inset by
    // contentInset, align start / baseline top (DD-06 §4.1, §6.1).
    const ci = sizingOf(input, 'outer').contentInset;
    const title = input.labelSizes[outerLabel]!;
    expect(at(outerLabel)).toEqual({ labelId: outerLabel, frame: { x: 100 + ci[3], y: 50 + ci[0], w: title.w, h: title.h }, align: 'start', baseline: 'top' });
    // An edge label: relative to the edge's container (root here), with a plate.
    expect(at(edgeLabel)).toEqual({ labelId: edgeLabel, frame: { x: 60, y: 61, w: 25, h: 12 }, align: 'middle', baseline: 'top', occlusion: 'plate' });
    // … and with a non-root container (item 16): offset by `outer`'s absolute origin.
    expect(at(edge2Label)).toEqual({ labelId: edge2Label, frame: { x: 100 + 7, y: 50 + 9, w: 21, h: 11 }, align: 'middle', baseline: 'top', occlusion: 'plate' });
    expect(result.labels).toHaveLength(5);
  });

  it('turns section 0 into a start point and L segments, with end directions and clip: none', () => {
    expect(result.edges[e1!.id]).toEqual({
      start: { x: 47, y: 35 },
      end: { x: 155, y: 90 },
      route: [
        { t: 'L', to: { x: 47, y: 60 } },
        { t: 'L', to: { x: 155, y: 60 } },
        { t: 'L', to: { x: 155, y: 90 } },
      ],
      startNormal: { x: 0, y: -1 },
      endNormal: { x: 0, y: 1 },
      clip: 'none',
    });
  });

  it("offsets an edge by the node ELK reports as its container (edges move to their endpoints' common ancestor)", () => {
    expect(result.edges[e2!.id]).toMatchObject({ start: { x: 105, y: 55 }, end: { x: 105, y: 51 }, route: [{ t: 'L', to: { x: 105, y: 51 } }] });
  });

  it('maps a coordinate ELK left out to NaN, never 0, so validateResult rejects it with SGL4002 (fix round 1, item 5)', () => {
    const strip = (n: ElkNode, id: string, key: 'x' | 'y'): ElkNode => {
      const kids = n.children?.map((c) => strip(c, id, key));
      const self = n.id === id ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== key)) : n;
      return { ...(self as ElkNode), ...(kids !== undefined && { children: kids }) };
    };
    for (const [id, key] of [[x, 'x'], [inner, 'y']] as const) {
      const bad = fromElkGraph(input, strip(elkOut, id, key));
      const codes = validateResult(bad, g, 'sgl.elk').map((d) => d.code);
      expect(codes, `${id}.${key}`).toContain('SGL4002');
    }
    // A node label's and an edge label's missing x.
    const noLabelX: ElkNode = {
      ...elkOut,
      children: [{ id: x, x: 17, y: 5, width: 60, height: 30, labels: [{ text: 'l:x', width: 9, height: 13, y: 2 }] }, elkOut.children![1]!],
      edges: [{ ...elkOut.edges![0]!, labels: [{ text: 'l:e', width: 25, height: 12, y: 61 }] }, elkOut.edges![1]!],
    };
    const labelled = fromElkGraph(input, noLabelX);
    expect(validateResult(labelled, g, 'sgl.elk').filter((d) => d.code === 'SGL4002')).toHaveLength(2);
  });

  it('leaves out an edge ELK returned without a section, so the host routes it', () => {
    const noSection: ElkNode = { ...elkOut, edges: [{ id: e2!.id, sources: [inner], targets: [x] }] };
    expect(Object.keys(fromElkGraph(input, noSection).edges)).toEqual([]);
  });

  it('maps a port to its centre on the node and the outward normal of its side', () => {
    const portsInput = layoutInputFor('ports.sgl');
    const sw = asNodeId('switch');
    const out: ElkNode = {
      id: 'root',
      width: 100,
      height: 100,
      children: portsInput.graph.rootChildren.map((id) =>
        id === sw
          ? {
              id,
              x: 10,
              y: 20,
              width: 50,
              height: 30,
              ports: [
                { id: 'switch#uplink', x: 0, y: 15, width: 0, height: 0 },
                { id: 'switch#down', x: 50, y: 15, width: 0, height: 0 },
              ],
            }
          : { id, x: 0, y: 0, width: 1, height: 1 },
      ),
      edges: [],
    };
    expect(fromElkGraph(portsInput, out).nodes[sw]?.ports).toEqual({
      uplink: { point: { x: 10, y: 35 }, normal: { x: -1, y: 0 } },
      down: { point: { x: 60, y: 35 }, normal: { x: 1, y: 0 } },
    });
  });

  it('refuses an id it never sent (a violated invariant, reported by the worker as SGL4011)', () => {
    const bogus: ElkNode = { id: 'root', children: [{ id: 'nope', x: 0, y: 0, width: 1, height: 1 }] };
    expect(() => fromElkGraph(input, bogus)).toThrow(/unknown node 'nope'/);
    const bogusEdge: ElkNode = { ...elkOut, edges: [{ id: 'e:nope' as EdgeId, sources: [x], targets: [x] }] };
    expect(() => fromElkGraph(input, bogusEdge)).toThrow(/unknown edge/);
  });
});

describe('fromElkGraph: a route through its own container\'s title is detoured round it (F16, DD-06 §6.2)', () => {
  const input = layoutInputForSource('x\nouter: {\n  @label: "A long container title"\n  inner\n}\nx -> outer.inner\nouter.inner -> x\n');
  const [down, up] = input.graph.edges;
  const outer = asNodeId('outer');
  const inner = asNodeId('outer.inner');
  const top = sizingOf(input, 'outer').padding[0];

  /** `outer` at (100, 100); `inner` at the top of its content, `innerW` wide;
   *  both edges run straight through the title at `runX` (outer-relative). */
  function laidOut(innerW: number, runX: number, edges: 'down' | 'up' | 'both' = 'both') {
    const out: ElkNode = {
      id: 'root',
      width: 400,
      height: 400,
      children: [
        { id: asNodeId('x'), x: 100, y: 10, width: 300, height: 30, labels: [{ text: 'l:x', width: 9, height: 13, x: 0, y: 0 }] },
        {
          id: outer,
          x: 100,
          y: 100,
          width: 260,
          height: 200,
          children: [{ id: inner, x: 16, y: top, width: innerW, height: 36, labels: [{ text: 'l:outer.inner', width: 9, height: 13, x: 0, y: 0 }] }],
        },
      ],
      edges: [
        ...(edges === 'up' ? [] : [{ id: down!.id, sources: ['x'], targets: [inner], container: 'root', sections: [{ startPoint: { x: 100 + runX, y: 40 }, endPoint: { x: 100 + runX, y: 100 + top } }] }]),
        ...(edges === 'down' ? [] : [{ id: up!.id, sources: [inner], targets: ['x'], container: 'root', sections: [{ startPoint: { x: 100 + runX + 10, y: 100 + top }, endPoint: { x: 100 + runX + 10, y: 40 } }] }]),
      ],
    };
    const result = fromElkGraph(input, out);
    const title = result.labels.find((l) => l.labelId === input.graph.nodes[outer]!.labelId)!.frame;
    const points = (id: EdgeId) => [result.edges[id]!.start, ...result.edges[id]!.route.map((s) => (s as { to: { x: number; y: number } }).to)];
    return { result, title, points };
  }

  const through = (pts: readonly { x: number; y: number }[], r: { x: number; y: number; w: number; h: number }): boolean =>
    pts.some((a, i) => {
      const b = pts[i + 1];
      if (b === undefined) return false;
      return Math.min(a.x, b.x) < r.x + r.w && Math.max(a.x, b.x) > r.x && Math.min(a.y, b.y) < r.y + r.h && Math.max(a.y, b.y) > r.y;
    });
  const orthogonal = (pts: readonly { x: number; y: number }[]): boolean => pts.every((a, i) => i === 0 || a.x === pts[i - 1]!.x || a.y === pts[i - 1]!.y);

  it('ends the run on its node, right of the title, when the node reaches that far; an upward run moves its start the same way', () => {
    const { title, points, result } = laidOut(200, 40);
    const inside = result.nodes[inner]!.frame;
    for (const [id, endIdx] of [
      [down!.id, -1],
      [up!.id, 0],
    ] as const) {
      const pts = points(id);
      expect(through(pts, title), id).toBe(false);
      expect(orthogonal(pts), id).toBe(true);
      expect(pts).toHaveLength(4);
      const onNode = pts.at(endIdx)!;
      expect(onNode.y).toBe(inside.y);
      expect(onNode.x).toBeGreaterThan(title.x + title.w);
      expect(onNode.x).toBeLessThan(inside.x + inside.w);
      // Every new point is inside the container's title band.
      for (const p of pts.slice(1, -1)) expect(p.y > 100 && p.y < 100 + top).toBe(true);
      // What the detour computes is on the 1/64 px grid (ELK's own y is kept).
      for (const p of pts.slice(1, -1)) expect(Number.isInteger(p.x * 64) && Number.isInteger(p.y * 64)).toBe(true);
    }
    // Two runs through one title never share an x or a turn.
    const [d, u] = [points(down!.id), points(up!.id)];
    expect(d[2]!.x).not.toBe(u[1]!.x);
    expect(d[1]!.y).not.toBe(u[2]!.y);
  });

  it('turns back to its own x below the title, still in the band, when the node ends under the title', () => {
    const { title, points } = laidOut(40, 40, 'down');
    const pts = points(down!.id);
    expect(through(pts, title)).toBe(false);
    expect(orthogonal(pts)).toBe(true);
    expect(pts).toHaveLength(6);
    expect(pts[0]).toEqual({ x: 140, y: 40 });
    expect(pts.at(-1)).toEqual({ x: 140, y: 100 + top });
    const back = pts[4]!;
    expect(back.x).toBe(140);
    expect(back.y).toBeGreaterThan(title.y + title.h);
    expect(back.y).toBeLessThan(100 + top);
  });

  it('leaves a run that misses the title untouched', () => {
    const { title, points } = laidOut(240, 0, 'down');
    const clearX = Math.ceil(title.x + title.w - 100) + 2;
    const other = laidOut(240, clearX, 'down');
    expect(other.points(down!.id)).toEqual([
      { x: 100 + clearX, y: 40 },
      { x: 100 + clearX, y: 100 + top },
    ]);
    expect(points(down!.id)).toHaveLength(2);
  });
});
