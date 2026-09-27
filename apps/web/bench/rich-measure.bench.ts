import { compile, parse, resolve, type LabelId } from '@sgl/core';
import { parseInline } from '@sgl/core/inline';
import { CanvasMeasurer, premeasure } from '@sgl/measure';
import { labelBox, labelRunKey, plainText } from '@sgl/text';
import { layoutWrapped } from '@sgl/text/wrap';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph, type StyledGraph } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import '../src/fonts.css';
import { distinctTextStyles } from '../src/state/measure-styles.js';
import { scaleDocument } from '../../../bench/scale-document.js';

/**
 * DD-11 T56: the measurement cost of `n2000-rich` in Chromium — every label
 * ``**Node** `n${i}` ``, every tenth node wrapped at `@size.maxWidth: 90` — next
 * to the plain `n2000`, through `CanvasMeasurer` with `layoutWrapped`, as the
 * app measures once its `rich-text` chunk has loaded. Printed, **not gated**
 * (T56's budget: the pre-measure under 100 ms, inside DD-09 §2's 3 s
 * full-pipeline budget). Run with `pnpm bench:theme` (the `bench` project).
 */

const RUNS = 7;

function styledOf(source: string, inline: boolean): StyledGraph {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model, undefined, inline ? { inline: parseInline } : undefined);
  const theme = resolveTheme(neutralLight, (id) => BUILT_IN[id]).value;
  return styleGraph(graph, theme, model.classes).value;
}

const median = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const fmt = (xs: readonly number[]): string => `${median(xs).toFixed(1)} (${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)})`;

describe.skipIf(navigator.userAgent.includes('Firefox'))('DD-11 T56: n2000-rich measurement (Chromium, reported, not gated)', () => {
  it('parse, cold and warm pre-measure, against the plain n2000', async () => {
    const rich = scaleDocument(2000, { rich: true });
    const plain = scaleDocument(2000);
    const out: Record<string, number[]> = { parseInline: [], 'parse to styleGraph (rich)': [], 'premeasure cold (rich)': [], 'premeasure warm (rich)': [], 'premeasure cold (plain)': [], "render's lookups (labelBox for every label, labelRunKey for the boxed ones)": [] };

    // Fonts first, as the measure effect does (T28): the faces are not timed.
    const styledRich = styledOf(rich, true);
    await new CanvasMeasurer({ lineModel: layoutWrapped }).ready(distinctTextStyles(styledRich));

    // The labels as written (compiled without the parser: one literal run each).
    const labels = Object.values(styledOf(rich, false).graph.labels).map((l) => plainText(l.runs));
    for (let i = 0; i < RUNS; i += 1) {
      let t = performance.now();
      for (const l of labels) parseInline(l);
      out['parseInline']!.push(performance.now() - t);

      t = performance.now();
      const styled = styledOf(rich, true);
      out['parse to styleGraph (rich)']!.push(performance.now() - t);

      const measurer = new CanvasMeasurer({ lineModel: layoutWrapped });
      t = performance.now();
      const table = premeasure(styled, measurer);
      out['premeasure cold (rich)']!.push(performance.now() - t);
      // Every label measured; the wrapped ones on more than one line.
      expect(Object.keys(table).length).toBeGreaterThan(0);
      expect(table[labelRunKey(styled, 'l:g199.n1990' as LabelId)]!.lines.length).toBeGreaterThan(1);

      t = performance.now();
      premeasure(styled, measurer);
      out['premeasure warm (rich)']!.push(performance.now() - t);

      t = performance.now();
      for (const id of Object.keys(styled.graph.labels) as LabelId[]) if (labelBox(styled, id).maxWidth !== undefined) labelRunKey(styled, id);
      out["render's lookups (labelBox for every label, labelRunKey for the boxed ones)"]!.push(performance.now() - t);

      const styledPlain = styledOf(plain, false);
      t = performance.now();
      premeasure(styledPlain, new CanvasMeasurer());
      out['premeasure cold (plain)']!.push(performance.now() - t);
    }
    const line = Object.entries(out)
      .map(([k, v]) => `${k} ${fmt(v)}`)
      .join(' | ');
    console.log(`[A18-T56] n2000-rich, ${labels.length} labels (ms, median (min–max) of ${RUNS}) | ${line} | budget: premeasure cold < 100 ms (reported)`);
  });
});
