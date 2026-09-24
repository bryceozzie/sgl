import {
  asEdgeId,
  asLabelId,
  asNodeId,
  type ClassModel,
  type ConfigBag,
  type GraphEdge,
  type GraphNode,
  type LabelId,
  type SemanticGraph,
  type SourceSpan,
} from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { DASH_PATTERNS, resolveTheme, styleGraph } from '../src/cascade.js';
import { COLOR_FALLBACK } from '../src/registry.js';
import { BUILT_IN, neutralDark, neutralLight } from '../src/themes/index.js';
import type { ResolvedTheme, StyleSet, ThemeDoc } from '../src/types.js';
import { corpusGraph } from './corpus.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// `fixture()` below still builds its graph by hand — Stage D (07 §5) re-points
// what it reasonably can at real `corpus/` documents (see "over the corpus" blocks
// throughout this file), but a handful of tests need a shape the corpus does not
// contain: an invalid `@style`/`@size` value (the corpus has none — that is a
// resolver/theme diagnostics concern with no fixture yet, per corpus/README.md
// "Not yet covered"), or a node carrying exactly one class with no inline override
// (every real document's `Critical`-classed node also sets its own `@style`).
// Those keep `fixture()`; everything else now runs through the real compiler.
// ---------------------------------------------------------------------------

const SPAN: SourceSpan = { from: 0, to: 0 };
const BUILT_IN_LOOKUP = (id: string): ThemeDoc | undefined => BUILT_IN[id];

function node(
  id: string,
  over: Partial<GraphNode> = {},
): GraphNode {
  return {
    id: asNodeId(id),
    path: id.split('.'),
    parent: null,
    children: [],
    depth: 0,
    shape: 'rect',
    classes: [],
    labelId: asLabelId(`l:${id}`),
    ports: [],
    config: {},
    hidden: false,
    span: SPAN,
    ...over,
  };
}

function edge(id: string, from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: asEdgeId(id),
    from: { node: asNodeId(from) },
    to: { node: asNodeId(to) },
    directed: 'forward',
    classes: [],
    labelId: asLabelId(`l:${id}`),
    config: {},
    declaredIn: null,
    hidden: false,
    span: SPAN,
    ...over,
  };
}

/** `group` (a container) holding `group.api`, a standalone `db` cylinder, and one
 *  labelled edge between them. Enough surface for every cascade step. */
function fixture(over: { readonly nodes?: readonly GraphNode[]; readonly edges?: readonly GraphEdge[] } = {}): SemanticGraph {
  const nodes: readonly GraphNode[] = over.nodes ?? [
    node('group', { children: [asNodeId('group.api')] }),
    node('group.api', { parent: asNodeId('group'), depth: 1, shape: 'round' }),
    node('db', { shape: 'cylinder' }),
  ];
  const edges: readonly GraphEdge[] = over.edges ?? [edge('e-1', 'group.api', 'db')];

  const byId: Record<string, GraphNode> = {};
  for (const n of nodes) byId[n.id] = n;
  const labels: Record<string, { id: LabelId; owner: { kind: 'node'; id: ReturnType<typeof asNodeId> } | { kind: 'edge'; id: ReturnType<typeof asEdgeId> }; role: 'title' | 'edge'; runs: readonly { text: string }[] }> = {};
  for (const n of nodes) {
    if (n.labelId !== null) {
      labels[n.labelId] = { id: n.labelId, owner: { kind: 'node', id: n.id }, role: 'title', runs: [{ text: n.id }] };
    }
  }
  for (const e of edges) {
    if (e.labelId !== null) {
      labels[e.labelId] = { id: e.labelId, owner: { kind: 'edge', id: e.id }, role: 'edge', runs: [{ text: e.id }] };
    }
  }

  return {
    nodes: byId,
    edges,
    rootChildren: nodes.filter((n) => n.parent === null).map((n) => n.id),
    order: nodes.map((n) => n.id),
    labels,
    meta: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      containerCount: nodes.filter((n) => n.children.length > 0).length,
    },
  } as SemanticGraph;
}

