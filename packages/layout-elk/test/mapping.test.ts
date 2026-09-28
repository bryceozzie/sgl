import { asNodeId, type EdgeId, type LabelId, type NodeId } from '@sgl/core';
import { validateResult, type LayoutInput, type NodeSizing } from '@sgl/layout-api';
import { describe, expect, it } from 'vitest';
import { ELK_DEFAULT_OPTIONS, ELK_PORT_CONSTRAINTS, elkDescriptor, normalizeElkOptions, type ElkOptions } from '../src/descriptor.js';
import { elkNodeId, fromElkGraph, labelBox, leafSize, portId, toElkGraph, type ElkNode } from '../src/mapping.js';
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

/** F32: the author's id of a node ELK was sent (`n:<id>`, DD-06 §6.1). */
const authorId = (n: ElkNode): NodeId => n.id.slice(2) as NodeId;
const N = (id: string): string => elkNodeId(id as NodeId);
const E = (id: EdgeId): string => `e:${id}`;

function findElk(root: ElkNode, id: string): ElkNode {
  const found = allElkNodes(root).find((n) => n.id === N(id));
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
    const sizing = sizingOf(input, authorId(leaf!));
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
        const sizing = sizingOf(input, authorId(c));
        // No label: ELK would otherwise reserve a left column and add the band a second time.
        expect(c.labels).toBeUndefined();
        const [t, r, b, l] = sizing.padding;
        expect(c.layoutOptions?.['elk.padding']).toBe(`[top=${t},left=${l},bottom=${b},right=${r}]`);
        const title = input.labelSizes[input.graph.nodes[authorId(c)]!.labelId!]!;
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
      const node = input.graph.nodes[authorId(elk)]!;
      const size = input.labelSizes[node.labelId!]!;
      const [t, , b] = sizingOf(input, authorId(elk)).contentInset;
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

  it('maps ports (FIXED_SIDE, zero-size, id p<length>:node#port) and port-terminated edges', () => {
    const input = layoutInputFor('ports.sgl');
    const graph = toElkGraph(input, opts(), METRICS);
    const router = findElk(graph, 'router');
    expect(router.layoutOptions).toEqual({ 'elk.portConstraints': 'FIXED_SIDE' });
    expect(router.ports).toEqual([
      { id: 'p6:router#in', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
      { id: 'p6:router#out', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } },
      { id: 'p6:router#mgmt', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'NORTH' } },
      { id: 'p6:router#drain', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'SOUTH' } },
    ]);
    const edges = graph.edges ?? [];
    expect(edges.map((e) => [e.sources[0], e.targets[0]])).toEqual([
      ['n:client', 'p6:router#in'],
      ['p6:router#out', 'p6:switch#uplink'],
      ['p6:switch#down', 'n:server'],
      ['n:console', 'p6:router#mgmt'],
      ['p6:router#drain', 'n:server'],
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
      expect(ids.has(N(id))).toBe(!input.graph.nodes[id]!.hidden);
    }
    expect((graph.edges ?? []).map((e) => e.id)).toEqual(input.graph.edges.filter((e) => !e.hidden).map((e) => E(e.id)));
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
      { id: N(x), x: 17, y: 5, width: 60, height: 30, labels: [{ text: 'l:x', width: 9, height: 13, x: 31, y: 2 }] },
      {
        id: N(outer),
        x: 100,
        y: 50,
        width: 200,
        height: 150,
        children: [{ id: N(inner), x: 20, y: 40, width: 70, height: 30, labels: [{ text: 'l:inner', width: 30, height: 13, x: 3, y: 11 }] }],
      },
    ],
    edges: [
      {
        id: E(e1!.id),
        sources: [N(x)],
        targets: [N(inner)],
        container: 'root',
        sections: [{ startPoint: { x: 47, y: 35 }, bendPoints: [{ x: 47, y: 60 }, { x: 155, y: 60 }], endPoint: { x: 155, y: 90 } }],
        labels: [{ text: 'l:e', width: 25, height: 12, x: 60, y: 61 }],
      },
      {
        id: E(e2!.id),
        sources: [N(inner)],
        targets: [N(x)],
        container: N(outer),
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
      const self = n.id === N(id) ? Object.fromEntries(Object.entries(n).filter(([k]) => k !== key)) : n;
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
      children: [{ id: N(x), x: 17, y: 5, width: 60, height: 30, labels: [{ text: 'l:x', width: 9, height: 13, y: 2 }] }, elkOut.children![1]!],
      edges: [{ ...elkOut.edges![0]!, labels: [{ text: 'l:e', width: 25, height: 12, y: 61 }] }, elkOut.edges![1]!],
    };
    const labelled = fromElkGraph(input, noLabelX);
    expect(validateResult(labelled, g, 'sgl.elk').filter((d) => d.code === 'SGL4002')).toHaveLength(2);
  });

  it('leaves out an edge ELK returned without a section, so the host routes it', () => {
    const noSection: ElkNode = { ...elkOut, edges: [{ id: E(e2!.id), sources: [N(inner)], targets: [N(x)] }] };
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
              id: N(id),
              x: 10,
              y: 20,
              width: 50,
              height: 30,
              ports: [
                { id: portId(sw, 'uplink'), x: 0, y: 15, width: 0, height: 0 },
                { id: portId(sw, 'down'), x: 50, y: 15, width: 0, height: 0 },
              ],
            }
          : { id: N(id), x: 0, y: 0, width: 1, height: 1 },
      ),
      edges: [],
    };
    expect(fromElkGraph(portsInput, out).nodes[sw]?.ports).toEqual({
      uplink: { point: { x: 10, y: 35 }, normal: { x: -1, y: 0 } },
      down: { point: { x: 60, y: 35 }, normal: { x: 1, y: 0 } },
    });
  });

  it('refuses an id it never sent (a violated invariant, reported by the worker as SGL4011)', () => {
    const bogus: ElkNode = { id: 'root', children: [{ id: 'n:nope', x: 0, y: 0, width: 1, height: 1 }] };
    expect(() => fromElkGraph(input, bogus)).toThrow(/unknown node 'n:nope'/);
    const bogusEdge: ElkNode = { ...elkOut, edges: [{ id: 'e:nope', sources: [N(x)], targets: [N(x)] }] };
    expect(() => fromElkGraph(input, bogusEdge)).toThrow(/unknown edge/);
    // F32: an author id without its namespace is not one ELK was sent.
    const bare: ElkNode = { ...elkOut, children: [{ ...elkOut.children![0]!, id: x }, elkOut.children![1]!] };
    expect(() => fromElkGraph(input, bare)).toThrow(/unknown node 'x'/);
    const bareEdge: ElkNode = { ...elkOut, edges: [{ ...elkOut.edges![0]!, id: e1!.id }] };
    expect(() => fromElkGraph(input, bareEdge)).toThrow(/unknown edge/);
  });
});

