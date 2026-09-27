import { describe, expect, it } from 'vitest';
import { corpusStyledGraph } from './corpus.js';
import { compile, parse, resolve } from '@sgl/core';
import { resolveTheme, styleGraph } from '../src/cascade.js';
import { BUILT_IN, neutralLight } from '../src/themes/index.js';

/**
 * `@size.maxWidth` reaches `geometry` (A18, DD-11 T35). Language spec §4 and
 * `SIZE_KEYS` always listed it, but the style-property registry had no row for it,
 * so the cascade dropped it with `SGL5003` and nothing could read it.
 */
function styled(src: string) {
  const { model } = resolve(parse(src).ast);
  const { graph } = compile(model);
  return styleGraph(graph, resolveTheme(neutralLight, (id) => BUILT_IN[id]).value, model.classes);
}

describe('@size.maxWidth (DD-11 T35)', () => {
  it('reaches the node\'s geometry, with no diagnostic', () => {
    const { value, diagnostics } = styled('a: { @size: { maxWidth: 120, width: 90 } }\n');
    expect(value.styles['a' as keyof typeof value.styles]!.geometry).toMatchObject({ maxWidth: 120, width: 90 });
    expect(diagnostics).toEqual([]);
  });

  it('changes nothing for a document without it: no corpus document sets @size', () => {
    const { styled: value } = corpusStyledGraph('shapes.sgl');
    for (const id of value.graph.order) expect(value.styles[id]!.geometry['maxWidth']).toBeUndefined();
  });
});

describe("a class's @size applies to its nodes (human decision H2)", () => {
  const geometry = (src: string, id: string) => {
    const { value } = styled(src);
    return value.styles[id as keyof typeof value.styles]!.geometry;
  };
  const CLASSES = '@classes: { Narrow: { @size: { maxWidth: 64, height: 50 } }, Wide: { @size: { maxWidth: 300 } } }\n';

  it("merges the class's size keys at step 4", () => {
    expect(geometry(`${CLASSES}a: Narrow\n`, 'a')).toMatchObject({ maxWidth: 64, height: 50 });
  });
  it('in @type order, the later class winning per key', () => {
    expect(geometry(`${CLASSES}a: { @type: [Narrow, Wide] }\n`, 'a')).toMatchObject({ maxWidth: 300, height: 50 });
    expect(geometry(`${CLASSES}a: { @type: [Wide, Narrow] }\n`, 'a')).toMatchObject({ maxWidth: 64, height: 50 });
  });
  it("the node's own @size overrides per key at step 6", () => {
    expect(geometry(`${CLASSES}a: { @type: Narrow, @size: { maxWidth: 99 } }\n`, 'a')).toMatchObject({ maxWidth: 99, height: 50 });
  });
  it('is geometry only: the paint is unchanged, geometryHash covers it, and nodes of one class share a style', () => {
    const withSize = styled(`${CLASSES}a: Narrow\nb: Narrow\n`).value;
    const without = styled('@classes: { Narrow: {} }\na: Narrow\nb: Narrow\n').value;
    expect(withSize.styles['a' as keyof typeof withSize.styles]!.paint).toEqual(without.styles['a' as keyof typeof without.styles]!.paint);
    expect(withSize.geometryHash).not.toBe(without.geometryHash);
    expect(withSize.styles['a' as keyof typeof withSize.styles]).toBe(withSize.styles['b' as keyof typeof withSize.styles]);
  });
  it("only the @size keys: a class's @size.fill paints nothing", () => {
    const { value } = styled('@classes: { K: { @size: { fill: "#FF0000", width: 90 } } }\na: K\n');
    expect(value.styles['a' as keyof typeof value.styles]!.paint['fill']).not.toBe('#FF0000');
    expect(value.styles['a' as keyof typeof value.styles]!.geometry['width']).toBe(90);
  });
});
