import type { GraphNode, NodeId, PortId, SemanticGraph } from '@sgl/core';
import { neutralDark, neutralLight, resolveTheme, type ResolvedTheme, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { render } from '../src/index.js';
import type { LayoutView } from '../src/layout-view.js';
import { nodeElementId } from '../src/security.js';
import { listCorpusDocs, renderCorpusDoc } from './pipeline.js';

/** Every document `compile()` handles cleanly — no error diagnostics — kept in
 *  step with `packages/core/test/compile.test.ts`'s own `CLEAN_DOCS`. Goldens
 *  and structural assertions only make sense against a clean document; the
 *  full corpus (`malformed/`, `unresolved/`, `injection/`) is still exercised
 *  below by the "never throws" and double-run sweeps, which is the property
 *  that matters for those. */
const CLEAN_DOCS = [
  'empty.sgl',
  'single.sgl',
  'json-form.sgl.json',
  'checkout.sgl',
  'nesting-3.sgl',
  'chains.sgl',
  'parallel-selfloop.sgl',
  'ports.sgl',
  'classes.sgl',
  'containers-edges.sgl',
  'wildcards.sgl',
  'wildcard-globs.sgl',
  'shapes.sgl',
  'unicode.sgl',
  'hidden.sgl',
  'a11y-links.sgl',
];

const THEMES: readonly ThemeDoc[] = [neutralLight, neutralDark];
const DOCS = listCorpusDocs();

describe('render(): corpus goldens (grid engine x both built-in themes, DD-07 §11)', () => {
  it('has at least the documents this suite assumes', () => {
    expect(CLEAN_DOCS).toContain('nesting-3.sgl');
    expect(CLEAN_DOCS).toContain('hidden.sgl');
  });

  for (const theme of THEMES) {
    for (const doc of CLEAN_DOCS) {
      it(`${doc} under ${theme.id}: render golden`, async () => {
        const { rendered } = await renderCorpusDoc(doc, theme);
        expect(rendered.diagnostics).toEqual([]);
        await expect(`${rendered.svg}\n`).toMatchFileSnapshot(`./__goldens__/render/${theme.id}/${doc}.svg`);
      });
    }
  }
});

describe('render(): never throws, over the whole corpus including malformed/unresolved/injection', () => {
  for (const doc of DOCS) {
    it(`${doc}: renders to a well-formed SVG string with no crash`, async () => {
      const { rendered } = await renderCorpusDoc(doc);
      expect(rendered.svg.startsWith('<svg')).toBe(true);
      expect(rendered.svg.endsWith('</svg>')).toBe(true);
      expect(Number.isFinite(rendered.bounds.w)).toBe(true);
      expect(Number.isFinite(rendered.bounds.h)).toBe(true);
    });
  }
});

describe('render(): double-run determinism (DD-00 §3, DD-07 §11)', () => {
  for (const doc of DOCS) {
    it(`${doc}: byte-identical across two runs under neutral-light`, async () => {
      const a = await renderCorpusDoc(doc, neutralLight);
      const b = await renderCorpusDoc(doc, neutralLight);
      expect(a.rendered.svg).toBe(b.rendered.svg);
      expect(a.rendered.styleBlock).toBe(b.rendered.styleBlock);
    });
  }

  for (const doc of CLEAN_DOCS) {
    it(`${doc}: byte-identical across two runs under neutral-dark`, async () => {
      const a = await renderCorpusDoc(doc, neutralDark);
      const b = await renderCorpusDoc(doc, neutralDark);
      expect(a.rendered.svg).toBe(b.rendered.svg);
    });
  }
});

describe('render(): document structure (DD-07 §2)', () => {
  it('layer order is fixed: containers, edges, nodes, labels', async () => {
    const { rendered } = await renderCorpusDoc('nesting-3.sgl');
    const order = ['L-containers', 'L-edges', 'L-nodes', 'L-labels'].map((cls) =>
      rendered.svg.indexOf(`<g class="${cls}">`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('root svg carries the fixed namespace, class, data-sgl, dimensions and role', async () => {
    const { rendered } = await renderCorpusDoc('single.sgl');
    expect(rendered.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(rendered.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(rendered.svg).toContain('class="sgl" data-sgl="1.0"');
    expect(rendered.svg).toContain('role="img" aria-labelledby="sgl-t sgl-d"');
  });
});

describe('render(): accessibility (DD-07 §7)', () => {
  it('root has <title>, <desc> with the node/edge/group counts, referenced by aria-labelledby', async () => {
    const { rendered, styled } = await renderCorpusDoc('nesting-3.sgl');
    const { nodeCount, edgeCount, containerCount } = styled.graph.meta;
    expect(rendered.svg).toContain('<title id="sgl-t">Nesting</title>');
    expect(rendered.svg).toContain(`<desc id="sgl-d">${nodeCount} nodes, ${edgeCount} connections, ${containerCount} groups.</desc>`);
  });

  it('an untitled document falls back to "Diagram"', async () => {
    const { rendered } = await renderCorpusDoc('single.sgl');
    expect(rendered.svg).toContain('<title id="sgl-t">Diagram</title>');
  });

  it('the canvas rect carries aria-hidden="true"', async () => {
    const { rendered } = await renderCorpusDoc('ports.sgl');
    expect(rendered.svg).toMatch(/<rect class="canvas"[^>]*aria-hidden="true"/);
  });

  it('a port circle carries aria-hidden="true" (DD-07 §7) — unreachable via the current pipeline, so unit-tested directly against render()', () => {
    // `ports.sgl` declares real ports, but `grid` declares capabilities.ports:
    // false and has no host fallback that places them (DD-06 §2's `placeLabels`/
    // `routeStraight` cover labels and routing, not ports), so
    // `LayoutResult.nodes[id].ports` is never populated end to end today — the
    // renderNode ports loop this pins is currently dead code reachable only by
    // constructing a LayoutView with ports by hand, exactly as DD-07's own
    // `LayoutView` doc comment anticipates ("every field here is structurally
    // satisfied by the real LayoutResult ... no cast at the call site").
    const { styled, layout, theme } = portedFixture();
    const { svg } = render(styled, layout, theme);
    expect(svg).toMatch(/<circle class="n-port" cx="[\d.]+" cy="[\d.]+" r="[\d.]+" aria-hidden="true"\/>/);
  });

  it('every node/container group carries role="group" and an aria-label', async () => {
    const { rendered, styled } = await renderCorpusDoc('nesting-3.sgl');
    for (const id of styled.graph.order) {
      const node = styled.graph.nodes[id];
      if (node === undefined) continue;
      const gid = nodeElementId(id as string);
      const re = new RegExp(`<g id="${gid}" class="[^"]*" role="group" aria-label="[^"]*"`);
      expect(rendered.svg).toMatch(re);
    }
  });

  it('every edge group carries role="graphics-symbol" and an aria-label naming its endpoints', async () => {
    const { rendered, styled } = await renderCorpusDoc('nesting-3.sgl');
    for (const edge of styled.graph.edges) {
      if (edge.hidden) continue;
      const eid = `e-${edge.id.replace(/^e-/, '')}`;
      const re = new RegExp(`<g id="${eid}" class="[^"]*" role="graphics-symbol" aria-label="([^"]*)"`);
      const match = re.exec(rendered.svg);
      expect(match).not.toBeNull();
      const joiner = edge.directed === 'none' ? 'and' : 'to';
      expect(match![1]).toContain(`${edge.from.node} ${joiner} ${edge.to.node}`);
    }
  });

  it('@a11y.label overrides the default aria-label; @a11y.description adds aria-description', async () => {
    const { rendered } = await renderCorpusDoc('a11y-links.sgl');
    const gid = nodeElementId('a');
    expect(rendered.svg).toContain(`<g id="${gid}" class="n sh-rect" role="group" aria-label="Custom label" aria-description="Extra detail for screen readers"`);
  });

  it('@a11y.description on an edge adds aria-description without needing @a11y.label', async () => {
    const { rendered, styled } = await renderCorpusDoc('a11y-links.sgl');
    const edge = styled.graph.edges[0]!;
    expect(rendered.svg).toContain(`aria-label="a to b"`);
    expect(rendered.svg).toContain(`aria-description="An edge description"`);
    expect(edge.from.node).toBe('a');
  });

  it('a node with a valid @link wraps its <g> in <a href rel="noopener noreferrer" target="_blank">', async () => {
    const { rendered } = await renderCorpusDoc('a11y-links.sgl');
    expect(rendered.svg).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">');
    expect(rendered.diagnostics).toEqual([]);
  });

  it('document order for nodes/containers follows graph.order, filtered by layer (containers vs leaves)', async () => {
    const { rendered, styled } = await renderCorpusDoc('nesting-3.sgl');
    const containersLayer = between(rendered.svg, '<g class="L-containers">', '</g><g class="L-edges">');
    const nodesLayer = between(rendered.svg, '<g class="L-nodes">', '</g><g class="L-labels">');

    const expectedContainers = styled.graph.order.filter((id) => (styled.graph.nodes[id]?.children.length ?? 0) > 0);
    const expectedLeaves = styled.graph.order.filter((id) => (styled.graph.nodes[id]?.children.length ?? 0) === 0);

    expect(extractGroupIds(containersLayer)).toEqual(expectedContainers.map((id) => nodeElementId(id as string)));
    expect(extractGroupIds(nodesLayer)).toEqual(expectedLeaves.map((id) => nodeElementId(id as string)));
  });

  it('document order for edges follows declaration order, skipping hidden edges', async () => {
    const { rendered, styled } = await renderCorpusDoc('hidden.sgl');
    const edgesLayer = between(rendered.svg, '<g class="L-edges">', '</g><g class="L-nodes">');
    const expected = styled.graph.edges.filter((e) => !e.hidden).map((e) => `e-${e.id.replace(/^e-/, '')}`);
    expect(extractGroupIds(edgesLayer)).toEqual(expected);
  });

  it('a hidden node has no group anywhere in the tree', async () => {
    const { rendered, styled } = await renderCorpusDoc('hidden.sgl');
    const hiddenId = Object.keys(styled.graph.nodes).find((id) => styled.graph.nodes[id as never]?.hidden === true);
    expect(hiddenId).toBeDefined();
    expect(rendered.svg).not.toContain(`id="${nodeElementId(hiddenId!)}"`);
  });
});

function between(svg: string, startMarker: string, endMarker: string): string {
  const start = svg.indexOf(startMarker) + startMarker.length;
  const end = svg.indexOf(endMarker, start);
  return svg.slice(start, end);
}

function extractGroupIds(layer: string): string[] {
  return [...layer.matchAll(/<g id="([^"]+)"/g)].map((m) => m[1]!);
}

/** A single leaf node with one port, hand-built rather than drawn from the
 *  corpus because no path from `compile()` to `LayoutResult` populates
 *  `NodeLayout.ports` today (see the test above). */
function portedFixture(): { readonly styled: StyledGraph; readonly layout: LayoutView; readonly theme: ResolvedTheme } {
  const id = 'p' as NodeId;
  const node: GraphNode = {
    id,
    path: ['p'],
    parent: null,
    children: [],
    depth: 0,
    shape: 'rect',
    classes: [],
    labelId: null,
    ports: [{ id: 'out' as PortId, side: 'east' }],
    config: {},
    hidden: false,
    span: { from: 0, to: 0 },
  };
  const graph: SemanticGraph = {
    nodes: { [id]: node },
    edges: [],
    rootChildren: [id],
    order: [id],
    labels: {},
    meta: { nodeCount: 1, edgeCount: 0, containerCount: 0 },
  };
  const styled: StyledGraph = {
    graph,
    styles: {},
    labelStyles: {},
    canvas: { background: '#ffffff' },
    themeId: 'neutral-light',
    geometryHash: 'g',
    paintHash: 'p',
  };
  const { value: theme } = resolveTheme(neutralLight, (tid) => (tid === neutralLight.id ? neutralLight : undefined));
  const layout: LayoutView = {
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    nodes: { [id]: { frame: { x: 0, y: 0, w: 80, h: 40 }, ports: { out: { point: { x: 80, y: 20 }, normal: { x: 1, y: 0 } } } } },
    edges: {},
    labels: [],
  };
  return { styled, layout, theme };
}