/** A minimal standalone theme, for the token and diagnostic tests. */
function theme(over: Partial<ThemeDoc> = {}): ThemeDoc {
  return {
    id: 'test',
    name: 'Test',
    schemaVersion: 1,
    extends: null,
    tokens: {},
    rules: {},
    byShape: {},
    byClass: {},
    canvas: { background: '#FFFFFF' },
    ...over,
  };
}

/** `neutral-light` with one rule set patched — used to change exactly one
 *  property and watch exactly one hash move. */
function patchedLight(rule: string, patch: StyleSet): ThemeDoc {
  return {
    ...neutralLight,
    id: 'patched',
    rules: { ...neutralLight.rules, [rule]: { ...neutralLight.rules[rule], ...patch } },
  };
}

/** `neutral-light` with only `canvas.background` changed — every rule, every
 *  `byShape`/`byClass` entry and every token stays identical, so this isolates
 *  the canvas term in `paintHash` from every other paint source. */
function patchedCanvasBackground(background: string): ThemeDoc {
  return { ...neutralLight, id: 'patched-canvas', canvas: { background } };
}

function resolved(doc: ThemeDoc): ResolvedTheme {
  const { value, diagnostics } = resolveTheme(doc, BUILT_IN_LOOKUP);
  expect(diagnostics.map((d) => d.code)).toEqual([]);
  return value;
}

const codes = (ds: readonly { code: string }[]): readonly string[] => ds.map((d) => d.code);

// ---------------------------------------------------------------------------
// resolveTheme — DD-04 §3
// ---------------------------------------------------------------------------

