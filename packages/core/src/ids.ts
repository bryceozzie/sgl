/** Branded ID types (DD-00 §3). Plain strings at runtime, distinct at the type level. */

export type NodeId = string & { readonly __brand: 'NodeId' };
export type EdgeId = string & { readonly __brand: 'EdgeId' };
export type LabelId = string & { readonly __brand: 'LabelId' };
export type PortId = string & { readonly __brand: 'PortId' };

/** Built-in shapes the MVP renderer can draw (DD-07 §4). Unknown values fall back
 *  to `rect` with an SGL3001 warning, so this is not a closed set at the language level. */
export type ShapeId =
  | 'rect'
  | 'round'
  | 'ellipse'
  | 'diamond'
  | 'hexagon'
  | 'cylinder'
  | 'package'
  | (string & {});

export const asNodeId = (s: string): NodeId => s as NodeId;
export const asEdgeId = (s: string): EdgeId => s as EdgeId;
export const asLabelId = (s: string): LabelId => s as LabelId;
export const asPortId = (s: string): PortId => s as PortId;
