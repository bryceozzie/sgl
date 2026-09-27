import { describe, expect, it } from 'vitest';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';

/**
 * A container's `@size` (fix round 1, item 10). The size keys apply to nodes only
 * (DD-04's registry rows are `node`), so a container's was dropped by the cascade
 * with no word. It is now `SGL2012` at the key, like any key on the wrong scope,
 * and dropped by the resolver.
 */
function run(src: string) {
  const { model, diagnostics } = resolve(parse(src).ast);
  return { model, diagnostics };
}

describe("a container's @size is SGL2012 (fix round 1, item 10)", () => {
  it('warns at the key and drops it', () => {
    const src = 'box: {\n  @size: { width: 90, maxWidth: 80 }\n  a\n}\n';
    const { model, diagnostics } = run(src);
    expect(diagnostics.map((d) => [d.code, d.severity, d.message])).toEqual([['SGL2012', 'warning', '`@size` is not valid on container; ignored.']]);
    expect(src.slice(diagnostics[0]!.span.from, diagnostics[0]!.span.to)).toBe('@size');
    const box = model.root.children.find((c) => c.key === 'box')!;
    expect(box.config.size).toBeUndefined();
  });

  it('counts children from every declaration of the node', () => {
    const { diagnostics } = run('box: { @size: { width: 90 } }\nbox: { a }\n');
    expect(diagnostics.map((d) => d.code)).toContain('SGL2012');
  });

  it('a leaf node keeps its @size, with no diagnostic', () => {
    const { model, diagnostics } = run('a: { @size: { width: 90 } }\n');
    expect(diagnostics).toEqual([]);
    expect(model.root.children[0]!.config.size).toEqual({ width: 90 });
  });
});
