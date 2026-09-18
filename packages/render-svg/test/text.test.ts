import type { ComputedStyle } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import type { LabelPlacementView, TextLayoutView } from '../src/layout-view.js';
import { renderText, textBlock } from '../src/text.js';

function style(geometry: Readonly<Record<string, number>> = {}): ComputedStyle {
  return {
    paint: {},
    geometry,
    paintHash: 'p',
    geometryHash: 'g',
  } as ComputedStyle;
}

function placement(overrides: Partial<LabelPlacementView> = {}): LabelPlacementView {
  return {
    labelId: 'l:x',
    frame: { x: 10, y: 20, w: 100, h: 30 },
    align: 'start',
    baseline: 'top',
    ...overrides,
  };
}

describe('textBlock()', () => {
  it('returns the supplied block untouched when given one', () => {
    const supplied: TextLayoutView = { width: 5, height: 6, lines: [], ascent: 1 };
    expect(textBlock(['a'], style(), supplied)).toBe(supplied);
  });

  it('reconstructs line y-positions from fontSize x lineHeight alone', () => {
    const block = textBlock(['one', 'two', 'three'], style({ fontSize: 10, lineHeight: 1.5 }));
    // ascent = fontSize * 0.8; line i's y = ascent + i * fontSize * lineHeight.
    expect(block.ascent).toBeCloseTo(8, 9);
    expect(block.lines.map((l) => l.y)).toEqual([8, 23, 38]);
  });

  it('height is lines.length * fontSize * lineHeight, at least one line tall', () => {
    expect(textBlock([], style({ fontSize: 10, lineHeight: 1.5 })).height).toBeCloseTo(15, 9);
    expect(textBlock(['a'], style({ fontSize: 10, lineHeight: 1.5 })).height).toBeCloseTo(15, 9);
    expect(textBlock(['a', 'b'], style({ fontSize: 10, lineHeight: 1.5 })).height).toBeCloseTo(30, 9);
  });

  it('falls back to defaults when the style has no fontSize/lineHeight', () => {
    const block = textBlock(['a'], style());
    expect(block.ascent).toBeCloseTo(13 * 0.8, 9);
  });
});

describe('renderText()', () => {
  it('empty block renders nothing', () => {
    expect(renderText(placement(), { width: 0, height: 0, lines: [], ascent: 0 }, 't-1', 'n-title', true)).toBe('');
  });

  it('y is frame.y + block.ascent', () => {
    const block = textBlock(['hi'], style({ fontSize: 10 }));
    const svg = renderText(placement({ frame: { x: 0, y: 100, w: 50, h: 20 } }), block, 't-1', 'n-title', true);
    const y = Number(/ y="([\d.-]+)"/.exec(svg)?.[1]);
    expect(y).toBeCloseTo(100 + block.ascent, 6);
  });

  it('the first tspan has dy=0 and each later one has dy = its line y minus the previous line y', () => {
    const block = textBlock(['a', 'b', 'c'], style({ fontSize: 10, lineHeight: 1.2 }));
    const svg = renderText(placement(), block, 't-1', 'n-title', true);
    const dys = [...svg.matchAll(/dy="([\d.-]+)"/g)].map((m) => Number(m[1]));
    expect(dys[0]).toBe(0);
    expect(dys[1]).toBeCloseTo(block.lines[1]!.y - block.lines[0]!.y, 9);
    expect(dys[2]).toBeCloseTo(block.lines[2]!.y - block.lines[1]!.y, 9);
  });

  it('x follows text-anchor: start -> left, middle -> centre, end -> right', () => {
    const block = textBlock(['hi'], style());
    const frame = { x: 10, y: 0, w: 100, h: 20 };
    const xOf = (align: LabelPlacementView['align']): number =>
      Number(/ x="([\d.-]+)"/.exec(renderText(placement({ frame, align }), block, 't', 'n', true))?.[1]);
    expect(xOf('start')).toBe(10);
    expect(xOf('middle')).toBe(60);
    expect(xOf('end')).toBe(110);
  });

  it('rotation adds a transform="rotate(deg cx cy)" about the frame centre', () => {
    const block = textBlock(['hi'], style());
    const frame = { x: 0, y: 0, w: 40, h: 20 };
    const svg = renderText(placement({ frame, rotation: 45 }), block, 't', 'n', true);
    expect(svg).toContain('transform="rotate(45 20 10)"');
  });

  it('rotation of exactly 0 omits the transform', () => {
    const block = textBlock(['hi'], style());
    const svg = renderText(placement({ rotation: 0 }), block, 't', 'n', true);
    expect(svg).not.toContain('transform=');
  });

  it('aria-hidden is present only when requested', () => {
    const block = textBlock(['hi'], style());
    expect(renderText(placement(), block, 't', 'n', true)).toContain('aria-hidden="true"');
    expect(renderText(placement(), block, 't', 'n', false)).not.toContain('aria-hidden');
  });

  it('escapes text content and preserves leading whitespace via xml:space', () => {
    const block = textBlock(['<b>&"\''], style());
    const svg = renderText(placement(), block, 't', 'n', true);
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;&amp;&quot;&apos;');
  });

  it('the class attribute joins extraClass and className, dropping empties', () => {
    const block = textBlock(['hi'], style());
    expect(renderText(placement(), block, '', 'n-title', true)).toContain('class="n-title"');
    expect(renderText(placement(), block, 't-1', 'n-title', true)).toContain('class="n-title t-1"');
  });
});
