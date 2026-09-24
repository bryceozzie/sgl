import { afterEach, describe, expect, it, vi } from 'vitest';
import { asNodeId } from '@sgl/core';
import { render } from '@sgl/render-svg';
import { createHarness, type Harness } from './harness.js';

/** Every pre-measure the pipeline makes, counted at the module boundary. */
const counts = vi.hoisted(() => ({ premeasure: 0 }));
vi.mock('@sgl/measure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sgl/measure')>();
  return {
    ...actual,
    premeasure: (...args: Parameters<typeof actual.premeasure>) => {
      counts.premeasure += 1;
      return actual.premeasure(...args);
    },
  };
});

/**
 * Fix round 1, item 1 (a blocker found on `main`): the layout effect skipped
 * a layout whenever `geometryHash`, the engine and its options were
 * unchanged, but a label's text — and so its measured size, which is part of
 * the `LayoutInput` — is in none of those. Editing `a: "short"` into a long
 * label laid nothing out again, and the box stayed its old size around the
 * new text. The skip must follow everything the `LayoutInput` is built from.
 * And the measure skip (F9) must follow the graph, not only its geometry.
 */

let open: Harness[] = [];
afterEach(() => {
  for (const h of open) h.dispose();
  open = [];
});
async function harness(source: string): Promise<Harness> {
  const h = await createHarness(source);
  open.push(h);
  return h;
}

const frameOf = (h: Harness, id: string) => h.pipeline.lastGood.value!.layout.nodes[asNodeId(id)]!.frame;

describe('a label text edit lays out again (fix round 1, item 1)', () => {
  it('a: "short" → a long label: a new layout request, and the box grows to the new text', async () => {
    const h = await harness('a: "short"\n');
    const before = { requests: h.layoutRequests(), w: frameOf(h, 'a').w, geometryHash: h.pipeline.styled.value.value.geometryHash };
    h.setSource('a: "a much much much longer label text here"\n');
    await h.settle();
    expect(h.pipeline.styled.value.value.geometryHash).toBe(before.geometryHash); // the old skip's only key: unchanged
    expect(h.layoutRequests() - before.requests).toBe(1);
    expect(frameOf(h, 'a').w).toBeGreaterThan(before.w + 100);
    // What is on screen, saved and stored is drawn with the new frame.
    expect(h.pipeline.lastGood.value!.svg).toContain('a much much much longer label text here');
    expect(h.pipeline.lastGood.value!.layout).toBe(h.pipeline.layout.value);
  });

  it('a container title edit re-lays out its children around the new title', async () => {
    const h = await harness('g: { @label: "G", x: "x" }\n');
    const before = h.layoutRequests();
    const y = frameOf(h, 'g.x').y;
    h.setSource('g: { @label: "G\\nsecond line\\nthird line", x: "x" }\n');
    await h.settle();
    expect(h.layoutRequests() - before).toBe(1);
    expect(frameOf(h, 'g.x').y).toBeGreaterThan(y);
  });

  it('an edit that only moves source positions (a blank line) keeps the layout: spans place nothing', async () => {
    const h = await harness('a: "short"\nb: "other"\n');
    const before = h.layoutRequests();
    const layout = h.pipeline.layout.value;
    h.setSource('a: "short"\n\nb: "other"\n');
    await h.settle();
    expect(h.layoutRequests()).toBe(before);
    expect(h.pipeline.layout.value).toBe(layout);
  });

  it('…unless the landed layout reported diagnostics, whose spans would go stale: then it lays out again', async () => {
    const h = await harness('a: "short"\nb: "other"\n');
    h.pipeline.layoutDiags.value = [{ code: 'SGL4003', severity: 'warning', message: 'test', span: { from: 11, to: 12 } }];
    const before = h.layoutRequests();
    h.setSource('a: "short"\n\nb: "other"\n');
    await h.settle();
    expect(h.layoutRequests() - before).toBe(1);
  });

  it('a theme switch between themes of equal geometry still skips layout (the input is the same)', async () => {
    const h = await harness('a: "short"\nb: "other"\na -> b\n');
    const before = h.layoutRequests();
    const layout = h.pipeline.layout.value;
    h.pipeline.themeId.value = 'neutral-dark';
    await h.settle();
    expect(h.layoutRequests()).toBe(before);
    expect(h.pipeline.layout.value).toBe(layout);
  });
});

describe('the paint-only path never keeps a stale layout (fix round 1, item 1)', () => {
  it('a text edit, then a theme switch before its layout lands: the switch may restyle the old frames, and the new layout still lands after it', async () => {
    const h = await harness('a: "short"\n');
    const w = frameOf(h, 'a').w;
    h.setSource('a: "a much much much longer label text here"\n');
    h.pipeline.themeId.value = 'neutral-dark'; // before the debounce: the same (not yet current) layout object
    await h.settle();
    const good = h.pipeline.lastGood.value!;
    expect(good.styled.themeId).toBe('neutral-dark');
    expect(frameOf(h, 'a').w).toBeGreaterThan(w + 100);
    expect(good.layout).toBe(h.pipeline.layout.value);
    expect(good.svg).toBe(render(good.styled, good.layout, h.pipeline.theme.value.value).svg);
  });
});

describe('the measure skip follows the graph, not only its geometry (fix round 1, item 2)', () => {
  it('a text edit with the same geometryHash still pre-measures', async () => {
    const h = await harness('a: "short"\n');
    const hash = h.pipeline.styled.value.value.geometryHash;
    const before = counts.premeasure;
    h.setSource('a: "longer text"\n');
    await h.settle();
    expect(h.pipeline.styled.value.value.geometryHash).toBe(hash);
    expect(counts.premeasure - before).toBe(1);
  });

  it('a theme switch of equal geometry does not', async () => {
    const h = await harness('a: "short"\n');
    const before = counts.premeasure;
    h.pipeline.themeId.value = 'neutral-dark';
    await h.settle();
    expect(counts.premeasure - before).toBe(0);
  });
});

