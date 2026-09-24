import { neutralLight } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { runPipeline } from './pipeline.js';

/**
 * Fix round 1, item 1: `@size` is geometry only (language spec §4: `width`,
 * `height`, `minWidth`, `maxWidth`, `aspectRatio`). Before the fix, DD-04 §4
 * step 6 applied any key under `@size`, so `@size.fill` painted — and since a
 * paint class is named after the cascade signature (which, rightly, leaves
 * `@size` out), `a` and `b` below shared one `s-` class and `b` rendered red.
 */
const SOURCE = `a: { @size: { width: 80, fill: "#FF0000" } }
b: {}
`;

function shapeClass(svg: string, id: string): string {
  const m = new RegExp(`<g id="n-${id}"[^>]*><path class="([^"]*)"`).exec(svg);
  if (m === null) throw new Error(`no node ${id}`);
  return m[1]!;
}

describe('@size carries geometry only (fix round 1, item 1)', () => {
  it('a paint key under @size does not paint, and is warned about', async () => {
    const { styled, rendered, diagnostics } = await runPipeline(SOURCE, neutralLight);
    const a = styled.styles['a' as keyof typeof styled.styles]!;
    const b = styled.styles['b' as keyof typeof styled.styles]!;
    expect(a.paint['fill']).toBe(b.paint['fill']);
    expect(a.paint['fill']).not.toBe('#FF0000');
    expect(a.geometry['width']).toBe(80);
    expect(rendered.svg).not.toContain('#FF0000');
    // If `a` and `b` share a paint class, it is because their paint is equal.
    const sOf = (id: string): string => shapeClass(rendered.svg, id).split(' ').find((c) => c.startsWith('s-'))!;
    expect(sOf('a')).toBe(sOf('b'));
    const warn = diagnostics.filter((d) => d.code === 'SGL2010');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.message).toContain('size.fill');
    expect(warn[0]!.severity).toBe('warning');
  });

  it('the spec keys still size the node, with no warning', async () => {
    const { styled, diagnostics } = await runPipeline('a: { @size: { width: 80, height: 50, minWidth: 10, aspectRatio: 2 } }\n', neutralLight);
    const a = styled.styles['a' as keyof typeof styled.styles]!;
    expect(a.geometry).toMatchObject({ width: 80, height: 50, minWidth: 10, aspectRatio: 2 });
    expect(diagnostics.filter((d) => d.code === 'SGL2010')).toEqual([]);
  });
});
