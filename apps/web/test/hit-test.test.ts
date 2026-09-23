import { describe, expect, it } from 'vitest';
import { asNodeId } from '@sgl/core';
import type { LayoutResult } from '@sgl/layout-api';
import { hitTestNode } from '../src/canvas/hit-test.js';

function layout(nodes: Record<string, { x: number; y: number; w: number; h: number }>): LayoutResult {
  const out: LayoutResult['nodes'] = {};
  for (const [id, frame] of Object.entries(nodes)) out[asNodeId(id)] = { frame };
  return { bounds: { x: 0, y: 0, w: 100, h: 100 }, nodes: out, edges: {}, labels: [] };
}

describe('canvas hit-test (DD-08 §6: "from lastGood.layout frames, not the DOM")', () => {
  it('finds the node containing a point', () => {
    const l = layout({ a: { x: 0, y: 0, w: 10, h: 10 } });
    expect(hitTestNode(l, { x: 5, y: 5 })).toBe('a');
  });

  it('returns null outside every frame', () => {
    const l = layout({ a: { x: 0, y: 0, w: 10, h: 10 } });
    expect(hitTestNode(l, { x: 50, y: 50 })).toBeNull();
  });

  it('prefers the smaller of two overlapping frames (a leaf over its container)', () => {
    const l = layout({
      container: { x: 0, y: 0, w: 100, h: 100 },
      leaf: { x: 10, y: 10, w: 10, h: 10 },
    });
    expect(hitTestNode(l, { x: 15, y: 15 })).toBe('leaf');
    expect(hitTestNode(l, { x: 80, y: 80 })).toBe('container');
  });

  it('treats frame edges as inclusive', () => {
    const l = layout({ a: { x: 0, y: 0, w: 10, h: 10 } });
    expect(hitTestNode(l, { x: 0, y: 0 })).toBe('a');
    expect(hitTestNode(l, { x: 10, y: 10 })).toBe('a');
  });
});
