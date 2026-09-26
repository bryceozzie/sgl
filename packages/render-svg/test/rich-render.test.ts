import { describe, expect, it } from 'vitest';
import type { LabelId } from '@sgl/core';
import { parseInline } from '@sgl/core/inline';
import { labelRunKey } from '@sgl/text';
import { neutralDark, neutralLight, type ThemeDoc } from '@sgl/theme';
import { render, renderPaintOnly, structureHash } from '../src/index.js';
import { runPipeline, type RenderedDoc } from './pipeline.js';

/**
 * A18's rendering (DD-11 T42–T48): `render(styled, layout, theme, text)` draws
 * each label on the lines the measure table gives it, with one nested
 * `<tspan class="r-…">` per marked fragment, three constant run rules emitted
 * only when used, and `structureHash` following the marks.
 */

const INLINE = { inline: parseInline };
const rich = (source: string, theme: ThemeDoc = neutralLight): Promise<RenderedDoc> => runPipeline(source, theme, undefined, {}, undefined, INLINE);

/** The inner markup of node `id`'s title `<text>`. */
function titleOf(svg: string, id: string): string {
  return new RegExp(`<g id="n-${id}"[^>]*>[^]*?<text [^>]*>([^]*?)</text>`).exec(svg)![1]!;
}

/** Its line tspans' inner markup. */
const linesOf = (svg: string, id: string): string[] => [...titleOf(svg, id).matchAll(/<tspan x="[^"]*" dy="[^"]*">((?:[^<]|<tspan class="[^"]*">[^<]*<\/tspan>)*)<\/tspan>/g)].map((m) => m[1]!);

const plain = (markup: string): string => markup.replace(/<[^>]*>/g, '');

const RUN_RULES = [
  '.r-em{font-style:italic}',
  ".r-code{font-family:'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-weight:400;font-style:normal}",
  '.r-strong{font-weight:700}',
];

describe('T42: render() draws the measured lines', () => {
  const WRAP = 'a: { @label: "Payments ledger reconciliation service", @size: { maxWidth: 150 } }\nb: "one\\ntwo"\n';

  it('a wrapped label is drawn on the lines the table gives it, whitespace at soft breaks dropped', async () => {
    const { styled, table, rendered } = await rich(WRAP);
    const entry = table[labelRunKey(styled, 'l:a' as LabelId)]!;
    expect(entry.lines.length).toBeGreaterThan(1);
    expect(linesOf(rendered.svg, 'a')).toEqual(entry.lines.map((l) => l.runs.map((r) => r.text).join('')));
    expect(linesOf(rendered.svg, 'b')).toEqual(['one', 'two']);
  });

  it('with no table, or on a miss, the label is split at its hard breaks, as before', async () => {
    const { styled, result, theme } = await rich(WRAP);
    for (const text of [undefined, {}]) {
      const svg = render(styled, result, theme, text).svg;
      expect(linesOf(svg, 'a')).toEqual(['Payments ledger reconciliation service']);
      expect(linesOf(svg, 'b')).toEqual(['one', 'two']);
    }
  });

  it('the vertical model is the renderer\'s own: 0.8 × fontSize to the first baseline, fontSize × lineHeight per line', async () => {
    const { rendered } = await rich(WRAP);
    const text = /<g id="n-a"[^]*?<text [^>]*y="([\d.]+)"[^>]*>([^]*?)<\/text>/.exec(rendered.svg)!;
    const dys = [...text[2]!.matchAll(/ dy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(dys[0]).toBe(0);
    for (const dy of dys.slice(1)) expect(dy).toBeCloseTo(13 * 1.3, 2);
  });
});

describe('T43: one nested tspan per marked fragment', () => {
  it('marks become r- classes, in the order strong, em, code; plain fragments are bare text', async () => {
    const { rendered } = await rich('a: "Plain **bold** and `code`"\nb: "***both*** *it* **`x`**"\n');
    expect(linesOf(rendered.svg, 'a')).toEqual(['Plain <tspan class="r-strong">bold</tspan> and <tspan class="r-code">code</tspan>']);
    expect(linesOf(rendered.svg, 'b')).toEqual(['<tspan class="r-strong r-em">both</tspan> <tspan class="r-em">it</tspan> <tspan class="r-strong r-code">x</tspan>']);
  });

  it('nested tspans carry no x, dy or dx, and marks run across a hard break', async () => {
    const { rendered } = await rich('a: "**Line one\\nLine two**"\n');
    expect(linesOf(rendered.svg, 'a')).toEqual(['<tspan class="r-strong">Line one</tspan>', '<tspan class="r-strong">Line two</tspan>']);
    expect(titleOf(rendered.svg, 'a')).not.toMatch(/<tspan class="[^"]*" (x|dy|dx)=/);
  });

  it('edge labels are drawn with their marks too', async () => {
    const { rendered } = await rich('a\nb\na -> b: "*async*"\n');
    expect(rendered.svg).toMatch(/<text class="el-text [^"]*"[^>]*><tspan x="[^"]*" dy="0"><tspan class="r-em">async<\/tspan><\/tspan><\/text>/);
  });
});

describe('T44: three constant run rules, emitted only when used, in a fixed order', () => {
  it('a document without marks gets none', async () => {
    const { rendered } = await rich('a: "plain"\nb: "2*3*4"\na -> b\n');
    expect(rendered.styleBlock).not.toContain('.r-');
  });

  it('only the rules some label uses, after every generated rule, in the order em, code, strong', async () => {
    const em = await rich('a: "*it*"\n');
    expect(em.rendered.styleBlock.split('\n').filter((l) => l.startsWith('.r-'))).toEqual([RUN_RULES[0]]);
    const all = await rich('a: "**b** `c`"\nb: "*i*"\n');
    const lines = all.rendered.styleBlock.split('\n');
    expect(lines.slice(-3)).toEqual(RUN_RULES);
    expect(lines.filter((l) => l.startsWith('.r-'))).toEqual(RUN_RULES);
  });

  it('a theme switch changes no run rule, and the paint-only path emits the same ones', async () => {
    const src = 'a: "**b** `c` *i*"\nb: "plain"\na -> b: "*e*"\n';
    const light = await rich(src, neutralLight);
    const dark = await rich(src, neutralDark);
    const runRules = (block: string): string[] => block.split('\n').filter((l) => l.startsWith('.r-'));
    expect(runRules(dark.rendered.styleBlock)).toEqual(runRules(light.rendered.styleBlock));
    const paintOnly = renderPaintOnly(light.rendered, dark.styled, light.result, light.table);
    expect(paintOnly).not.toBeNull();
    expect(paintOnly!.styleBlock).toBe(render(dark.styled, light.result, dark.theme, light.table).styleBlock);
    expect(paintOnly!.svg).toBe(render(dark.styled, light.result, dark.theme, light.table).svg);
  });
});

describe('T42 and T45: the paint-only guard follows the table and the marks', () => {
  it('renderPaintOnly refuses a different table object, however equal', async () => {
    const light = await rich('a: "**b**"\n', neutralLight);
    const dark = await rich('a: "**b**"\n', neutralDark);
    expect(renderPaintOnly(light.rendered, dark.styled, light.result, light.table)).not.toBeNull();
    expect(renderPaintOnly(light.rendered, dark.styled, light.result, { ...light.table })).toBeNull();
    expect(renderPaintOnly(light.rendered, dark.styled, light.result)).toBeNull();
  });

  it('structureHash changes on a marks-only edit, and not on a theme switch', async () => {
    const base = await rich('a: "**ab**"\nb\na -> b: "*e*"\n');
    for (const other of ['a: "*ab*"\nb\na -> b: "*e*"\n', 'a: "`ab`"\nb\na -> b: "*e*"\n', 'a: "ab"\nb\na -> b: "*e*"\n', 'a: "**ab**"\nb\na -> b: "**e**"\n', 'a: "**a**b"\nb\na -> b: "*e*"\n']) {
      const o = await rich(other);
      expect(o.rendered.structureHash, other).not.toBe(base.rendered.structureHash);
    }
    const dark = await rich('a: "**ab**"\nb\na -> b: "*e*"\n', neutralDark);
    expect(dark.rendered.structureHash).toBe(base.rendered.structureHash);
  });

  it('two labels whose runs split the same text differently hash differently', async () => {
    const one = await rich('a: "**a** **b**"\n');
    const two = await rich('a: "**a b**"\n');
    expect(structureHash(one.styled)).not.toBe(structureHash(two.styled));
  });
});

describe('T47 and T48: escaping and accessibility', () => {
  it('fragment text is escaped once; the aria-label is the plain text with breaks as spaces', async () => {
    const { rendered } = await rich('a: "**<b>&amp;** `\\"q\\"`\\n*x*"\n');
    expect(linesOf(rendered.svg, 'a')).toEqual(['<tspan class="r-strong">&lt;b&gt;&amp;amp;</tspan> <tspan class="r-code">&quot;q&quot;</tspan>', '<tspan class="r-em">x</tspan>']);
    expect(rendered.svg).toContain('aria-label="&lt;b&gt;&amp;amp; &quot;q&quot; x"');
    expect(plain(linesOf(rendered.svg, 'a').join(''))).not.toContain('**');
  });
});
