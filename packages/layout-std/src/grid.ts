import { NotImplemented } from '@sgl/core';
import {
  LAYOUT_API_VERSION,
  type LayoutContext,
  type LayoutEngine,
  type LayoutInput,
  type LayoutResult,
} from '@sgl/layout-api';

/**
 * Deterministic row/column packing. The second engine exists to prove that two
 * engines sit behind one interface, and it is the phase-0 spike engine.
 *
 * It declares `labelPlacement: false` and `edgeRouting: 'straight'` deliberately:
 * the host's fallbacks then do label placement and routing, which exercises the
 * negotiation path that makes third-party engines approachable.
 *
 * Exit criterion (DD-00 §6): bitwise identical across two runs and across
 * Chrome and Firefox.
 *
 * Design: DD-06 §7.
 */
export const gridEngine: LayoutEngine = {
  id: 'sgl.grid',
  name: 'Grid',
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

  layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
    void input;
    void ctx;
    throw new NotImplemented('gridEngine.layout()', 'DD-06 §7');
  },
};
