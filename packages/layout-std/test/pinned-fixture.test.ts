import { describe, expect, it } from 'vitest';
import { gridPins, pinnedSource } from '../../../bench/pinned-fixture.js';
import { layoutInputFor, METRICS } from '../../layout-elk/test/corpus-input.js';
import { conformanceContext, runHostSequence } from '@sgl/layout-api/conformance';
import { corpusSource } from '../../theme/test/corpus.js';
import { fixedEngine } from '../src/fixed.js';
import { gridEngine } from '../src/grid.js';

/**
 * `corpus/layout/forty-three-pinned.sgl` (DD-12 §12 item 5) is committed, and
 * generated once by `bench/generate-pinned-fixture.js` from
 * `forty-three-level.sgl`'s `grid` layout. This checks it has not drifted from
 * either, and that it is what the criterion-1 case needs: every node pinned,
 * so `fixed` lays it out with no diagnostic.
 */
describe('forty-three-pinned.sgl (DD-12 §12 item 5)', () => {
  it('is forty-three-level.sgl with the pins of its grid layout', async () => {
    const input = layoutInputFor('forty-three-level.sgl');
    const grid = await gridEngine.layout(input, conformanceContext({}, METRICS));
    const expected = pinnedSource(corpusSource('forty-three-level.sgl'), gridPins(input, grid));
    expect(corpusSource('layout/forty-three-pinned.sgl')).toBe(expected);
  });

  it('pins all 40 nodes, so fixed places every one where grid did (to the pixel) and notes nothing', async () => {
    const pinned = layoutInputFor('layout/forty-three-pinned.sgl');
    expect(pinned.graph.order).toHaveLength(40);
    for (const id of pinned.graph.order) expect(pinned.graph.nodes[id]!.config['pin'], id).toBeDefined();
    const { raw } = await runHostSequence(fixedEngine, pinned, {}, METRICS);
    expect(raw.notes ?? []).toEqual([]);

    const grid = await gridEngine.layout(layoutInputFor('forty-three-level.sgl'), conformanceContext({}, METRICS));
    for (const id of pinned.graph.order) {
      const f = raw.nodes[id]!.frame;
      const g = grid.nodes[id]!.frame;
      expect(Math.abs(f.x - g.x), id).toBeLessThanOrEqual(1.5);
      expect(Math.abs(f.y - g.y), id).toBeLessThanOrEqual(1.5);
    }
  });
});
