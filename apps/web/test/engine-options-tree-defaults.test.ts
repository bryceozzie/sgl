import { describe, expect, it, vi } from 'vitest';

/**
 * Fix round 1 of B5 branch 4 (item 9): `tree`'s form takes its defaults from
 * `treeDescriptor`, not from `elk`'s. Today the two agree (40, 70, `down`),
 * so a value check cannot tell them apart: here the descriptor is replaced
 * by one with other defaults, and the form must follow it, both in what it
 * resets to and in what it shows for an unusable value.
 */

vi.mock('@sgl/layout-std/descriptor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sgl/layout-std/descriptor')>();
  const props = (real.treeDescriptor.optionsSchema as { properties: Record<string, object> }).properties;
  return {
    ...real,
    treeDescriptor: {
      ...real.treeDescriptor,
      optionsSchema: {
        ...real.treeDescriptor.optionsSchema,
        properties: {
          ...props,
          direction: { ...props['direction'], default: 'right' },
          nodeSpacing: { ...props['nodeSpacing'], default: 33 },
          rankSpacing: { ...props['rankSpacing'], default: 77 },
          edgeRouting: { ...props['edgeRouting'], default: 'straight' },
        },
      },
    },
  };
});

describe("tree's form defaults are treeDescriptor's (fix round 1, item 9)", () => {
  it('resets to, and falls back to, the descriptor’s defaults', async () => {
    const { defaultOptionsFor, optionsForEngine } = await import('../src/state/engine-options.js');
    const want = { direction: 'right', nodeSpacing: 33, rankSpacing: 77, edgeRouting: 'straight' };
    expect(defaultOptionsFor('sgl.tree')).toEqual(want);
    expect(optionsForEngine('sgl.tree', { direction: 'sideways', nodeSpacing: -1, rankSpacing: 501, edgeRouting: 'x' })).toEqual(want);
    expect(optionsForEngine('sgl.tree', { direction: 'up', nodeSpacing: 0, rankSpacing: 500, edgeRouting: 'orthogonal' })).toEqual({
      direction: 'up',
      nodeSpacing: 0,
      rankSpacing: 500,
      edgeRouting: 'orthogonal',
    });
    // elk's own defaults are untouched.
    expect(defaultOptionsFor('sgl.elk')).toMatchObject({ nodeSpacing: 40, rankSpacing: 70 });
  });
});
