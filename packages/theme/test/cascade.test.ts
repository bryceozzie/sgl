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

// ---------------------------------------------------------------------------
// Fixtures
//
// The graph is built by hand rather than through parse/resolve/compile: DD-04 is
// the only stage under test here, and depending on three unbuilt stages to reach
// it would make every one of their bugs look like a cascade bug.
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

  it('styles every node in `order`, every edge, and every label', () => {
    const { value, diagnostics } = styleGraph(fixture(), light);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(value.styles).sort()).toEqual(['db', 'e-1', 'group', 'group.api']);
    expect(Object.keys(value.labelStyles).sort()).toEqual(['l:db', 'l:e-1', 'l:group', 'l:group.api']);
    expect(value.themeId).toBe('neutral-light');
    expect(value.canvas.background).toBe('#F7F8FA');
  });

  it('gives a node with children the container rule (step 1)', () => {
    const { value } = styleGraph(fixture(), light);
    expect(value.styles['group']?.geometry['radius']).toBe(10); // rules.container
    expect(value.styles['group.api']?.geometry['radius']).toBe(6); // rules.node
    expect(value.styles['group']?.geometry['titleGap']).toBe(6); // container-only property
    expect(value.styles['group.api']?.geometry['titleGap']).toBeUndefined();
  });

  it('lets byShape beat the role default (step 2 over step 1)', () => {
    const { value } = styleGraph(fixture(), light);
    expect(value.styles['group.api']?.paint['fill']).toBe('#FFFFFF'); // @surface
    expect(value.styles['db']?.paint['fill']).toBe('#EEF1F5'); // byShape.cylinder
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

  it('reports an unknown or mistyped inline property against the element span', () => {
    const config: ConfigBag = { style: { fill: 42, sparkle: true } };
    const graph = fixture({ nodes: [node('n', { config, span: { from: 10, to: 20 } })] });
    const { value, diagnostics } = styleGraph(graph, light);
    expect(codes(diagnostics)).toEqual(['SGL5004', 'SGL5003']);
    expect(diagnostics.every((d) => d.span.from === 10)).toBe(true);
    expect(value.styles['n']?.paint['fill']).toBe('#FFFFFF'); // the theme default survives
  });
});

describe('styleGraph: label text styles (DD-04 §4)', () => {
  const light = resolved(neutralLight);

  it('starts a label from rules.<role>.title / rules.edge.label', () => {
    const { value } = styleGraph(fixture(), light);
    expect(value.labelStyles['l:group.api']?.geometry['fontSize']).toBe(13); // node.title
    expect(value.labelStyles['l:group']?.geometry['fontSize']).toBe(12); // container.title
    expect(value.labelStyles['l:e-1']?.geometry['fontSize']).toBe(11); // edge.label
    expect(value.labelStyles['l:group.api']?.paint['color']).toBe('#1B2330'); // @ink
    expect(value.labelStyles['l:e-1']?.paint['color']).toBe('#5B6675'); // @ink.muted
  });

  it('routes inline text properties to the label and box properties to the box', () => {
    // DD-04 §4: `@style.fontSize: 16` on a node applies to its title; `@style.fill` does not.
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
  const graph = fixture();
  const base = styleGraph(graph, resolved(neutralLight)).value;

  it('moves the paint hash only when a paint property changes', () => {
    const painted = styleGraph(graph, resolved(patchedLight('node', { fill: '#010203' }))).value;

    expect(painted.styles['group.api']?.geometryHash).toBe(base.styles['group.api']?.geometryHash);
    expect(painted.styles['group.api']?.paintHash).not.toBe(base.styles['group.api']?.paintHash);
    expect(painted.geometryHash).toBe(base.geometryHash);
    expect(painted.paintHash).not.toBe(base.paintHash);
  });

  it('moves both hashes when a geometry property changes', () => {
    const moved = styleGraph(graph, resolved(patchedLight('node', { strokeWidth: 4 }))).value;

    expect(moved.styles['group.api']?.geometryHash).not.toBe(base.styles['group.api']?.geometryHash);
    expect(moved.styles['group.api']?.paintHash).not.toBe(base.styles['group.api']?.paintHash);
    expect(moved.geometryHash).not.toBe(base.geometryHash);
    expect(moved.paintHash).not.toBe(base.paintHash);
  });

  it('notices a text geometry change, which no element bag carries', () => {
    // fontSize lives on the label, so a graph hash that only folded in element
    // hashes would silently skip the re-layout this needs.
    const bigger = styleGraph(graph, resolved(patchedLight('node.title', { fontSize: 24 }))).value;
    expect(bigger.labelStyles['l:group.api']?.geometryHash)
      .not.toBe(base.labelStyles['l:group.api']?.geometryHash);
    expect(bigger.geometryHash).not.toBe(base.geometryHash);
  });

  it('puts every registry property in exactly one half', () => {
    for (const style of Object.values(base.styles)) {
      const overlap = Object.keys(style.geometry).filter((k) => k in style.paint);
      expect(overlap).toEqual([]);
    }
  });

  it('is deterministic across runs', () => {
    const again = styleGraph(fixture(), resolved(neutralLight)).value;
    expect(again.geometryHash).toBe(base.geometryHash);
    expect(again.paintHash).toBe(base.paintHash);
    expect(JSON.stringify(again.styles)).toBe(JSON.stringify(base.styles));
  });
});

describe('a light/dark toggle re-runs paint only (MVP acceptance criterion 2)', () => {
  const graph = fixture();
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
