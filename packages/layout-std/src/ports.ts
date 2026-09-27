import type { PortSpec, Rect } from '@sgl/core';
import type { NodeLayout } from '@sgl/layout-api';

type Ports = NonNullable<NodeLayout['ports']>;

const NORMAL = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
} as const;

/**
 * Ports on the frame (DD-12 N15): a side's `k` ports, in declaration order,
 * at `(i + 1) / (k + 1)` of that side's length — north and south left to
 * right, east and west top to bottom — each with the side's outward normal.
 * `routeStraight` starts and ends an edge at a placed port's point (DD-06
 * §4.2), and the renderer draws its circle there (F6).
 */
export function placePorts(frame: Rect, ports: readonly PortSpec[]): Ports {
  const out: Record<string, Ports[string]> = {};
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    const onSide = ports.filter((p) => p.side === side);
    const k = onSide.length;
    for (let i = 0; i < k; i += 1) {
      const port = onSide[i]!;
      const along = (len: number): number => (len * (i + 1)) / (k + 1);
      const point =
        side === 'north'
          ? { x: frame.x + along(frame.w), y: frame.y }
          : side === 'south'
            ? { x: frame.x + along(frame.w), y: frame.y + frame.h }
            : side === 'east'
              ? { x: frame.x + frame.w, y: frame.y + along(frame.h) }
              : { x: frame.x, y: frame.y + along(frame.h) };
      out[port.id] = { point, normal: NORMAL[side] };
    }
  }
  return out;
}
