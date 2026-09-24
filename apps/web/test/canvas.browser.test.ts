import { signal } from '@preact/signals';
import { h, render as mount } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@sgl/render-svg';
import { Canvas } from '../src/canvas/Canvas.js';
import { createHarness, type Harness } from './harness.js';

/**
 * The real `Canvas` around the real pipeline, in a real DOM (fix round 1,
 * item 2): after a paint-only switch the wrapper's attributes say which
 * render is on screen, and the stored boot picture (J6) is never mistaken for
 * the tree a paint-only render can be swapped into.
 */

const DOC = 'a: { @label: "A" }\nb: { @shape: round, @label: "B" }\na -> b: "ab"\n';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  document.body.replaceChildren();
});

async function mountCanvas(source: string): Promise<{ readonly h: Harness; readonly wrapper: SVGGElement; readonly stored: ReturnType<typeof signal<string | undefined>> }> {
  const harness = await createHarness(source);
  const stored = signal<string | undefined>(undefined);
  const root = document.createElement('div');
  root.style.cssText = 'width:800px;height:600px;';
  document.body.append(root);
  mount(h(Canvas, { pipeline: harness.pipeline, storedSvg: stored }), root);
  cleanup.push(() => {
    mount(null, root);
    harness.dispose();
  });
  const wrapper = root.querySelector<SVGGElement>('g.rendered')!;
  await expect.poll(() => wrapper.getAttribute('data-origin')).toBe('live');
  return { h: harness, wrapper, stored };
}

/** The DOM a full render of what the pipeline holds gives. */
function fullDom(harness: Harness): string {
  const good = harness.pipeline.lastGood.peek()!;
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.innerHTML = render(good.styled, good.layout, harness.pipeline.theme.peek().value).svg;
  return g.innerHTML;
}

describe('the canvas after a paint-only switch (fix round 1, item 2)', () => {
  it('swaps the <style> text into the same elements, and stamps data-theme, data-origin and, after the frame, data-paint-hash', async () => {
    const { h: harness, wrapper } = await mountCanvas(DOC);
    const node = wrapper.querySelector('g.L-nodes > g.n')!;
    harness.pipeline.themeId.value = 'neutral-dark';
    await harness.settle();
    expect(wrapper.querySelector('g.L-nodes > g.n')).toBe(node); // not replaced: swapped
    expect(wrapper.innerHTML).toBe(fullDom(harness));
    expect(wrapper.getAttribute('data-theme')).toBe('neutral-dark');
    expect(wrapper.getAttribute('data-origin')).toBe('live');
    await expect.poll(() => wrapper.getAttribute('data-paint-hash')).toBe(harness.pipeline.lastGood.peek()!.styled.paintHash);
  });

  it('after the stored picture (J6) was shown, a render of the plan that was on screen before is put back whole, not swapped into the stored tree', async () => {
    const { h: harness, wrapper, stored } = await mountCanvas(DOC);
    const live = harness.pipeline.lastGood.peek()!;
    // A document switch: lastGood cleared, the stored picture painted.
    stored.value = render(live.styled, live.layout, harness.pipeline.theme.peek().value).svg.replace('>A<', '>STORED<');
    harness.pipeline.lastGood.value = null;
    expect(wrapper.getAttribute('data-origin')).toBe('stored');
    expect(wrapper.innerHTML).toContain('STORED');
    // The same live render again (its plan is the one shown before the stored picture).
    harness.pipeline.lastGood.value = live;
    expect(wrapper.getAttribute('data-origin')).toBe('live');
    expect(wrapper.innerHTML).not.toContain('STORED');
    expect(wrapper.innerHTML).toBe(fullDom(harness));
  });
});
