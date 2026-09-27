import { effect } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asNodeId, type LabelId } from '@sgl/core';
import { labelRunKey, layoutLines, StaticMetricsMeasurer } from '@sgl/measure';
import { render } from '@sgl/render-svg';
import { layoutWrapped } from '@sgl/text/wrap';
import type { RichText } from '../src/state/types.js';
import { createHarness } from './harness.js';

/**
 * A18's lazy `rich-text` chunk and its two boot-path gates (DD-11 T53), through
 * the real pipeline (`harness.ts`: real stages, `StaticMetricsMeasurer`, real
 * `grid`). The chunk is `src/state/rich-text.ts`; here it is loaded behind a
 * gate the test releases, as the network would.
 */

function lazyRichText() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failNext = false;
  const loadRichText = vi.fn(async (): Promise<RichText> => {
    if (failNext) {
      failNext = false;
      throw new Error('offline, and not cached');
    }
    await gate;
    return (await import('../src/state/rich-text.js')).richText;
  });
  return {
    loadRichText,
    release,
    failOnce() {
      failNext = true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Wide enough for its padding (neutral-light: 12 each side), narrow enough to
 *  wrap the label: the wrap width is 120 − 24 = 96. */
const WRAPPED = 'a: { @label: "one two three four five six", @size: { maxWidth: 120 } }\nb\na -> b\n';

describe('the rich-text chunk (DD-11 T53)', () => {
  it('a document with no * or ` in a label and no @size.maxWidth or width never loads it, across edits', async () => {
    const lazy = lazyRichText();
    const h = await createHarness('api: { @label: "Payments API" }\nsnake_case_name\napi -> snake_case_name: "writes to"\n', { loadRichText: lazy.loadRichText });
    h.setSource('api: { @label: "Payments API v2", @size: { minWidth: 40, height: 60 } }\nsnake_case_name\napi -> snake_case_name\n');
    await h.settle();
    expect(lazy.loadRichText).not.toHaveBeenCalled();
    expect(h.pipeline.lastGood.value).not.toBeNull();
    h.dispose();
  });

  it('a label to wrap holds measure and layout until the chunk has loaded, then is measured with layoutWrapped', async () => {
    const lazy = lazyRichText();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    const adopted: (number | undefined)[] = [];
    const stop = effect(() => {
      const good = h.pipeline.lastGood.value;
      if (good !== null) adopted.push(good.layout.nodes[asNodeId('a')]?.frame.w);
    });
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value).toBeNull();
    // Nothing of this document was measured: the stages below compile hold
    // their boot-time fallback, the empty document.
    expect(h.pipeline.table.value).toEqual({});
    expect(h.pipeline.pipelineError.value).toBeNull();

    lazy.release();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    expect(h.pipeline.lastGood.value).not.toBeNull();
    const styled = h.pipeline.lastGood.value!.styled;
    const measured = h.pipeline.table.value[labelRunKey(styled, 'l:a' as LabelId)]!;
    expect(measured.lines.length).toBeGreaterThan(1);
    expect(measured.width).toBeLessThanOrEqual(96);
    // Never a picture laid out with the unwrapped label.
    expect(adopted.length, JSON.stringify(adopted)).toBeGreaterThan(0);
    expect(adopted.every((w) => w !== undefined && w <= 120)).toBe(true);
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    stop();
    h.dispose();
  });

  it('the measure-table entry and the laid-out node agree end to end (the T2 seam)', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    await h.settle();
    const good = h.pipeline.lastGood.value!;
    const measured = h.pipeline.table.value[labelRunKey(good.styled, 'l:a' as LabelId)]!;
    const placement = good.layout.labels.find((l) => l.labelId === 'l:a')!;
    const frame = good.layout.nodes[asNodeId('a')]!.frame;
    // The label box the layout placed is the wrapped measurement (quantized
    // to 1/64 px), and the node is that box plus its padding: within maxWidth.
    expect(placement.frame.w).toBeCloseTo(measured.width, 1);
    expect(placement.frame.h).toBeCloseTo(measured.height, 1);
    expect(frame.w).toBeCloseTo(Math.max(72, measured.width + 24), 1);
    expect(frame.w).toBeLessThanOrEqual(120);
    expect(frame.h).toBeCloseTo(Math.max(36, measured.height + 16), 1);
    h.dispose();
  });

  it('a label style asking for a run face (weight over 600, or italic) loads the chunk without markup; 600 does not (fix round 1, item 5)', async () => {
    for (const [style, loads] of [['fontWeight: 700', true], ['fontStyle: italic', true], ['fontWeight: 600', false]] as const) {
      const lazy = lazyRichText();
      lazy.release();
      const h = await createHarness(`a: { @label: "Plain", @style: { ${style} } }\nb\n`, { loadRichText: lazy.loadRichText }, { firstRender: false });
      await h.settle();
      expect(lazy.loadRichText.mock.calls.length, style).toBe(loads ? 1 : 0);
      h.dispose();
    }
  });

  it('hands the measurer layoutWrapped once loaded, and loads once however many edits follow', async () => {
    const lazy = lazyRichText();
    const measurer = new (class extends StaticMetricsMeasurer {
      async ready(): Promise<void> {}
    })();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText, measurer }, { firstRender: false });
    expect(measurer.lineModel).toBe(layoutLines);
    lazy.release();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    expect(measurer.lineModel).toBe(layoutWrapped);
    h.setSource(WRAPPED.replace('six', 'six seven'));
    await h.settle();
    h.setSource(WRAPPED.replace('six', 'six seven eight'));
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value!.styled.graph.labels['l:a' as LabelId]!.runs[0]!.text).toContain('eight');
    h.dispose();
  });

  it('markup in a label holds compile until the chunk has loaded, then compiles with the parser (the markup gate)', async () => {
    const lazy = lazyRichText();
    const h = await createHarness('a: "**Payments** `v2`"\nb: "2 * 3"\na -> b\n', { loadRichText: lazy.loadRichText }, { firstRender: false });
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value).toBeNull();
    lazy.release();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    const good = h.pipeline.lastGood.value!;
    expect(good.styled.graph.labels['l:a' as LabelId]!.runs).toEqual([{ text: 'Payments', strong: true }, { text: ' ' }, { text: 'v2', code: true }]);
    expect(good.styled.graph.labels['l:b' as LabelId]!.runs).toEqual([{ text: '2 * 3' }]);
    // The marks are drawn as nested run tspans (DD-11 T43), the markers gone.
    expect(good.svg).toContain('<tspan class="r-strong">Payments</tspan> <tspan class="r-code">v2</tspan></tspan>');
    expect(good.styleBlock).toContain('.r-strong{font-weight:700}');
    expect(good.svg).not.toContain('**');
    h.dispose();
  });

  it('a wrapped label is drawn on exactly the lines it was measured and laid out with (T42, through the app)', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    await h.settle();
    const good = h.pipeline.lastGood.value!;
    const measured = h.pipeline.table.value[labelRunKey(good.styled, 'l:a' as LabelId)]!;
    // Settled, the landed layout was sized from the latest table: one object.
    expect(good.paintPlan.text).toBe(h.pipeline.table.value);
    const text = /<g id="n-a"[^]*?<text [^>]*>([^]*?)<\/text>/.exec(good.svg)![1]!;
    const lines = [...text.matchAll(/<tspan x="[^"]*" dy="[^"]*">([^<]*)<\/tspan>/g)].map((m) => m[1]);
    expect(lines).toEqual(measured.lines.map((l) => l.runs.map((r) => r.text).join('')));
    expect(lines.length).toBeGreaterThan(1);
    h.dispose();
  });

  /**
   * Fix round 1, item 1 (the orchestrator's decision): between an edit's
   * pre-measure and its layout, a render draws a label found in the table the
   * landed layout was sized from from that table, and a label missing there
   * (the edited one) from the latest table, never on one unwrapped line. The
   * measurer halves the wrap width after the first pre-measure, so the two
   * tables hold different lines for the same key and the test can tell which
   * one a label was drawn from. The layout debounce is never fired: the edit's
   * layout stays pending while the theme switch renders.
   */
  it('before an edit\'s layout lands: an unchanged label draws from the landed layout\'s table, an edited one from the latest table', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const measurer = new (class extends StaticMetricsMeasurer {
      narrow = false;
      async ready(): Promise<void> {}
      layoutRuns(runs: Parameters<StaticMetricsMeasurer['layoutRuns']>[0], box: Parameters<StaticMetricsMeasurer['layoutRuns']>[1]) {
        return super.layoutRuns(runs, this.narrow && box.maxWidth !== undefined ? { maxWidth: box.maxWidth / 2 } : box);
      }
    })();
    const DOC = 'a: { @label: "alpha beta gamma delta epsilon zeta", @size: { maxWidth: 200 } }\nb: { @label: "one two three four five six seven", @size: { maxWidth: 200 } }\na -> b\n';
    const h = await createHarness(DOC, { loadRichText: lazy.loadRichText, measurer, defaultThemeId: 'neutral-light' }, { firstRender: false });
    await h.settle();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    const landed = h.pipeline.table.value;
    expect(h.pipeline.lastGood.value).not.toBeNull();
    const linesOf = (svg: string, id: string): string[] => {
      const text = new RegExp(`<g id="n-${id}"[^]*?<text [^>]*>([^]*?)</text>`).exec(svg)![1]!;
      return [...text.matchAll(/<tspan x="[^"]*" dy="[^"]*">([^<]*)<\/tspan>/g)].map((m) => m[1]!);
    };
    const tableLines = (table: typeof landed, styled: Parameters<typeof labelRunKey>[0], id: string): string[] =>
      table[labelRunKey(styled, `l:${id}` as LabelId)]!.lines.map((l) => l.runs.map((r) => r.text).join(''));

    measurer.narrow = true;
    h.setSource(DOC.replace('seven', 'seven eight nine'));
    // The pre-measure lands (its `ready()` resolves on a microtask); the layout
    // debounce is left pending, so `layout` is still the landed one.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = h.pipeline.table.value;
    expect(latest).not.toBe(landed);
    h.pipeline.themeId.value = 'neutral-dark';
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    const good = h.pipeline.lastGood.value!;
    expect(good.styled.themeId).toBe('neutral-dark');
    expect(good.styled.graph.labels['l:b' as LabelId]!.runs[0]!.text).toContain('nine');
    // The unchanged label: the landed table's lines, not the latest table's (narrower) ones.
    expect(tableLines(landed, good.styled, 'a')).not.toEqual(tableLines(latest, good.styled, 'a'));
    expect(linesOf(good.svg, 'a')).toEqual(tableLines(landed, good.styled, 'a'));
    // The edited label is not in the landed table: the latest table's lines, not one long line.
    expect(landed[labelRunKey(good.styled, 'l:b' as LabelId)]).toBeUndefined();
    expect(linesOf(good.svg, 'b')).toEqual(tableLines(latest, good.styled, 'b'));
    expect(linesOf(good.svg, 'b').length).toBeGreaterThan(1);
    h.dispose();
  });

  it('an edit that changes no boxed label costs one render, not a second one when its table lands', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    const before = h.lastGoodWrites();
    h.setSource(`// a comment\n${WRAPPED}`);
    await h.settle();
    expect(h.lastGoodWrites() - before).toBe(1);
    h.dispose();
  });

  it('a theme switch on a rich document keeps the element tree: paint only, exactly a full render (T57)', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness('a: { @label: "**Pay** *ledger* `svc` and more words", @size: { maxWidth: 100 } }\nb\na -> b: "*async*"\n', { loadRichText: lazy.loadRichText, defaultThemeId: 'neutral-light' }, { firstRender: false });
    await h.settle();
    const before = h.pipeline.lastGood.value!;
    expect(before.svg).toContain('class="r-em"');
    h.pipeline.themeId.value = 'neutral-dark';
    await h.settle();
    const after = h.pipeline.lastGood.value!;
    expect(after.styled.themeId).toBe('neutral-dark');
    expect(after.paintPlan).toBe(before.paintPlan);
    expect(after.svg).toBe(render(after.styled, after.layout, h.pipeline.theme.peek().value, h.pipeline.table.value).svg);
    h.dispose();
  });

  it('once loaded, a later document is compiled with the parser without holding again', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness('a: "*x*"\n', { loadRichText: lazy.loadRichText }, { firstRender: false });
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    h.setSource('a: "**y**"\n');
    await h.settle();
    expect(h.pipeline.lastGood.value!.styled.graph.labels['l:a' as LabelId]!.runs).toEqual([{ text: 'y', strong: true }]);
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('a failed load degrades instead of holding: plain runs, no wrapping, one SGL6002 warning; retried on the next change, not in a loop (fix round 1, item 2)', async () => {
    const lazy = lazyRichText();
    lazy.failOnce();
    lazy.release();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const src = `${WRAPPED}m: "**Payments** \`v2\`"\n`;
    const h = await createHarness(src, { loadRichText: lazy.loadRichText }, { firstRender: false });
    await lazy.loadRichText.mock.results[0]!.value.catch(() => undefined);
    await h.settle();
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    // The picture is not frozen: it renders, degraded.
    const good = h.pipeline.lastGood.value!;
    expect(good).not.toBeNull();
    expect(h.pipeline.pipelineError.value).toBeNull();
    expect(h.pipeline.diags.value.map((d) => `${d.code} ${d.severity}`)).toEqual(['SGL6002 warning']);
    // Plain runs: the markers stay literal text.
    expect(good.styled.graph.labels['l:m' as LabelId]!.runs).toEqual([{ text: '**Payments** `v2`' }]);
    // No wrapping: the box is ignored, so the label is one line, keyed as usual.
    expect(h.pipeline.table.value[labelRunKey(good.styled, 'l:a' as LabelId)]!.lines).toHaveLength(1);

    // The next change of the document tries again, and this time it loads.
    h.setSource(`${src}c\n`);
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(2);
    await lazy.loadRichText.mock.results[1]!.value;
    await h.settle();
    const after = h.pipeline.lastGood.value!;
    expect(h.pipeline.diags.value).toEqual([]);
    expect(after.styled.graph.labels['l:m' as LabelId]!.runs).toEqual([{ text: 'Payments', strong: true }, { text: ' ' }, { text: 'v2', code: true }]);
    expect(h.pipeline.table.value[labelRunKey(after.styled, 'l:a' as LabelId)]!.lines.length).toBeGreaterThan(1);
    h.dispose();
  });
});
