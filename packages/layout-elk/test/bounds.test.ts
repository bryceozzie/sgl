import { runHostSequence } from '@sgl/layout-api/conformance';
import { describe, expect, it } from 'vitest';
import { margins } from '../../layout-api/test/margin.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { elkEngine } from '../src/index.js';
import { layoutInputFor, METRICS } from './corpus-input.js';

/**
 * Fix round 1, item 5: DD-06 §5's host-computed bounds through the real host
 * sequence (`runHostSequence`: `elk` -> `applyHostFallbacks` -> `quantize`)
 * over the whole corpus. `bounds` starts at the origin and the margin between
 * it and what is drawn is exactly 16 px on every side (up to the 1/64 grid's
 * outward rounding and the sampling of curves), never ELK's own 12 px root
 * padding. The margin is measured by an independent sampler, not `bounds.ts`.
 */
describe('elk: host-computed bounds on the real host path (DD-06 §5)', () => {
  for (const doc of listCorpusDocs()) {
    it(`${doc}: bounds at the origin, a 16 px margin on each side`, async () => {
      const { result } = await runHostSequence(elkEngine, layoutInputFor(doc), {}, METRICS);
      expect({ x: result.bounds.x, y: result.bounds.y }).toEqual({ x: 0, y: 0 });
      const m = margins(result);
      if (m === null) {
        expect(result.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
        return;
      }
      for (const [side, v] of Object.entries(m)) {
        expect(v, side).toBeGreaterThanOrEqual(16 - 1e-9);
        expect(v, side).toBeLessThanOrEqual(16 + 0.05);
      }
    }, 30_000);
  }
});
