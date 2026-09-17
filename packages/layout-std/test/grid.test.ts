import type { LabelId, NodeId, Rect, SemanticGraph, Size } from '@sgl/core';
import {
  buildLayoutInput,
  placeLabels,
  quantize,
  routeStraight,
  validateResult,
  type LayoutContext,
  type LayoutInput,
  type LayoutResult,
  type ResolvedThemeMetricsView,
  type StyledGraphInput,
} from '@sgl/layout-api';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import type { StyledGraph } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { corpusStyledGraph, listCorpusDocs } from '../../theme/test/corpus.js';
import { gridEngine } from '../src/grid.js';

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

const CTX: LayoutContext = {
  options: {},
  metrics: METRICS,
  measure: {
    layoutRuns(): never {
      throw new Error('grid never asks the host to measure a label it created.');
    },
  },
  random: () => 0,
  signal: new AbortController().signal,
  log: () => {},
  sublayout(): never {
    throw new Error('sublayout is reserved, not implemented (DD-06 §2).');
  },
};

/** `parse -> resolve -> compile -> resolveTheme -> styleGraph -> premeasure ->
 *  buildLayoutInput` over a corpus document, using the deterministic
 *  `StaticMetricsMeasurer` so this runs under Node exactly like CI. */
function layoutInputFor(name: string): { readonly styled: StyledGraph; readonly input: LayoutInput } {
  const { styled } = corpusStyledGraph(name);
  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  const input = buildLayoutInput(styled as StyledGraphInput, labelSizes);
  return { styled, input };
}

/** The full host pipeline over one `LayoutInput`, matching what a real caller
 *  would run for an engine declaring `labelPlacement: false, edgeRouting:
 *  'straight'` (DD-06 §4, §5). */
async function runPipeline(input: LayoutInput): Promise<LayoutResult> {
  const raw = await gridEngine.layout(input, CTX);
  const routed = routeStraight(input, raw, METRICS);
  const labelled = placeLabels(input, routed, METRICS);
  return quantize(labelled, 64);
}

/** Every corpus document `compile()` handles cleanly — no error diagnostics — kept
 *  in step with `packages/core/test/compile.test.ts`'s own `CLEAN_DOCS` (not
 *  exported from there, so duplicated; a drift between the two just means this
 *  suite golden-tests a document compile() no longer considers clean, which
 *  `corpusStyledGraph`'s own diagnostics would already have surfaced elsewhere). */
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
];

const DOCS = listCorpusDocs();

/** DD-06 §8 conformance item 3: no two *sibling leaf* frames overlap (a container
 *  enclosing its own descendants is not an overlap in this sense). Checked at
 *  every level, including root, whose "siblings" are `graph.rootChildren`. */
function siblingLeafOverlaps(graph: SemanticGraph, result: LayoutResult): readonly (readonly [NodeId, NodeId])[] {
  const violations: (readonly [NodeId, NodeId])[] = [];
  const EPS = 1e-6;
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x + EPS < b.x + b.w && b.x + EPS < a.x + a.w && a.y + EPS < b.y + b.h && b.y + EPS < a.y + a.h;

  const checkSiblings = (childIds: readonly NodeId[]): void => {
    const leaves = childIds.filter((id) => {
      const node = graph.nodes[id];
      return node !== undefined && !node.hidden && node.children.length === 0;
    });
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        const a = result.nodes[leaves[i]!];
        const b = result.nodes[leaves[j]!];
        if (a !== undefined && b !== undefined && overlaps(a.frame, b.frame)) {
          violations.push([leaves[i]!, leaves[j]!]);
        }
      }
    }
  };

  checkSiblings(graph.rootChildren);
  for (const id of graph.order) {
    const node = graph.nodes[id];
    if (node !== undefined && !node.hidden && node.children.length > 0) checkSiblings(node.children);
  }
  return violations;
}

