import { describe, expect, it } from 'vitest';
import { resolveTheme, styleGraph } from '../src/cascade.js';
import { BUILT_IN, neutralLight } from '../src/themes/index.js';
import type { ThemeDoc } from '../src/types.js';
import { corpusGraph, listCorpusDocs } from './corpus.js';

/**
 * C5 (execution plan §5 Stage L, DD-04 §7): the `high-contrast` and `print`
 * built-in themes. Both keep `neutral-light`'s metrics exactly, so a switch
 * to or from either is paint only (F9's path); `print` also forces every
 * painted fill white and every stroke and text black, over the document's
 * own colours too, which a token alone cannot reach.
 */

const lookup = (id: string): ThemeDoc | undefined => BUILT_IN[id];
const resolved = (id: string) => resolveTheme(BUILT_IN[id] as ThemeDoc, lookup);

describe('C5: the built-in theme list', () => {
  it('ships four themes: the two neutral ones, high-contrast and print', () => {
    expect(Object.keys(BUILT_IN).sort()).toEqual(['high-contrast', 'neutral-dark', 'neutral-light', 'print']);
    expect(BUILT_IN['high-contrast']?.name).toBe('High Contrast');
    expect(BUILT_IN['print']?.name).toBe('Print');
  });

  it.each(['high-contrast', 'print'])('%s resolves with no diagnostics', (id) => {
    expect(resolved(id).diagnostics).toEqual([]);
  });

  it.each(['high-contrast', 'print'])('%s is tokens only: it extends neutral-light and adds no rule, shape or class set', (id) => {
    const doc = BUILT_IN[id] as ThemeDoc;
    expect(doc.extends).toBe('neutral-light');
    expect(doc.rules).toEqual({});
    expect(doc.byShape).toEqual({});
    expect(doc.byClass).toEqual({});
  });
});

describe('C5: tokens only means neutral-light\'s geometry, so a switch is paint only (F9)', () => {
  const docs = listCorpusDocs();

  it.each(['high-contrast', 'print'])('%s: geometryHash equals neutral-light\'s for every corpus document', (id) => {
    expect(docs.length).toBeGreaterThan(25);
    const { value: light } = resolveTheme(neutralLight, lookup);
    const { value: other } = resolved(id);
    for (const doc of docs) {
      const { graph, classes } = corpusGraph(doc);
      const a = styleGraph(graph, light, classes).value;
      const b = styleGraph(graph, other, classes).value;
      expect(b.geometryHash, doc).toBe(a.geometryHash);
      // Every element's geometry half, not only the combined hash.
      for (const key of Object.keys(a.styles)) expect(b.styles[key as keyof typeof b.styles]?.geometry, `${doc} ${key}`).toEqual(a.styles[key as keyof typeof a.styles]?.geometry);
      for (const key of Object.keys(a.labelStyles)) expect(b.labelStyles[key as keyof typeof b.labelStyles]?.geometry, `${doc} ${key}`).toEqual(a.labelStyles[key as keyof typeof a.labelStyles]?.geometry);
    }
  });
});

describe('C5: print forces paint over the whole cascade (DD-04 §4 step 7)', () => {
  const { value: print } = resolved('print');

  it('resolves its force set: fill and plate white, stroke and text black, shadow off', () => {
    expect(print.force).toEqual({ color: '#000000', fill: '#FFFFFF', labelPlate: '#FFFFFF', shadow: 'none', stroke: '#000000' });
    expect(print.canvas.background).toBe('#FFFFFF');
  });

  it('beats a document class and an inline @style, and keeps strokeDash', () => {
    const { graph, classes } = corpusGraph('classes.sgl');
    const styled = styleGraph(graph, print, classes).value;
    // `override` is `Critical` (stroke @danger) with an inline stroke #123456.
    expect(styled.styles['override' as keyof typeof styled.styles]?.paint).toMatchObject({ fill: '#FFFFFF', stroke: '#000000', shadow: 'none' });
    for (const style of Object.values(styled.labelStyles)) expect(style.paint['color']).toBe('#000000');
  });

  it('applies only where a property applies: an edge gets no fill, a label no stroke', () => {
    const { graph, classes } = corpusGraph('containers-edges.sgl');
    const styled = styleGraph(graph, print, classes).value;
    const edge = graph.edges[0]!;
    expect(styled.styles[edge.id]?.paint['fill']).toBeUndefined();
    expect(styled.styles[edge.id]?.paint).toMatchObject({ stroke: '#000000', labelPlate: '#FFFFFF' });
    for (const style of Object.values(styled.labelStyles)) expect(style.paint['stroke']).toBeUndefined();
  });

  it('a dash survives: strokeDash is not forced', () => {
    const source = { ...neutralLight, id: 'dashy', extends: 'print', tokens: {}, rules: { edge: { strokeDash: 'dashed' } }, byShape: {}, byClass: {} } satisfies ThemeDoc;
    const { value } = resolveTheme(source, lookup);
    const { graph, classes } = corpusGraph('containers-edges.sgl');
    const styled = styleGraph(graph, value, classes).value;
    expect(styled.styles[graph.edges[0]!.id]?.paint).toMatchObject({ stroke: '#000000', strokeDash: [6, 3] });
  });

  it('a geometry property in force is dropped with SGL5003: force can never move a pixel it does not paint', () => {
    const bad = { ...neutralLight, id: 'bad-force', extends: 'neutral-light', tokens: {}, rules: {}, byShape: {}, byClass: {}, force: { padding: 40, stroke: '#000000' } } satisfies ThemeDoc;
    const { value, diagnostics } = resolveTheme(bad, lookup);
    expect(value.force).toEqual({ stroke: '#000000' });
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL5003']);
    expect(diagnostics[0]!.message).toContain('padding');
  });

  it('neutral-light, neutral-dark and high-contrast force nothing', () => {
    for (const id of ['neutral-light', 'neutral-dark', 'high-contrast']) expect(resolved(id).value.force ?? {}).toEqual({});
  });
});
