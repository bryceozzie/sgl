import { describe, expect, it } from 'vitest';
import { GRID_ENGINE_ID, gridDescriptor } from '../src/descriptor.js';
import { gridEngine } from '../src/grid.js';

// F20: the page imports `@sgl/layout-std/descriptor` instead of `gridEngine`,
// so Engine ▾ and SGL4010's schemas must read exactly what the worker's engine
// declares. Pinned field by field, so a field moved or lost in the split fails.
describe('gridDescriptor', () => {
  it('is gridEngine without layout()', () => {
    const { layout, ...rest } = gridEngine;
    expect(typeof layout).toBe('function');
    expect(rest).toEqual(gridDescriptor);
    expect(Object.keys(rest).sort()).toEqual(Object.keys(gridDescriptor).sort());
  });

  it('keeps the id, name, capabilities and schemas the engine declared before the split', () => {
    expect(GRID_ENGINE_ID).toBe('sgl.grid');
    expect(gridDescriptor).toEqual({
      id: 'sgl.grid',
      name: 'Grid',
      version: '0.0.0',
      apiVersion: gridEngine.apiVersion,
      capabilities: { containers: true, edgeRouting: 'straight', ports: false, labelPlacement: false, incremental: false, determinism: 'bitwise' },
      optionsSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          columns: { oneOf: [{ type: 'number' }, { type: 'string', enum: ['auto'] }], default: 'auto' },
          gap: { type: 'number', default: 24 },
          align: { type: 'string', enum: ['start', 'center'], default: 'center' },
        },
      },
      hintsSchema: { type: 'object', properties: { columns: { type: 'number' }, span: { type: 'number' } } },
    });
  });

  it('carries no layout()', () => {
    expect('layout' in gridDescriptor).toBe(false);
  });
});