describe('grid engine over the corpus (DD-06 §7, T2 gate)', () => {
  it('has at least the documents this suite assumes', () => {
    expect(DOCS).toContain('empty.sgl');
    expect(DOCS).toContain('hidden.sgl');
    expect(DOCS).toContain('parallel-selfloop.sgl');
    expect(DOCS).toContain('nesting-3.sgl');
  });

  for (const doc of DOCS) {
    it(`${doc}: lays out with no layout diagnostics at all (errors or warnings)`, async () => {
      const { input } = layoutInputFor(doc);
      const result = await runPipeline(input);
      const diagnostics = validateResult(result, input.graph, gridEngine.id);
      expect(diagnostics).toEqual([]);
    });

    it(`${doc}: bitwise-identical across two runs (ADR-0004, DD-00 §6 exit criterion)`, async () => {
      const { input } = layoutInputFor(doc);
      const a = await runPipeline(input);
      const b = await runPipeline(input);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it(`${doc}: no two sibling leaf frames overlap (DD-06 §8, conformance item 3)`, async () => {
      const { input } = layoutInputFor(doc);
      const result = await runPipeline(input);
      expect(siblingLeafOverlaps(input.graph, result)).toEqual([]);
    });
  }

  for (const doc of CLEAN_DOCS) {
    it(`${doc}: layout golden`, async () => {
      const { input } = layoutInputFor(doc);
      const result = await runPipeline(input);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/grid/${doc}.json`);
    });
  }

  it('F1: a hidden node is excluded from the layout, not just from `order`', async () => {
    const { input } = layoutInputFor('hidden.sgl');
    const result = await gridEngine.layout(input, CTX);
    const ghost = Object.keys(input.graph.nodes).find((id) => input.graph.nodes[id as never]?.hidden === true);
    expect(ghost).toBeDefined();
    expect(result.nodes[ghost as never]).toBeUndefined();
    // And every visible sibling still got a frame.
    for (const id of input.graph.order) expect(result.nodes[id]).toBeDefined();
  });

  it('self-loops route to a multi-segment teardrop, not a degenerate point (DD-06 §4.5)', async () => {
    const { input } = layoutInputFor('parallel-selfloop.sgl');
    const result = await runPipeline(input);
    const selfLoopEdges = input.graph.edges.filter((e) => e.from.node === e.to.node && !e.hidden);
    expect(selfLoopEdges.length).toBeGreaterThan(0);
    for (const edge of selfLoopEdges) {
      const layout = result.edges[edge.id];
      expect(layout).toBeDefined();
      expect(layout!.route.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('nested containers (nesting-3.sgl) pack children inside their content frame', async () => {
    const { input } = layoutInputFor('nesting-3.sgl');
    const result = await gridEngine.layout(input, CTX);
    for (const id of input.graph.order) {
      const node = input.graph.nodes[id];
      if (node === undefined || node.hidden || node.children.length === 0) continue;
      const parentLayout = result.nodes[id]!;
      expect(parentLayout.contentFrame).toBeDefined();
      const content = parentLayout.contentFrame!;
      for (const childId of node.children) {
        if (input.graph.nodes[childId]?.hidden) continue;
        const child = result.nodes[childId];
        if (child === undefined) continue;
        expect(child.frame.x).toBeGreaterThanOrEqual(content.x - 0.001);
        expect(child.frame.y).toBeGreaterThanOrEqual(content.y - 0.001);
        expect(child.frame.x + child.frame.w).toBeLessThanOrEqual(content.x + content.w + 0.001);
        expect(child.frame.y + child.frame.h).toBeLessThanOrEqual(content.y + content.h + 0.001);
      }
    }
  });

  it('an empty document lays out to a well-formed, empty result', async () => {
    const { input } = layoutInputFor('empty.sgl');
    const result = await gridEngine.layout(input, CTX);
    expect(result.nodes).toEqual({});
    expect(result.edges).toEqual({});
    expect(Number.isFinite(result.bounds.w)).toBe(true);
    expect(Number.isFinite(result.bounds.h)).toBe(true);
  });
});
