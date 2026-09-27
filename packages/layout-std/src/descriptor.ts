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
