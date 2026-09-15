/**
 * The style-property registry — the single source of truth for what a style
 * property is (DD-04 §2).
 *
 * The `affects` flag is what makes the geometry/paint split mechanical rather than
 * editorial. Rule of thumb applied when classifying: **if changing it could move
 * any pixel other than its own, it is geometry.** Several properties look like
 * paint and are not — `strokeWidth` changes outer bounds and therefore container
 * packing; `radius` moves the edge attachment point; `padding` changes a
 * container's content frame.
 *
 * Adding a property means adding a row here first.
 */

export interface StyleProperty {
  readonly name: string;
  readonly affects: 'geometry' | 'paint';
  readonly type: 'color' | 'length' | 'number' | 'insets' | 'enum' | 'string' | 'dash';
  readonly enum?: readonly string[];
  readonly appliesTo: readonly ('node' | 'container' | 'edge' | 'text')[];
  /** Text properties inherit from the owning element's rule. */
  readonly inherits: boolean;
}

const NODE_AND_CONTAINER = ['node', 'container'] as const;
const DRAWABLE = ['node', 'container', 'edge'] as const;
const ANY = ['node', 'container', 'edge', 'text'] as const;
const TEXT = ['text'] as const;
const EDGE = ['edge'] as const;
const NODE = ['node'] as const;

export const REGISTRY: readonly StyleProperty[] = [
  // ---- geometry: text ----------------------------------------------------
  { name: 'fontFamily', affects: 'geometry', type: 'string', appliesTo: TEXT, inherits: true },
  { name: 'fontSize', affects: 'geometry', type: 'length', appliesTo: TEXT, inherits: true },
  { name: 'fontWeight', affects: 'geometry', type: 'number', appliesTo: TEXT, inherits: true },
  // Italic changes advances, so this is geometry to be safe.
  { name: 'fontStyle', affects: 'geometry', type: 'enum', enum: ['normal', 'italic'], appliesTo: TEXT, inherits: true },
  { name: 'lineHeight', affects: 'geometry', type: 'number', appliesTo: TEXT, inherits: true },
  { name: 'letterSpacing', affects: 'geometry', type: 'length', appliesTo: TEXT, inherits: true },

  // ---- geometry: box -----------------------------------------------------
  { name: 'padding', affects: 'geometry', type: 'insets', appliesTo: NODE_AND_CONTAINER, inherits: false },
  { name: 'titleGap', affects: 'geometry', type: 'length', appliesTo: ['container'], inherits: false },
  { name: 'strokeWidth', affects: 'geometry', type: 'length', appliesTo: DRAWABLE, inherits: false },
  { name: 'radius', affects: 'geometry', type: 'length', appliesTo: NODE_AND_CONTAINER, inherits: false },
  { name: 'minWidth', affects: 'geometry', type: 'length', appliesTo: NODE, inherits: false },
  { name: 'minHeight', affects: 'geometry', type: 'length', appliesTo: NODE, inherits: false },
  { name: 'width', affects: 'geometry', type: 'length', appliesTo: NODE, inherits: false },
  { name: 'height', affects: 'geometry', type: 'length', appliesTo: NODE, inherits: false },
  { name: 'aspectRatio', affects: 'geometry', type: 'number', appliesTo: NODE, inherits: false },
  { name: 'arrowSize', affects: 'geometry', type: 'length', appliesTo: EDGE, inherits: false },
  { name: 'portSize', affects: 'geometry', type: 'length', appliesTo: NODE, inherits: false },
  { name: 'labelGap', affects: 'geometry', type: 'length', appliesTo: EDGE, inherits: false },

  // ---- paint -------------------------------------------------------------
  { name: 'fill', affects: 'paint', type: 'color', appliesTo: NODE_AND_CONTAINER, inherits: false },
  { name: 'stroke', affects: 'paint', type: 'color', appliesTo: DRAWABLE, inherits: false },
  { name: 'strokeDash', affects: 'paint', type: 'dash', appliesTo: DRAWABLE, inherits: false },
  { name: 'opacity', affects: 'paint', type: 'number', appliesTo: ANY, inherits: false },
  { name: 'color', affects: 'paint', type: 'color', appliesTo: TEXT, inherits: true },
  { name: 'arrowhead', affects: 'paint', type: 'enum', enum: ['triangle', 'open', 'diamond', 'circle', 'none'], appliesTo: EDGE, inherits: false },
  { name: 'labelPlate', affects: 'paint', type: 'color', appliesTo: EDGE, inherits: false },
  { name: 'shadow', affects: 'paint', type: 'enum', enum: ['none', 'soft'], appliesTo: NODE_AND_CONTAINER, inherits: false },

  // ⟶ v1.x: gradient, glow (C13), sketch (C9), icon* (C10).
];

export const BY_NAME: ReadonlyMap<string, StyleProperty> = new Map(
  REGISTRY.map((p) => [p.name, p]),
);

/** Loud on purpose — an unresolved colour token should be impossible to miss. */
export const COLOR_FALLBACK = '#FF00FF';