describe('resolveTheme: the built-in themes', () => {
  // DD-00 §6, the Theme exit criterion.
  it.each(Object.keys(BUILT_IN))('resolves %s with zero diagnostics', (id) => {
    const doc = BUILT_IN[id] as ThemeDoc;
    const { value, diagnostics } = resolveTheme(doc, BUILT_IN_LOOKUP);
    expect(diagnostics).toEqual([]);
    expect(value.id).toBe(id);
  });

  it('leaves no `@` reference anywhere in the output', () => {
    for (const id of Object.keys(BUILT_IN)) {
      const t = resolved(BUILT_IN[id] as ThemeDoc);
      const serialised = JSON.stringify([t.rules, t.byShape, t.byClass, t.canvas, t.tokens]);
      expect(serialised, id).not.toMatch(/"@/);
    }
  });

  it('normalises insets, lengths and colours', () => {
    const t = resolved(neutralLight);
    // `[8, 12]` is the two-value form: top/bottom 8, left/right 12.
    expect(t.rules['node']?.padding).toEqual([8, 12, 8, 12]);
    expect(t.rules['container']?.padding).toEqual([16, 16, 16, 16]);
    expect(t.rules['node']?.strokeWidth).toBe(1.5);
    expect(t.rules['node']?.fill).toBe('#FFFFFF');
    expect(t.canvas.background).toBe('#F7F8FA');
  });

  it('makes neutral-dark inherit every rule of neutral-light and override the tokens', () => {
    const light = resolved(neutralLight);
    const dark = resolved(neutralDark);
    expect(Object.keys(dark.rules).sort()).toEqual(Object.keys(light.rules).sort());
    // Geometry is inherited verbatim; only the colours move.
    expect(dark.rules['node']?.strokeWidth).toBe(light.rules['node']?.strokeWidth);
    expect(dark.rules['node']?.padding).toEqual(light.rules['node']?.padding);
    expect(dark.rules['node']?.fill).toBe('#171E2B');
    expect(dark.byShape['cylinder']?.fill).toBe('#10161F');
    expect(dark.canvas.background).toBe('#0E131C');
  });
});

describe('resolveTheme: token resolution (DD-04 §3 step 2)', () => {
  it('resolves a reference transitively', () => {
    const { value, diagnostics } = resolveTheme(
      theme({
        tokens: { a: '@b', b: '@c', c: '#123456' },
        rules: { node: { fill: '@a' } },
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(value.tokens['a']).toBe('#123456');
    expect(value.rules['node']?.fill).toBe('#123456');
  });

  it('reports an unknown token once and falls back loudly', () => {
    const { value, diagnostics } = resolveTheme(
      theme({ rules: { node: { fill: '@nope' } } }),
    );
    expect(codes(diagnostics)).toEqual(['SGL5005']);
    expect(diagnostics[0]?.message).toContain('nope');
    expect(value.rules['node']?.fill).toBe(COLOR_FALLBACK);
  });

  it('reports a token whose own target is unknown at its definition, not at every use', () => {
    const { value, diagnostics } = resolveTheme(
      theme({
        tokens: { brand: '@missing' },
        rules: { node: { fill: '@brand' }, container: { fill: '@brand' }, edge: { stroke: '@brand' } },
      }),
    );
    expect(codes(diagnostics)).toEqual(['SGL5005']);
    expect(value.rules['node']?.fill).toBe(COLOR_FALLBACK);
    expect(value.rules['edge']?.stroke).toBe(COLOR_FALLBACK);
  });

  it('breaks a token cycle with SGL5006 instead of recursing', () => {
    const { value, diagnostics } = resolveTheme(
      theme({ tokens: { a: '@b', b: '@a' }, rules: { node: { fill: '@a' } } }),
    );
    expect(codes(diagnostics)).toEqual(['SGL5006']);
    expect(diagnostics[0]?.message).toMatch(/a → b → a|b → a → b/);
    expect(value.rules['node']?.fill).toBe(COLOR_FALLBACK);
  });

  it('breaks a self-referential token', () => {
    const { diagnostics } = resolveTheme(theme({ tokens: { a: '@a' } }));
    expect(codes(diagnostics)).toEqual(['SGL5006']);
  });
});

describe('resolveTheme: inheritance (DD-04 §3 step 1)', () => {
  /** A chain `t0 extends t1 extends … extends t{n-1}`. */
  function chain(n: number): Readonly<Record<string, ThemeDoc>> {
    const all: Record<string, ThemeDoc> = {};
    for (let i = 0; i < n; i += 1) {
      all[`t${i}`] = theme({ id: `t${i}`, extends: i + 1 < n ? `t${i + 1}` : null });
    }
    return all;
  }

  it('follows a chain up to eight links', () => {
    const all = chain(9); // t0 … t8 — exactly eight `extends` hops.
    const { diagnostics } = resolveTheme(all['t0'] as ThemeDoc, (id) => all[id]);
    expect(diagnostics).toEqual([]);
  });

  it('stops with SGL5001 past eight', () => {
    const all = chain(12);
    const { diagnostics } = resolveTheme(all['t0'] as ThemeDoc, (id) => all[id]);
    expect(codes(diagnostics)).toEqual(['SGL5001']);
    expect(diagnostics[0]?.severity).toBe('error');
  });

  it('stops with SGL5002 on a cycle', () => {
    const all: Record<string, ThemeDoc> = {
      a: theme({ id: 'a', extends: 'b' }),
      b: theme({ id: 'b', extends: 'a' }),
    };
    const { diagnostics } = resolveTheme(all['a'] as ThemeDoc, (id) => all[id]);
    expect(codes(diagnostics)).toEqual(['SGL5002']);
    expect(diagnostics[0]?.message).toContain('a → b → a');
  });

  it('deep-merges rules so a child patching one property keeps the rest', () => {
    const parent = theme({ id: 'p', tokens: { ink: '#000000' }, rules: { node: { fill: '#FFFFFF', radius: 4, stroke: '@ink' } } });
    const child = theme({ id: 'c', extends: 'p', tokens: { ink: '#FF0000' }, rules: { node: { radius: 9 } } });
    const { value, diagnostics } = resolveTheme(child, (id) => (id === 'p' ? parent : undefined));
    expect(diagnostics).toEqual([]);
    expect(value.rules['node']).toEqual({ fill: '#FFFFFF', radius: 9, stroke: '#FF0000' });
  });
});

describe('resolveTheme: validation (DD-04 §3, §6)', () => {
  it('drops an unknown style property with SGL5003', () => {
    const { value, diagnostics } = resolveTheme(
      theme({ rules: { node: { fill: '#FFFFFF', glow: 3 } } }),
    );
    expect(codes(diagnostics)).toEqual(['SGL5003']);
    expect(diagnostics[0]?.message).toContain('glow');
    expect(value.rules['node']).toEqual({ fill: '#FFFFFF' });
  });

  it('drops a value that fails its registry type with SGL5004', () => {
    const { value, diagnostics } = resolveTheme(
      theme({ rules: { node: { fill: 12, strokeWidth: 'thick' }, edge: { arrowhead: 'wedge' } } }),
    );
    expect(codes(diagnostics)).toEqual(['SGL5004', 'SGL5004', 'SGL5004']);
    expect(value.rules['node']).toEqual({});
    expect(value.rules['edge']).toEqual({});
  });

  it('normalises the dash keywords and an explicit dash string', () => {
    const { value, diagnostics } = resolveTheme(
      theme({
        rules: {
          node: { strokeDash: 'dashed' },
          container: { strokeDash: 'dotted' },
          edge: { strokeDash: '4 2' },
        },
        byShape: { rect: { strokeDash: 'solid' } },
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(value.rules['node']?.strokeDash).toEqual(DASH_PATTERNS['dashed']);
    expect(value.rules['container']?.strokeDash).toEqual(DASH_PATTERNS['dotted']);
    expect(value.rules['edge']?.strokeDash).toEqual([4, 2]);
    expect(value.byShape['rect']?.strokeDash).toEqual([]);
  });

  it('accepts the one-, two- and four-value inset forms', () => {
    const { value, diagnostics } = resolveTheme(
      theme({
        rules: { node: { padding: 5 }, container: { padding: [1, 2] } },
        byShape: { rect: { padding: [1, 2, 3, 4] }, hexagon: { padding: [1, 2, 3] } },
      }),
    );
    expect(value.rules['node']?.padding).toEqual([5, 5, 5, 5]);
    expect(value.rules['container']?.padding).toEqual([1, 2, 1, 2]);
    expect(value.byShape['rect']?.padding).toEqual([1, 2, 3, 4]);
    // Three values is not one of the forms DD-04 §3 lists.
    expect(codes(diagnostics)).toEqual(['SGL5004']);
    expect(value.byShape['hexagon']).toEqual({});
  });

  it('never throws on a structurally broken document', () => {
    const broken = { id: 'broken', name: 'B', schemaVersion: 1, extends: null } as unknown as ThemeDoc;
    expect(() => resolveTheme(broken, BUILT_IN_LOOKUP)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// styleGraph — DD-04 §4, §5
// ---------------------------------------------------------------------------

describe('styleGraph: the cascade (DD-04 §4)', () => {
  const light = resolved(neutralLight);

  it('styles every node in `order`, every edge, and every label (containers-edges.sgl)', () => {
    const { graph } = corpusGraph('containers-edges.sgl');
    const { value, diagnostics } = styleGraph(graph, light);
    expect(diagnostics).toEqual([]);
    // Every node and every edge lands in the one `styles` record (DD-04 §5).
    expect(Object.keys(value.styles).sort()).toEqual(
      [...graph.order, ...graph.edges.map((e) => e.id)].sort(),
    );
    // Every node here gets an implicit title (no `@label: ""`); the edges carry
    // no `@label`, so `labelStyles` covers nodes only.
    const nodeLabels = graph.order.map((id) => graph.nodes[id]?.labelId).filter((l) => l !== null && l !== undefined);
    expect(Object.keys(value.labelStyles).sort()).toEqual([...nodeLabels].sort());
    expect(value.themeId).toBe('neutral-light');
    expect(value.canvas.background).toBe('#F7F8FA');
  });

  it('gives a node with children the container rule (step 1) (containers-edges.sgl)', () => {
    const { graph } = corpusGraph('containers-edges.sgl');
    const { value } = styleGraph(graph, light);
    expect(value.styles['alpha']?.geometry['radius']).toBe(10); // rules.container — alpha has children
    expect(value.styles['outside']?.geometry['radius']).toBe(6); // rules.node — a leaf
    expect(value.styles['alpha']?.geometry['titleGap']).toBe(6); // container-only property
    expect(value.styles['outside']?.geometry['titleGap']).toBeUndefined();
  });

  it('lets byShape beat the role default (step 2 over step 1) (shapes.sgl)', () => {
    const { graph } = corpusGraph('shapes.sgl');
    const { value } = styleGraph(graph, light);
    expect(value.styles['r']?.paint['fill']).toBe('#FFFFFF'); // rect: role default
    expect(value.styles['c']?.paint['fill']).toBe('#EEF1F5'); // cylinder: byShape.cylinder
  });

  it('lets a later class beat an earlier one (step 4)', () => {
    const classes: Record<string, ClassModel> = {
      A: { name: 'A', extends: [], config: { style: { fill: '#111111', stroke: '#AAAAAA' } } },
      B: { name: 'B', extends: [], config: { style: { fill: '#222222' } } },
    };
    const graph = fixture({ nodes: [node('n', { classes: ['A', 'B'] })] });
    const { value, diagnostics } = styleGraph(graph, light, classes);
    expect(diagnostics).toEqual([]);
    expect(value.styles['n']?.paint['fill']).toBe('#222222');
    expect(value.styles['n']?.paint['stroke']).toBe('#AAAAAA');
  });

  it('lets a theme class beat the shape default and a document class beat the theme class', () => {
    const themed = resolved({
      ...neutralLight,
      id: 'themed',
      byClass: { Critical: { fill: '#010101', stroke: '@danger' } },
    });
    const graph = fixture({ nodes: [node('n', { shape: 'cylinder', classes: ['Critical'] })] });

    const noDoc = styleGraph(graph, themed).value;
    expect(noDoc.styles['n']?.paint['fill']).toBe('#010101'); // step 3 over step 2
    expect(noDoc.styles['n']?.paint['stroke']).toBe('#A8323F'); // @danger, resolved

    const classes: Record<string, ClassModel> = {
      Critical: { name: 'Critical', extends: [], config: { style: { fill: '#020202' } } },
    };
    const withDoc = styleGraph(graph, themed, classes).value;
    expect(withDoc.styles['n']?.paint['fill']).toBe('#020202'); // step 4 over step 3
  });

  it('lets inline `@style` beat every class (step 5)', () => {
    const classes: Record<string, ClassModel> = {
      A: { name: 'A', extends: [], config: { style: { fill: '#111111' } } },
    };
    const config: ConfigBag = { style: { fill: '#333333' } };
    const graph = fixture({ nodes: [node('n', { classes: ['A'], config })] });
    const { value } = styleGraph(graph, light, classes);
    expect(value.styles['n']?.paint['fill']).toBe('#333333');
  });

  it('resolves an `@token` written in a document', () => {
    const classes: Record<string, ClassModel> = {
      Critical: { name: 'Critical', extends: [], config: { style: { stroke: '@danger' } } },
    };
    const graph = fixture({ nodes: [node('n', { classes: ['Critical'] })] });
    expect(styleGraph(graph, light, classes).value.styles['n']?.paint['stroke']).toBe('#A8323F');
    expect(styleGraph(graph, resolved(neutralDark), classes).value.styles['n']?.paint['stroke']).toBe('#E4737E');
  });

  it('applies inline `@size` (step 6)', () => {
    const config: ConfigBag = { size: { width: 200, minHeight: 48 } };
    const graph = fixture({ nodes: [node('n', { config })] });
    const { value, diagnostics } = styleGraph(graph, light, {});
    expect(diagnostics).toEqual([]);
    expect(value.styles['n']?.geometry['width']).toBe(200);
    expect(value.styles['n']?.geometry['minHeight']).toBe(48);
  });

  it('step 6 applies only the `@size` keys (SIZE_KEYS): a paint key under `@size` never paints (fix round 1, item 1)', () => {
    const config: ConfigBag = { size: { width: 200, fill: '#FF0000', stroke: '#00FF00' } };
    const graph = fixture({ nodes: [node('n', { config }), node('m')] });
    const { value } = styleGraph(graph, light, {});
    expect(value.styles['n']?.geometry['width']).toBe(200);
    expect(value.styles['n']?.paint).toEqual(value.styles['m']?.paint);
  });

  it('reports an unknown or mistyped inline property against the element span', () => {
    const config: ConfigBag = { style: { fill: 42, sparkle: true } };
    const graph = fixture({ nodes: [node('n', { config, span: { from: 10, to: 20 } })] });
    const { value, diagnostics } = styleGraph(graph, light);
    expect(codes(diagnostics)).toEqual(['SGL5004', 'SGL5003']);
    expect(diagnostics.every((d) => d.span.from === 10)).toBe(true);
    expect(value.styles['n']?.paint['fill']).toBe('#FFFFFF'); // the theme default survives
  });
});

// ---------------------------------------------------------------------------
// styleGraph — class cascade over the corpus (Stage D, 07 §5)
//
// classes.sgl (corpus/README.md: "inheritance diamond, override order, theme
// byClass") is a real document built for exactly this — steps 4 and 5 of the same
// cascade the block above tests with hand-built `ClassModel`s, run here through
// the real `resolve()`/`compile()` output instead.
// ---------------------------------------------------------------------------

describe('styleGraph: class cascade over the corpus (classes.sgl)', () => {
  const light = resolved(neutralLight);
  const { graph, classes } = corpusGraph('classes.sgl');
  const { value, diagnostics } = styleGraph(graph, light, classes);

  it('resolves the whole document with no diagnostics', () => {
    expect(diagnostics).toEqual([]);
  });

  it('gives a single-class node its class style plus the inherited base (plain: Base)', () => {
    expect(value.styles['plain']?.paint['stroke']).toBe('#8A96A8'); // theme default — Base sets none
    expect(value.styles['plain']?.geometry['strokeWidth']).toBe(1); // Base's own @style.strokeWidth
  });

  it('merges both branches of a diamond (diamond: Diamond extends [Left, Right])', () => {
    // linearizeClasses (DD-02 §4) puts both Left and Right ahead of Diamond itself,
    // so a property either branch sets survives even though neither branch is last.
    expect(value.styles['diamond']?.paint['fill']).toBe('#EEF1F5'); // Left: @surface.sunken
    expect(value.styles['diamond']?.paint['stroke']).toBe('#1F5F80'); // Right: @accent
    expect(value.styles['diamond']?.geometry['strokeWidth']).toBe(1); // Base, via either branch
  });

  it('lets a later class in `@type` beat an earlier one (both: [Diamond, Critical])', () => {
    expect(value.styles['both']?.paint['fill']).toBe('#EEF1F5'); // Diamond -> Left; Critical sets no fill
    expect(value.styles['both']?.paint['stroke']).toBe('#A8323F'); // Critical: @danger beats Diamond -> Right's @accent
    expect(value.styles['both']?.geometry['strokeWidth']).toBe(3); // Critical beats Base
  });

  it('lets inline `@style` beat every class (override: Critical + inline stroke)', () => {
    expect(value.styles['override']?.paint['stroke']).toBe('#123456'); // inline beats Critical's @danger
    expect(value.styles['override']?.geometry['strokeWidth']).toBe(3); // inline never touches strokeWidth
  });
});

describe('styleGraph: label text styles (DD-04 §4)', () => {
  const light = resolved(neutralLight);

  it('starts a label from rules.<role>.title / rules.edge.label (containers-edges.sgl, chains.sgl)', () => {
    const containers = styleGraph(corpusGraph('containers-edges.sgl').graph, light).value;
    expect(containers.labelStyles['l:outside']?.geometry['fontSize']).toBe(13); // node.title
    expect(containers.labelStyles['l:alpha']?.geometry['fontSize']).toBe(12); // container.title
    expect(containers.labelStyles['l:outside']?.paint['color']).toBe('#1B2330'); // @ink

    const { graph: chainsGraph } = corpusGraph('chains.sgl');
    const edgeLabelId = chainsGraph.labels[Object.keys(chainsGraph.labels)[0] as string]?.id;
    const chains = styleGraph(chainsGraph, light).value;
    expect(chains.labelStyles[edgeLabelId as string]?.geometry['fontSize']).toBe(11); // edge.label
    expect(chains.labelStyles[edgeLabelId as string]?.paint['color']).toBe('#5B6675'); // @ink.muted
  });

  it('routes inline text properties to the label and box properties to the box', () => {
    // No corpus document sets an inline `@style.fontSize` — a shape the corpus
    // does not contain.
    const config: ConfigBag = { style: { fontSize: 16, fill: '#ABCDEF' } };
    const graph = fixture({ nodes: [node('n', { config })] });
    const { value, diagnostics } = styleGraph(graph, light);
    expect(diagnostics).toEqual([]);
    expect(value.labelStyles['l:n']?.geometry['fontSize']).toBe(16);
    expect(value.labelStyles['l:n']?.paint['fill']).toBeUndefined();
    expect(value.styles['n']?.geometry['fontSize']).toBeUndefined();
    expect(value.styles['n']?.paint['fill']).toBe('#ABCDEF');
  });

  it('reports a bad inline property once, not once per bag', () => {
    const config: ConfigBag = { style: { nonsense: 1 } };
    const graph = fixture({ nodes: [node('n', { config })] });
    expect(codes(styleGraph(graph, light).diagnostics)).toEqual(['SGL5003']);
  });
});

// ---------------------------------------------------------------------------
// The hash partition — DD-04 §8, and MVP acceptance criterion 2
// ---------------------------------------------------------------------------

describe('styleGraph: the geometry/paint hash partition (DD-04 §8)', () => {
  const graph = corpusGraph('containers-edges.sgl').graph;
  const base = styleGraph(graph, resolved(neutralLight)).value;

  it('moves the paint hash only when a paint property changes', () => {
    const painted = styleGraph(graph, resolved(patchedLight('node', { fill: '#010203' }))).value;

    expect(painted.styles['outside']?.geometryHash).toBe(base.styles['outside']?.geometryHash);
    expect(painted.styles['outside']?.paintHash).not.toBe(base.styles['outside']?.paintHash);
    expect(painted.geometryHash).toBe(base.geometryHash);
    expect(painted.paintHash).not.toBe(base.paintHash);
  });

  it('moves both hashes when a geometry property changes', () => {
    const moved = styleGraph(graph, resolved(patchedLight('node', { strokeWidth: 4 }))).value;

    expect(moved.styles['outside']?.geometryHash).not.toBe(base.styles['outside']?.geometryHash);
    expect(moved.styles['outside']?.paintHash).not.toBe(base.styles['outside']?.paintHash);
    expect(moved.geometryHash).not.toBe(base.geometryHash);
    expect(moved.paintHash).not.toBe(base.paintHash);
  });

  it('notices a text geometry change, which no element bag carries', () => {
    // fontSize lives on the label, so a graph hash that only folded in element
    // hashes would silently skip the re-layout this needs.
    const bigger = styleGraph(graph, resolved(patchedLight('node.title', { fontSize: 24 }))).value;
    expect(bigger.labelStyles['l:outside']?.geometryHash)
      .not.toBe(base.labelStyles['l:outside']?.geometryHash);
    expect(bigger.geometryHash).not.toBe(base.geometryHash);
  });

  it('moves the graph paint hash when only canvas.background changes, with no element touched', () => {
    // The canvas has no ComputedStyle of its own — nothing in the per-element
    // loop ever sees `theme.canvas.background` — so this is the one property
    // that can only move `StyledGraph.paintHash` via the dedicated `canvas=...`
    // term `styleGraph` folds in after that loop (DD-04 §5). Isolating it here
    // (every rule, every token, every `byShape`/`byClass` entry held fixed)
    // proves that term is doing the work, not a coincidental element change.
    const repainted = styleGraph(graph, resolved(patchedCanvasBackground('#010203'))).value;

    expect(repainted.canvas.background).not.toBe(base.canvas.background);
    expect(repainted.paintHash).not.toBe(base.paintHash);
    expect(repainted.geometryHash).toBe(base.geometryHash);
    expect(JSON.stringify(repainted.styles)).toBe(JSON.stringify(base.styles));
    expect(JSON.stringify(repainted.labelStyles)).toBe(JSON.stringify(base.labelStyles));
  });

  it('puts every registry property in exactly one half', () => {
    for (const style of Object.values(base.styles)) {
      const overlap = Object.keys(style.geometry).filter((k) => k in style.paint);
      expect(overlap).toEqual([]);
    }
  });

  it('is deterministic across runs', () => {
    const again = styleGraph(corpusGraph('containers-edges.sgl').graph, resolved(neutralLight)).value;
    expect(again.geometryHash).toBe(base.geometryHash);
    expect(again.paintHash).toBe(base.paintHash);
    expect(JSON.stringify(again.styles)).toBe(JSON.stringify(base.styles));
  });
});

describe('a light/dark toggle re-runs paint only (MVP acceptance criterion 2)', () => {
  const graph = corpusGraph('containers-edges.sgl').graph;
  const light = styleGraph(graph, resolved(neutralLight)).value;
  const dark = styleGraph(graph, resolved(neutralDark)).value;

  it('gives neutral-dark the same geometry hash as neutral-light', () => {
    expect(dark.geometryHash).toBe(light.geometryHash);
  });

  it('gives every element and every label the same geometry hash', () => {
    for (const id of Object.keys(light.styles)) {
      expect(dark.styles[id]?.geometryHash, id).toBe(light.styles[id]?.geometryHash);
      expect(dark.styles[id]?.geometry, id).toEqual(light.styles[id]?.geometry);
    }
    for (const id of Object.keys(light.labelStyles)) {
      expect(dark.labelStyles[id]?.geometryHash, id).toBe(light.labelStyles[id]?.geometryHash);
    }
  });

  it('still changes the paint hash, or the toggle would not repaint', () => {
    expect(dark.paintHash).not.toBe(light.paintHash);
    expect(dark.canvas.background).not.toBe(light.canvas.background);
  });
});

// ---------------------------------------------------------------------------
// Contrast — DD-04 §7
// ---------------------------------------------------------------------------

describe('built-in theme contrast (DD-04 §7)', () => {
  const AA = 4.5;

  function channel(v: number): number {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }

  function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const r = Number.parseInt(h.slice(0, 2), 16);
    const g = Number.parseInt(h.slice(2, 4), 16);
    const b = Number.parseInt(h.slice(4, 6), 16);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  it('is a correct ratio implementation', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it.each(['neutral-light', 'neutral-dark'])('passes WCAG AA in %s', (id) => {
    const t = resolved(BUILT_IN[id] as ThemeDoc);
    const token = (name: string): string => String(t.tokens[name]);

    // The three pairs DD-04 §7 names. Read through the resolved theme, so a change
    // to a rule's colour source is caught as well as a change to a token.
    expect(contrast(token('ink'), token('surface')), 'ink / surface').toBeGreaterThanOrEqual(AA);
    expect(contrast(token('ink.muted'), token('surface')), 'ink.muted / surface').toBeGreaterThanOrEqual(AA);
    expect(
      contrast(String(t.rules['edge.label']?.color), t.canvas.background),
      'edge.label / bg',
    ).toBeGreaterThanOrEqual(AA);

    // The title colours are the ones actually painted, so assert on them too.
    expect(contrast(String(t.rules['node.title']?.color), String(t.rules['node']?.fill)))
      .toBeGreaterThanOrEqual(AA);
    expect(contrast(String(t.rules['container.title']?.color), String(t.rules['container']?.fill)))
      .toBeGreaterThanOrEqual(AA);
  });
});
