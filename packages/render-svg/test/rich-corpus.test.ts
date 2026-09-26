import { describe, expect, it } from 'vitest';
import { asNodeId, type LabelId } from '@sgl/core';
import type { LayoutEngine } from '@sgl/layout-api';
import { elkEngine } from '@sgl/layout-elk';
import { gridEngine } from '@sgl/layout-std';
import { glyphCount, labelBox, labelRunKey } from '@sgl/text';
import { BUILT_IN, neutralDark, neutralLight, type ThemeDoc } from '@sgl/theme';
import { nodeElementId } from '../src/security.js';
import { corpusSource, INLINE, runPipeline } from './pipeline.js';

/**
 * The corpus documents that hold markdown or wrap, through the **rich** pipeline:
 * compile with the inline parser (`@sgl/core/inline`), measure with
 * `layoutWrapped` — what the app runs once its `rich-text` chunk has loaded
 * (DD-11 T53). Their goldens are new with A18 (T58): the compile graph, the
 * `grid` and `elk` layouts, and (the render branch, T42–T47) the render under
 * every built-in theme, with marks drawn as nested run tspans and wrapped
 * labels on their measured lines. The seam oracle below checks that what is
 * drawn is what was measured and laid out.
 *
 * The suites over `CLEAN_DOCS` keep compiling without the parser, which is what
 * every existing golden has always pinned; `markdown-scan.test.ts` proves the two
 * compile every other document identically.
 */

const RICH_DOCS = ['multiline.sgl', 'text/markdown.sgl', 'text/wrap.sgl'];
const ENGINES: readonly LayoutEngine[] = [gridEngine, elkEngine];
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


  it('markdown.sgl: marks are drawn as nested run tspans, and the markers are gone (DD-11 T43)', async () => {
    const { rendered, styled } = await rich('text/markdown.sgl');
    const tspans = (id: string): string[] => {
      const g = new RegExp(`<g id="n-${id}"[^]*?<text [^>]*>([^]*?)</text>`).exec(rendered.svg)![1]!;
      return [...g.matchAll(LINE)].map((m) => m[1]!);
    };
    expect(styled.graph.labels['l:bold' as LabelId]!.runs).toEqual([{ text: 'bold', strong: true }]);
    expect(tspans('bold')).toEqual(['<tspan class="r-strong">bold</tspan>']);
    expect(tspans('codeIn')).toEqual(['<tspan class="r-em">see </tspan><tspan class="r-em r-code">x</tspan>']);
    expect(tspans('intraword')).toEqual(['a*b*c and 2*3*4']);
    expect(tspans('lines')).toEqual(['<tspan class="r-strong">Line one</tspan>', '<tspan class="r-strong">Line two</tspan>']);
    expect(tspans('block')).toEqual(['<tspan class="r-strong">Payments API</tspan>', 'handles <tspan class="r-code">POST /pay</tspan>']);
  });
});

/** A line `<tspan x dy>` holding text and flat run tspans, and nothing else. */
const LINE = /<tspan x="[^"]*" dy="[^"]*">((?:[^<]|<tspan class="[^"]*">[^<]*<\/tspan>)*)<\/tspan>/g;

const THEMES: readonly ThemeDoc[] = [neutralLight, neutralDark, BUILT_IN['high-contrast']!, BUILT_IN['print']!];

describe('the rich documents\' render goldens, under every built-in theme (DD-11 T58)', () => {
  for (const doc of RICH_DOCS) {
    for (const theme of THEMES) {
      it(`${doc} under ${theme.id}`, async () => {
        const { rendered } = await runPipeline(corpusSource(doc), theme, gridEngine, {}, undefined, INLINE);
        await expect(`${rendered.svg}\n`).toMatchFileSnapshot(`./__goldens__/rich/render/${theme.id}/${golden(doc)}.svg`);
      });
    }
  }
});

/**
 * The seam (A18): what `render()` draws is what was measured and laid out.
 * For every label of every rich document, under both engines: the `<text>`
 * holds exactly the table entry's lines, in order, each a line tspan whose
 * fragments carry exactly the entry's marks as flat, unpositioned run tspans;
 * every line fits the wrap width (`labelBox`) unless it is one unbreakable
 * unit (T37); and the placement frame the engine gave the label holds the
 * entry's size (T39).
 */
describe('the seam: render() draws exactly the measured and laid-out lines', () => {
  const unescape = (s: string): string => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const classOf = (m: { strong?: true; em?: true; code?: true } | undefined): string => [m?.strong && 'r-strong', m?.em && 'r-em', m?.code && 'r-code'].filter(Boolean).join(' ');

  for (const doc of [...RICH_DOCS, 'injection/markdown-in-label.sgl']) {
    for (const engine of ENGINES) {
      it(`${doc} under ${engine.id}`, async () => {
        const { styled, table, result, rendered } = await rich(doc, engine);
        const svg = rendered.svg;
        const edgeLabels = [...svg.slice(svg.indexOf('<g class="L-labels">')).matchAll(/<g class="el"[^>]*>[^]*?<text [^>]*>([^]*?)<\/text><\/g>/g)].map((m) => m[1]!);
        let nextEdgeLabel = 0;
        let checked = 0;
        const texts = new Map<string, string>();
        for (const edge of styled.graph.edges) if (edge.labelId !== null && result.edges[edge.id] !== undefined) texts.set(edge.labelId, edgeLabels[nextEdgeLabel++]!);
        for (const [id, node] of Object.entries(styled.graph.nodes)) {
          if (node.labelId === null || node.hidden) continue;
          texts.set(node.labelId, new RegExp(`<g id="${nodeElementId(id).replace(/[.]/g, '\\.')}"[^>]*>[^]*?<text [^>]*>([^]*?)</text>`).exec(svg)![1]!);
        }
        expect(nextEdgeLabel).toBe(edgeLabels.length);

        for (const [labelId, inner] of texts) {
          const entry = table[labelRunKey(styled, labelId as LabelId)]!;
          const box = labelBox(styled, labelId as LabelId);
          const lines = [...inner.matchAll(LINE)];
          // Nothing outside the line tspans, and nothing nested deeper.
          expect(lines.map((m) => m[0]).join(''), labelId).toBe(inner);
          expect(lines.length, labelId).toBe(entry.lines.length);
          entry.lines.forEach((line, i) => {
            const drawn = [...lines[i]![1]!.matchAll(/<tspan class="([^"]*)">([^<]*)<\/tspan>|([^<]+)/g)].map((m) => [m[1] ?? '', unescape(m[2] ?? m[3]!)]);
            const measured = line.runs.filter((r) => r.text !== '').map((r) => [classOf(r.marks), r.text]);
            expect(drawn, `${labelId} line ${i}`).toEqual(measured);
            if (box.maxWidth !== undefined && glyphCount(line.runs.map((r) => r.text).join('')) > 1) expect(line.width, `${labelId} line ${i}`).toBeLessThanOrEqual(box.maxWidth);
          });
          const placement = result.labels.find((p) => p.labelId === labelId)!;
          // The engine may give the label a larger frame (elk does, for a cylinder), never a smaller one.
          expect(placement.frame.w, labelId).toBeGreaterThanOrEqual(entry.width - 1 / 64);
          expect(placement.frame.h, labelId).toBeGreaterThanOrEqual(entry.height - 1 / 64);
          checked += 1;
        }
        expect(checked).toBe(Object.keys(styled.graph.labels).length);
      });
    }
  }
});
