import { DEFAULT_SHAPE as CORE_DEFAULT_SHAPE } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import * as renderSvg from '../src/index.js';
import { runPipeline } from './pipeline.js';

/**
 * DD-13 P5 (help branch 1): `A11Y_KEYS` is the list of `@a11y` sub-keys the
 * renderer reads, and the renderer reads exactly those; `DEFAULT_SHAPE` is
 * `@sgl/core`'s, not a second copy.
 */

/** The ARIA attribute each `@a11y` sub-key becomes. */
const ATTRIBUTE: Readonly<Record<string, string>> = { label: 'aria-label', description: 'aria-description' };

describe('DD-13 P5: @sgl/render-svg facts exported as data', () => {
  it('A11Y_KEYS lists the @a11y sub-keys the renderer reads', () => {
    expect(renderSvg.A11Y_KEYS).toEqual(['label', 'description']);
  });

  it('each A11Y_KEYS sub-key reaches the SVG, on a node and on an edge', async () => {
    for (const key of renderSvg.A11Y_KEYS) {
      const attr = ATTRIBUTE[key];
      expect(attr).toBeDefined();
      const src = `a: { @a11y: { ${key}: "Node text" } }\nb\na -> b: { @a11y: { ${key}: "Edge text" } }\n`;
      const { rendered, diagnostics } = await runPipeline(src);
      expect(diagnostics).toEqual([]);
      expect(rendered.svg).toContain(`${attr}="Node text"`);
      expect(rendered.svg).toContain(`${attr}="Edge text"`);
    }
  });

  it('an @a11y sub-key not in A11Y_KEYS reaches no attribute', async () => {
    const { rendered } = await runPipeline('a: { @a11y: { role: "Role text" } }\n');
    expect(rendered.svg).not.toContain('Role text');
  });

  it("DEFAULT_SHAPE is @sgl/core's", () => {
    expect(renderSvg.DEFAULT_SHAPE).toBe(CORE_DEFAULT_SHAPE);
    expect(renderSvg.resolveShape('no-such-shape').shape).toBe(renderSvg.SHAPES[CORE_DEFAULT_SHAPE]);
  });
});
