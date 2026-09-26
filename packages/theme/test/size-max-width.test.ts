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
