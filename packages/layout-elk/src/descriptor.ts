import { LAYOUT_API_VERSION, type EngineCapabilities, type JSONSchema7 } from '@sgl/layout-api';

/**
 * Everything about the `elk` engine except `layout()` itself: its id, name,
 * capabilities, option and hint schemas, and option defaults (DD-06 §6).
 *
 * Its own entry point, `@sgl/layout-elk/descriptor` (Stage K, decision K1), so
 * the main thread can list the engine in Engine ▾ and build its options form
 * without importing the module whose `layout()` holds the dynamic
 * `import('elkjs/lib/elk.bundled.js')`. A bundler emits a chunk for every
 * dynamic import it sees, so importing the full engine object on the main
 * thread would emit a second, never-loaded copy of elkjs there, and the PWA
 * precache (which takes every emitted file) would carry it twice. This module
 * imports nothing from elkjs.
 */

export const ELK_ENGINE_ID = 'sgl.elk';

export type ElkDirection = 'down' | 'up' | 'left' | 'right';
export type ElkEdgeRouting = 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES';
export type ElkNodePlacement = 'BRANDES_KOEPF' | 'NETWORK_SIMPLEX' | 'LINEAR_SEGMENTS';

export const ELK_DIRECTIONS: readonly ElkDirection[] = ['down', 'up', 'left', 'right'];
export const ELK_EDGE_ROUTINGS: readonly ElkEdgeRouting[] = ['ORTHOGONAL', 'POLYLINE', 'SPLINES'];
export const ELK_NODE_PLACEMENTS: readonly ElkNodePlacement[] = ['BRANDES_KOEPF', 'NETWORK_SIMPLEX', 'LINEAR_SEGMENTS'];

/** ELK's `PortConstraints` members: the `portConstraints` hint's enum (DD-06
 *  §6). The mapping skips any other value (fix round 1, item 4). */
export const ELK_PORT_CONSTRAINTS = ['UNDEFINED', 'FREE', 'FIXED_SIDE', 'FIXED_ORDER', 'FIXED_RATIO', 'FIXED_POS'] as const;

/** The engine's options, every field filled. */
export interface ElkOptions {
  readonly direction: ElkDirection;
  readonly nodeSpacing: number;
  readonly rankSpacing: number;
  readonly edgeRouting: ElkEdgeRouting;
  readonly nodePlacement: ElkNodePlacement;
}

/** DD-06 §6's defaults. */
export const ELK_DEFAULT_OPTIONS: ElkOptions = {
  direction: 'down',
  nodeSpacing: 40,
  rankSpacing: 70,
  edgeRouting: 'ORTHOGONAL',
  nodePlacement: 'BRANDES_KOEPF',
};

/**
 * An options bag with every field filled: a value the schema allows is kept,
 * anything else (missing, the wrong type, a negative spacing, an unknown enum
 * member) falls back to the default. The bag reaching an engine comes from the
 * document record and the options form, so it is untrusted here exactly as
 * an engine's output is untrusted in `validateResult`.
 */
export function normalizeElkOptions(options: Readonly<Record<string, unknown>>): ElkOptions {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const spacing = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    direction: pick(options['direction'], ELK_DIRECTIONS, ELK_DEFAULT_OPTIONS.direction),
    nodeSpacing: spacing(options['nodeSpacing'], ELK_DEFAULT_OPTIONS.nodeSpacing),
    rankSpacing: spacing(options['rankSpacing'], ELK_DEFAULT_OPTIONS.rankSpacing),
    edgeRouting: pick(options['edgeRouting'], ELK_EDGE_ROUTINGS, ELK_DEFAULT_OPTIONS.edgeRouting),
    nodePlacement: pick(options['nodePlacement'], ELK_NODE_PLACEMENTS, ELK_DEFAULT_OPTIONS.nodePlacement),
  };
}

export interface ElkDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof LAYOUT_API_VERSION;
  readonly capabilities: EngineCapabilities;
  readonly optionsSchema: JSONSchema7;
  readonly hintsSchema: JSONSchema7;
  readonly defaults: Readonly<Record<string, unknown>>;
}

export const elkDescriptor: ElkDescriptor = {
  id: ELK_ENGINE_ID,
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
      direction: { type: 'string', enum: ELK_DIRECTIONS, default: ELK_DEFAULT_OPTIONS.direction },
      nodeSpacing: { type: 'number', minimum: 0, default: ELK_DEFAULT_OPTIONS.nodeSpacing },
      rankSpacing: { type: 'number', minimum: 0, default: ELK_DEFAULT_OPTIONS.rankSpacing },
      // ORTHOGONAL across hierarchy boundaries is ELK's busiest bug area (06 §4,
      // pitfall 8). POLYLINE is one option away when an artefact appears, and the
      // conformance corpus carries boundary-crossing edges from day one.
      edgeRouting: { type: 'string', enum: ELK_EDGE_ROUTINGS, default: ELK_DEFAULT_OPTIONS.edgeRouting },
      nodePlacement: { type: 'string', enum: ELK_NODE_PLACEMENTS, default: ELK_DEFAULT_OPTIONS.nodePlacement },
    },
  },

  hintsSchema: {
    type: 'object',
    properties: {
      rank: { type: 'string', enum: ['same'] }, // ⟶ B13
      priority: { type: 'number' },
      portConstraints: { type: 'string', enum: ELK_PORT_CONSTRAINTS },
    },
  },

  defaults: ELK_DEFAULT_OPTIONS as unknown as Readonly<Record<string, unknown>>,
};
