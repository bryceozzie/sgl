import { NotImplemented } from '@sgl/core';
import {
  LAYOUT_API_VERSION,
  type LayoutContext,
  type LayoutEngine,
  type LayoutInput,
  type LayoutResult,
} from '@sgl/layout-api';

/**
 * The default engine (ADR-0005): an adapter over elkjs's layered algorithm.
 *
 * Uses `elk.bundled.js` — the synchronous, single-thread build — inside our own
 * layout worker. elkjs's worker build would nest a worker inside a worker and cost
 * two serialisation hops (06 §4, pitfall 7). `org.eclipse.elk.randomSeed` is pinned
 * to 1 explicitly: layered is deterministic by default, but pin it.
 *
 * Ships as a lazy-loaded chunk, excluded from the core bundle budget.
 *
 * Design: DD-06 §6.
 */
export const elkEngine: LayoutEngine = {
  id: 'sgl.elk',
  name: 'ELK Layered',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,

  capabilities: {
    containers: true,
    edgeRouting: 'orthogonal',
    ports: true,
    labelPlacement: true,
    incremental: false,
    determinism: 'quantized',
  },

  optionsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], default: 'down' },
      nodeSpacing: { type: 'number', default: 40 },
      rankSpacing: { type: 'number', default: 70 },
      // ORTHOGONAL across hierarchy boundaries is ELK's busiest bug area (06 §4,
      // pitfall 8). POLYLINE is one option away when an artefact appears, and the
      // conformance corpus carries boundary-crossing edges from day one.
      edgeRouting: { type: 'string', enum: ['ORTHOGONAL', 'POLYLINE', 'SPLINES'], default: 'ORTHOGONAL' },
      nodePlacement: { type: 'string', enum: ['BRANDES_KOEPF', 'NETWORK_SIMPLEX', 'LINEAR_SEGMENTS'], default: 'BRANDES_KOEPF' },
    },
  },

  hintsSchema: {
    type: 'object',
    properties: {
      rank: { type: 'string', enum: ['same'] }, // ⟶ B13
      priority: { type: 'number' },
      portConstraints: { type: 'string' },
    },
  },

  layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
    void input;
    void ctx;
    throw new NotImplemented('elkEngine.layout()', 'DD-06 §6');
  },
};

export default elkEngine;
