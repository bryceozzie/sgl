import { describe, expect, it, vi } from 'vitest';
import { CanvasMeasurer, type BoxConstraints, type StyledRun, type TextLayout } from '@sgl/measure';
import '../src/fonts.css';
import { createHarness } from './harness.js';

/**
 * Fix round 1, item 4: the font gate (DD-11 T28) holds **before measuring**,
 * not merely by the time the picture is painted — painting loads the faces
 * anyway, so a "faces loaded" check after the fact proves nothing. Each run
 * the pre-measure lays out must find its own face already loaded. A file of
 * its own, so the page's `document.fonts` starts with no run face loaded.
 */

const face = (s: StyledRun['style']): string => `${s.fontFamily.replace(/'/g, '').split(',')[0]!.trim()} ${s.fontStyle} ${s.fontWeight}`;

describe('the font gate before the pre-measure (DD-11 T28)', () => {
  it('every run face is loaded when the pre-measure measures the runs that use it', async () => {
    const seen: { readonly face: string; readonly loaded: boolean }[] = [];
    const measurer = new (class extends CanvasMeasurer {
      layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout {
        for (const r of runs) {
          const f = face(r.style);
          const loaded = [...document.fonts].some((ff) => `${ff.family.replace(/"/g, '')} ${ff.style} ${ff.weight}` === f && ff.status === 'loaded');
          seen.push({ face: f, loaded });
        }
        return super.layoutRuns(runs, box);
      }
    })();
    const h = await createHarness('a: "*Italic* title"\nb: "**Bold** `code`"\na -> b: "*async*"\n', { measurer, loadRichText: async () => (await import('../src/state/rich-text.js')).richText }, { firstRender: false });
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.pipeline.lastGood.value).not.toBeNull();
    }, { timeout: 10_000, interval: 50 });
    const faces = new Set(seen.map((s) => s.face));
    for (const f of ['Inter italic 500', 'Inter italic 400', 'Inter normal 700', 'IBM Plex Mono normal 400']) expect(faces, f).toContain(f);
    expect(seen.filter((s) => !s.loaded)).toEqual([]);
    h.dispose();
  });
});
