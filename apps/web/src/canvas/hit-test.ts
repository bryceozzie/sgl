import type { NodeId } from '@sgl/core';
import type { LayoutResult } from '@sgl/layout-api';

/**
 * Which node (if any) a diagram-space point falls in — computed from
 * `lastGood.layout` frames (DD-08 §6: "not from the DOM"), so hover/click work
 * identically whether or not the exported tree happens to hit-test the same way
 * a browser's own geometry queries would.
 *
 * Ties (nested/overlapping frames) go to the smallest frame — a leaf inside a
 * container's frame should out-rank the container.
 */
export function hitTestNode(layout: LayoutResult, point: { readonly x: number; readonly y: number }): NodeId | null {
  let best: NodeId | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const id of Object.keys(layout.nodes).sort() as NodeId[]) {
    const frame = layout.nodes[id]?.frame;
    if (frame === undefined) continue;
    if (point.x < frame.x || point.x > frame.x + frame.w || point.y < frame.y || point.y > frame.y + frame.h) continue;
    const area = frame.w * frame.h;
    if (area < bestArea) {
      bestArea = area;
      best = id;
    }
  }
  return best;
}
