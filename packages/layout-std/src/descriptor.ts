import { LAYOUT_API_VERSION, type EngineCapabilities, type JSONSchema7 } from '@sgl/layout-api';

/**
 * Everything about the `grid` engine except `layout()` itself: its id, name,
 * capabilities and option and hint schemas (DD-06 §7).
 *
 * Its own entry point, `@sgl/layout-std/descriptor` (F20), as
 * `@sgl/layout-elk/descriptor` is for `elk`: the main thread lists the engine
 * in Engine ▾ and checks `@layout` keys against its schemas (`REGISTERED_ENGINES`,
 * `io/app-boot.ts`), but only the layout worker runs `layout()`. An object
 * literal's method cannot be tree-shaken, so importing `gridEngine` on the main
 * thread carried the whole packing code into the boot bundle.
 */

export const GRID_ENGINE_ID = 'sgl.grid';

export interface GridDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof LAYOUT_API_VERSION;
  readonly capabilities: EngineCapabilities;
  readonly optionsSchema: JSONSchema7;
  readonly hintsSchema: JSONSchema7;
}

/** What every in-house engine's descriptor holds (`grid`, `fixed`). */
export type EngineDescriptor = GridDescriptor;

export const gridDescriptor: GridDescriptor = {
  id: GRID_ENGINE_ID,
  name: 'Grid',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,

  // `labelPlacement: false` and `edgeRouting: 'straight'` are deliberate: the
  // host's fallbacks then do label placement and routing, which exercises the
  // negotiation path that makes third-party engines approachable (`grid.ts`).
  capabilities: {
    containers: true,
    edgeRouting: 'straight',
    ports: false,
    labelPlacement: false,
    incremental: false,
    determinism: 'bitwise',
  },

  optionsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      columns: { oneOf: [{ type: 'number' }, { type: 'string', enum: ['auto'] }], default: 'auto' },
      gap: { type: 'number', default: 24 },
      align: { type: 'string', enum: ['start', 'center'], default: 'center' },
    },
  },

  hintsSchema: {
    type: 'object',
    properties: {
      columns: { type: 'number' },
      span: { type: 'number' }, // ⟶ v1.x
    },
  },
};

/**
 * `fixed` (DD-12 §4, B5): every node where its `@pin` says, relative to its
 * parent's content box; nodes without a pin packed below the pinned ones,
 * with one `SGL4020` each (H1). Everything but `layout()`, for the same
 * reason as `gridDescriptor`: the page lists it and checks `@layout` keys
 * against its schemas, and only the worker runs it (H9: statically).
 *
 * N18: `pins: true` (so a `@pin` is not `SGL4021` under it), `ports: true`
 * (it spreads ports on the frame, N15), and the host's labels and straight
 * edges (N14, N16). `bitwise` (N17): copies, sums, `max`/`min` and the
 * division by 2 in packing, nothing else. N19: one option, `gap`, the
 * loose-node packing gap, grid's field and default.
 */
export const FIXED_ENGINE_ID = 'sgl.fixed';

export const fixedDescriptor: EngineDescriptor = {
  id: FIXED_ENGINE_ID,
  name: 'Fixed',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: {
    containers: true,
    edgeRouting: 'straight',
    ports: true,
    labelPlacement: false,
    incremental: false,
    determinism: 'bitwise',
    pins: true,
  },
  optionsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { gap: { type: 'number', minimum: 0, default: 24 } },
  },
  hintsSchema: { type: 'object', properties: {} },
};

/**
 * `tree` (DD-12 §8, B5 branch 4): a tidy tree (Buchheim–Walker) over the
 * spanning forest of each container's children (§7), with elbow edges.
 * Everything but `layout()`: the page lists it and checks `@layout` keys
 * against its schemas; the worker registers `treeEngine`, whose `layout()`
 * loads the lazy `std-trees` chunk on first use (H9, N52).
 *
 * N37: `elk`'s option names and defaults, so switching keeps a document's
 * feel; `edgeRouting: straight` turns the elbows off. The hints are a
 * container's own `direction` (N38, which `@direction` sets) and `root`
 * (N27). N39: `orthogonal` routing (the tree arcs' elbows; the host routes
 * every other edge straight), the host's labels, no ports, and `bitwise`
 * (N33: `+ - * /`, `max`/`min` only).
 */
export const TREE_ENGINE_ID = 'sgl.tree';

const DIRECTIONS = ['down', 'up', 'left', 'right'];

/** `nodeSpacing` and `rankSpacing`, `elk`'s names and defaults, which `tree`
 *  and `radial` share (N37, N47): one object, so the two schemas cost the
 *  boot bundle once. */
const SPACINGS = {
  nodeSpacing: { type: 'number', minimum: 0, default: 40 },
  rankSpacing: { type: 'number', minimum: 0, default: 70 },
} as const;

/** The `root: boolean` hint (N27), `tree`'s and `radial`'s. */
const ROOT_HINT = { type: 'boolean' } as const;

export const treeDescriptor: EngineDescriptor = {
  id: TREE_ENGINE_ID,
  name: 'Tree',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: {
    containers: true,
    edgeRouting: 'orthogonal',
    ports: false,
    labelPlacement: false,
    incremental: false,
    determinism: 'bitwise',
  },
  optionsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      direction: { type: 'string', enum: DIRECTIONS, default: 'down' },
      ...SPACINGS,
      edgeRouting: { type: 'string', enum: ['orthogonal', 'straight'], default: 'orthogonal' },
    },
  },
  hintsSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: DIRECTIONS },
      root: ROOT_HINT,
    },
  },
};

/**
 * `radial` (DD-12 §9, B5 branch 5): a wedge layout (Eades) over the same
 * spanning forest as `tree` (§7), each tree's root at the centre of its own
 * disc. Everything but `layout()`, as for `tree`: the worker registers
 * `radialEngine`, whose `layout()` loads the same lazy `std-trees` chunk
 * (H9, N52).
 *
 * N47: `nodeSpacing` and `rankSpacing` (the ring gap), `tree`'s; the one
 * hint is `root` (N27). The host draws every edge straight (N46) and places
 * the labels; no ports. `bitwise` (N44, H8): its own `sinTurn`/`cosTurn`,
 * never `Math.sin`/`Math.cos`.
 */
export const RADIAL_ENGINE_ID = 'sgl.radial';

export const radialDescriptor: EngineDescriptor = {
  id: RADIAL_ENGINE_ID,
  name: 'Radial',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: {
    containers: true,
    edgeRouting: 'straight',
    ports: false,
    labelPlacement: false,
    incremental: false,
    determinism: 'bitwise',
  },
  optionsSchema: { type: 'object', additionalProperties: false, properties: SPACINGS },
  hintsSchema: { type: 'object', properties: { root: ROOT_HINT } },
};