describe('fromElkGraph: a route through its own container\'s title is detoured round it (F16, DD-06 §6.2)', () => {
  const input = layoutInputForSource(
    'x\ny\nouter: {\n  @label: "A long container title"\n  inner: { @ports: { p: north } }\n}\nx -> outer.inner\nouter.inner -> x\nx -> outer.inner[p]\nx -> y\n',
  );
  const [down, up, port, unrelated] = input.graph.edges;
  const outer = asNodeId('outer');
  const inner = asNodeId('outer.inner');
  const top = sizingOf(input, 'outer').padding[0];
  const ARROW = METRICS.arrowSize;
  type Run = 'down' | 'up' | 'port' | 'unrelated';

  /** `x` above `outer` at (100, 100), `y` below it; `inner` at the top of
   *  `outer`'s content, `innerW` wide. Each edge in `runs` runs straight
   *  through the title at the given x (outer-relative); `dx` offsets a run's
   *  second point (ELK's floating-point noise). */
  function laidOut(innerW: number, runs: Partial<Record<Run, number>>, dx = 0) {
    const at = (x: number) => 100 + x;
    const edge = (id: EdgeId, sources: string[], targets: string[], x: number, from: number, to: number) => ({
      id: E(id),
      sources: sources.map((s) => (s.startsWith('p') ? s : N(s))),
      targets: targets.map((t) => (t.startsWith('p') ? t : N(t))),
      container: 'root',
      sections: [{ startPoint: { x: at(x), y: from }, endPoint: { x: at(x) + dx, y: to } }],
    });
    const out: ElkNode = {
      id: 'root',
      width: 400,
      height: 500,
      children: [
        { id: N('x'), x: 100, y: 10, width: 300, height: 30, labels: [{ text: 'l:x', width: 9, height: 13, x: 0, y: 0 }] },
        { id: N('y'), x: 100, y: 400, width: 300, height: 30, labels: [{ text: 'l:y', width: 9, height: 13, x: 0, y: 0 }] },
        {
          id: N(outer),
          x: 100,
          y: 100,
          width: 260,
          height: 200,
          children: [
            {
              id: N(inner),
              x: 16,
              y: top,
              width: innerW,
              height: 36,
              labels: [{ text: 'l:outer.inner', width: 9, height: 13, x: 0, y: 0 }],
              ports: runs.port === undefined ? [] : [{ id: portId(inner, 'p'), x: runs.port - 16, y: 0, width: 0, height: 0 }],
            },
          ],
        },
      ],
      edges: [
        ...(runs.down === undefined ? [] : [edge(down!.id, ['x'], [inner], runs.down, 40, 100 + top)]),
        ...(runs.up === undefined ? [] : [edge(up!.id, [inner], ['x'], runs.up, 100 + top, 40)]),
        ...(runs.port === undefined ? [] : [edge(port!.id, ['x'], [portId(inner, 'p')], runs.port, 40, 100 + top)]),
        ...(runs.unrelated === undefined ? [] : [edge(unrelated!.id, ['x'], ['y'], runs.unrelated, 40, 400)]),
      ],
    };
    const plain = fromElkGraph(input, JSON.parse(JSON.stringify(out)) as ElkNode);
    const result = fromElkGraph(input, out, ARROW);
    const title = result.labels.find((l) => l.labelId === input.graph.nodes[outer]!.labelId)!.frame;
    const pointsIn = (r: typeof result, id: EdgeId) => [r.edges[id]!.start, ...r.edges[id]!.route.map((s) => (s as { to: { x: number; y: number } }).to)];
    return { result, plain, title, points: (id: EdgeId) => pointsIn(result, id) };
  }

  type P = { readonly x: number; readonly y: number };
  const through = (pts: readonly P[], r: { x: number; y: number; w: number; h: number }): boolean =>
    pts.some((a, i) => {
      const b = pts[i + 1];
      if (b === undefined) return false;
      return Math.min(a.x, b.x) < r.x + r.w && Math.max(a.x, b.x) > r.x && Math.min(a.y, b.y) < r.y + r.h && Math.max(a.y, b.y) > r.y;
    });
  const orthogonal = (pts: readonly P[]): boolean => pts.every((a, i) => i === 0 || a.x === pts[i - 1]!.x || a.y === pts[i - 1]!.y);
  const within = (a: number, b: number, c: number, d: number): boolean => Math.max(Math.min(a, b), Math.min(c, d)) <= Math.min(Math.max(a, b), Math.max(c, d));
  /** Whether two routes meet anywhere but at a point they share at their ends. */
  const meet = (p: readonly P[], q: readonly P[]): boolean =>
    p.some((a, i) => i > 0 && q.some((b, j) => j > 0 && within(p[i - 1]!.x, a.x, q[j - 1]!.x, b.x) && within(p[i - 1]!.y, a.y, q[j - 1]!.y, b.y)));

  it('ends a run on its node, right of the title, when the node reaches that far; an upward run moves its start the same way', () => {
    const { title, points, result } = laidOut(200, { down: 40, up: 50 });
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
      expect(onNode.x + 0.375 * ARROW).toBeLessThanOrEqual(inside.x + inside.w);
      // Every new point is inside the container's title band.
      for (const p of pts.slice(1, -1)) expect(p.y > 100 && p.y < 100 + top).toBe(true);
      // What the detour computes is on the 1/64 px grid (ELK's own y is kept).
      for (const p of pts.slice(1, -1)) expect(Number.isInteger(p.x * 64) && Number.isInteger(p.y * 64)).toBe(true);
    }
    // Two runs through one title never meet, and their arrowheads (0.75 x
    // arrowSize wide) are apart.
    const [d, u] = [points(down!.id), points(up!.id)];
    expect(meet(d, u)).toBe(false);
    expect(Math.abs(d.at(-1)!.x - u[0]!.x)).toBeGreaterThan(0.75 * ARROW);
  });

  it('item 1: enters the node\'s side, the last segment at least arrowSize plus the clearance, when the node lies under the title', () => {
    const { title, points, result } = laidOut(40, { down: 40 });
    const pts = points(down!.id);
    const f = result.nodes[inner]!.frame;
    expect(through(pts, title)).toBe(false);
    expect(orthogonal(pts)).toBe(true);
    expect(pts[0]).toEqual({ x: 140, y: 40 });
    const [before, end] = pts.slice(-2) as [P, P];
    expect(end).toEqual({ x: f.x + f.w, y: f.y + f.h / 2 });
    expect(before.y).toBe(end.y);
    expect(before.x - end.x).toBeGreaterThanOrEqual(ARROW + 4);
    // The arrowhead, `arrowSize` back from the end, is clear of the title.
    expect(through([{ x: end.x, y: end.y - 0.375 * ARROW }, { x: end.x + ARROW, y: end.y + 0.375 * ARROW }], title)).toBe(false);
  });

  it('item 3: a run to a port is never moved, and a detour never crosses it', () => {
    // The port run right of the other: neither can be detoured without the
    // other's crossing it, so neither is.
    const right = laidOut(200, { down: 40, port: 60 });
    expect(right.points(down!.id)).toEqual([
      { x: 140, y: 40 },
      { x: 140, y: 100 + top },
    ]);
    expect(right.points(port!.id)).toEqual([
      { x: 160, y: 40 },
      { x: 160, y: 100 + top },
    ]);
    // The port run left of the other: the other is detoured, clear of it.
    const left = laidOut(200, { port: 30, down: 50 });
    expect(left.points(port!.id)).toEqual([
      { x: 130, y: 40 },
      { x: 130, y: 100 + top },
    ]);
    expect(through(left.points(down!.id), left.title)).toBe(false);
    expect(meet(left.points(down!.id), left.points(port!.id))).toBe(false);
  });

  it('item 6: a route through the title of a container that holds neither end is left alone', () => {
    const { title, points } = laidOut(200, { unrelated: 40 });
    expect(through(points(unrelated!.id), title)).toBe(true);
    expect(points(unrelated!.id)).toEqual([
      { x: 140, y: 40 },
      { x: 140, y: 400 },
    ]);
  });

  it('item 7: a run is vertical within a tolerance (ELK\'s floating point)', () => {
    const { title, points } = laidOut(200, { down: 40 }, 1e-9);
    expect(through(points(down!.id), title)).toBe(false);
  });

  it('leaves a run that misses the title untouched', () => {
    const { title, points } = laidOut(240, { down: 0 });
    const clearX = Math.ceil(title.x + title.w - 100) + 2;
    const other = laidOut(240, { down: clearX });
    expect(other.points(down!.id)).toEqual([
      { x: 100 + clearX, y: 40 },
      { x: 100 + clearX, y: 100 + top },
    ]);
    expect(points(down!.id)).toHaveLength(2);
  });

  it('does nothing without an arrow size (the engine leaves it out under SPLINES)', () => {
    const { plain } = laidOut(200, { down: 40 });
    expect(through([plain.edges[down!.id]!.start, plain.edges[down!.id]!.end], laidOut(200, { down: 40 }).title)).toBe(true);
  });
});
