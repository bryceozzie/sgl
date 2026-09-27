import type { NodeId, Point } from '@sgl/core';
import type { LayoutInput, LayoutResult } from '@sgl/layout-api';

export declare function gridPins(input: LayoutInput, result: LayoutResult): Map<NodeId, Point>;
export declare function pinnedSource(source: string, pins: ReadonlyMap<string, Point>): string;
