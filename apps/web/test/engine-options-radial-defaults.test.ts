import { describe, expect, it, vi } from 'vitest';

/**
 * B5 branch 5: `radial`'s form takes its defaults from `radialDescriptor`,
 * as `tree`'s takes them from `treeDescriptor` (B5 branch 4, fix round 1,
 * item 9). Its defaults equal `tree`'s and `elk`'s today, so a value check
 * cannot tell the sources apart: here the descriptor is replaced by one with
 * other defaults, and the form must follow it, both in what it resets to
 * and in what it shows for an unusable value. `tree`'s must not move.
 */

vi.mock('@sgl/layout-std/descriptor', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sgl/layout-std/descriptor')>();
  const props = (real.radialDescriptor.optionsSchema as { properties: Record<string, object> }).properties;
  return {
    ...real,
    radialDescriptor: {
      ...real.radialDescriptor,
      optionsSchema: {
        ...real.radialDescriptor.optionsSchema,
        properties: {
          ...props,
          nodeSpacing: { ...props['nodeSpacing'], default: 33 },
          rankSpacing: { ...props['rankSpacing'], default: 77 },
        },
      },
    },
  };
});

describe("radial's form defaults are radialDescriptor's", () => {
  it('resets to, and falls back to, the descriptor’s defaults', async () => {
    const { defaultOptionsFor, optionsForEngine } = await import('../src/state/engine-options.js');
    const want = { nodeSpacing: 33, rankSpacing: 77 };
    expect(defaultOptionsFor('sgl.radial')).toEqual(want);
    expect(optionsForEngine('sgl.radial', { nodeSpacing: -1, rankSpacing: 501 })).toEqual(want);
    expect(optionsForEngine('sgl.radial', { nodeSpacing: 0, rankSpacing: 500 })).toEqual({ nodeSpacing: 0, rankSpacing: 500 });
    // tree's (and elk's) own defaults are untouched.
    expect(defaultOptionsFor('sgl.tree')).toMatchObject({ nodeSpacing: 40, rankSpacing: 70 });
    expect(defaultOptionsFor('sgl.elk')).toMatchObject({ nodeSpacing: 40, rankSpacing: 70 });
  });
});
