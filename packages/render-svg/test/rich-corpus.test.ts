import { describe, expect, it } from 'vitest';
import { asNodeId, type LabelId } from '@sgl/core';
import { parseInline } from '@sgl/core/inline';
import type { LayoutEngine } from '@sgl/layout-api';
import { elkEngine } from '@sgl/layout-elk';
import { gridEngine } from '@sgl/layout-std';
import { labelRunKey } from '@sgl/text';
import { neutralLight } from '@sgl/theme';
import { corpusSource, runPipeline } from './pipeline.js';

/**
 * The corpus documents that hold markdown or wrap, through the **rich** pipeline:
 * compile with the inline parser (`@sgl/core/inline`), measure with
 * `layoutWrapped` — what the app runs once its `rich-text` chunk has loaded
 * (DD-11 T53). Their goldens are new with A18 (T58): the compile graph, and the
 * `grid` and `elk` layouts. Their render goldens come with the render branch,
 * which draws marks and soft breaks (T42–T47); until then the renderer's output
 * for them is pinned below by what it is: plain hard lines.
 *
 * The suites over `CLEAN_DOCS` keep compiling without the parser, which is what
 * every existing golden has always pinned; `markdown-scan.test.ts` proves the two
 * compile every other document identically.
 */

const RICH_DOCS = ['multiline.sgl', 'text/markdown.sgl', 'text/wrap.sgl'];
const ENGINES: readonly LayoutEngine[] = [gridEngine, elkEngine];
const INLINE = { inline: parseInline };
const rich = (doc: string, engine: LayoutEngine = gridEngine) => runPipeline(corpusSource(doc), neutralLight, engine, {}, undefined, INLINE);
const golden = (doc: string): string => doc.replace('/', '__');

describe('the rich pipeline over the markdown and wrap documents (DD-11 T58)', () => {
  for (const doc of RICH_DOCS) {
    it(`${doc}: clean, every label pre-measured, and its compile golden`, async () => {
      const { styled, table, diagnostics } = await rich(doc);
      expect(diagnostics).toEqual([]);
      for (const labelId of Object.keys(styled.graph.labels) as LabelId[]) expect(table[labelRunKey(styled, labelId)], labelId).toBeDefined();
      await expect(`${JSON.stringify(styled.graph, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/rich/compile/${golden(doc)}.json`);
    });

    for (const engine of ENGINES) {
      it(`${doc}: ${engine.id} layout golden`, async () => {
        const { result } = await rich(doc, engine);
        await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/rich/${engine.id}/${golden(doc)}.json`);
      });
    }

    it(`${doc}: two runs give byte-identical tables, layouts and SVG (DD-00 §3)`, async () => {
      const a = await rich(doc, elkEngine);
      const b = await rich(doc, elkEngine);
      expect(JSON.stringify(b.table)).toBe(JSON.stringify(a.table));
      expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
      expect(b.rendered.svg).toBe(a.rendered.svg);
    });
  }

  it('wrap.sgl: every node with @size stays within its width, under both engines', async () => {
    const widths: Record<string, number> = { rect: 150, round: 150, ellipse: 150, diamond: 200, hexagon: 200, cylinder: 150, fixed: 110, mixed: 130, breaks: 120, 'group.inner': 110 };
    for (const engine of ENGINES) {
      const { result, table, styled } = await rich('text/wrap.sgl', engine);
      for (const [id, max] of Object.entries(widths)) {
        expect(result.nodes[asNodeId(id)]!.frame.w, `${engine.id} ${id}`).toBeLessThanOrEqual(max + 1 / 64);
        expect(table[labelRunKey(styled, `l:${id}` as LabelId)]!.lines.length, id).toBeGreaterThan(1);
      }
      // A single unit wider than the wrap width overflows, as T39 allows: the
      // overlong word is split, and no line is empty.
      const overlong = table[labelRunKey(styled, 'l:overlong' as LabelId)]!;
      expect(overlong.lines.length).toBeGreaterThan(1);
      expect(overlong.lines.map((l) => l.runs.map((r) => r.text).join('')).join('')).toBe('Supercalifragilisticexpialidocious');
      // CJK fills lines and breaks between ideographs; a ZWJ sequence is never split.
      const cjk = table[labelRunKey(styled, 'l:cjk' as LabelId)]!;
      expect(cjk.lines.length).toBeGreaterThan(1);
      for (const line of table[labelRunKey(styled, 'l:zwj' as LabelId)]!.lines) {
        const text = line.runs.map((r) => r.text).join('');
        expect(text.startsWith('‍') || text.endsWith('‍')).toBe(false);
      }
    }
  });

  it('markdown.sgl: until the render branch, a label\'s runs are drawn as plain text, markers removed (DD-11 T42–T47 are branch 3)', async () => {
    const { rendered, styled } = await rich('text/markdown.sgl');
    const tspans = (id: string): string[] => {
      const g = new RegExp(`<g id="n-${id}"[^]*?<text [^>]*>([^]*?)</text>`).exec(rendered.svg)![1]!;
      return [...g.matchAll(/<tspan x="[^"]*" dy="[^"]*">([^<]*)<\/tspan>/g)].map((m) => m[1]!);
    };
    expect(styled.graph.labels['l:bold' as LabelId]!.runs).toEqual([{ text: 'bold', strong: true }]);
    expect(tspans('bold')).toEqual(['bold']);
    expect(tspans('codeIn')).toEqual(['see x']);
    expect(tspans('intraword')).toEqual(['a*b*c and 2*3*4']);
    expect(tspans('lines')).toEqual(['Line one', 'Line two']);
    expect(tspans('block')).toEqual(['Payments API', 'handles POST /pay']);
    // No run classes and no nested tspans yet.
    expect(rendered.svg).not.toMatch(/r-strong|r-em|r-code|<tspan class/);
  });
});
