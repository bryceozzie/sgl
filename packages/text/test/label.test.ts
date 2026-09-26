import { describe, expect, it } from 'vitest';
import { compile, fnv1a64, labelMaxWidth, parse, resolve, type LabelId } from '@sgl/core';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph, type StyledGraph } from '@sgl/theme';
import { CODE_FONT_FAMILY, runStyle, STRONG_WEIGHT } from '../src/faces.js';
import { labelBox, labelRunKey, labelRuns, needsWrap, plainText, textStyleOf } from '../src/label.js';
import { canonicalRunKey, hashRuns, UNCONSTRAINED } from '../src/run-key.js';
import type { StyledRun, TextStyle } from '../src/types.js';

const BASE: TextStyle = { fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, fontStyle: 'normal', lineHeight: 1.3, letterSpacing: 0 };

function styledOf(src: string, inline?: Parameters<typeof compile>[2]): StyledGraph {
  const { model } = resolve(parse(src).ast);
  const { graph } = compile(model, undefined, inline);
  const theme = resolveTheme(neutralLight, (id) => BUILT_IN[id]).value;
  return styleGraph(graph, theme, model.classes).value;
}

describe('runStyle (DD-11 T25)', () => {
  it('a plain run keeps the base style object', () => {
    expect(runStyle(BASE, {})).toBe(BASE);
  });
  it('strong is weight 700, em is italic, and nothing else changes', () => {
    expect(runStyle(BASE, { strong: true })).toEqual({ ...BASE, fontWeight: STRONG_WEIGHT });
    expect(runStyle(BASE, { em: true })).toEqual({ ...BASE, fontStyle: 'italic' });
    expect(runStyle(BASE, { strong: true, em: true })).toEqual({ ...BASE, fontWeight: 700, fontStyle: 'italic' });
  });
  it('code is the upright mono family at 400, or 700 when also strong; em never slants it', () => {
    expect(runStyle(BASE, { code: true })).toEqual({ ...BASE, fontFamily: CODE_FONT_FAMILY, fontWeight: 400 });
    expect(runStyle({ ...BASE, fontStyle: 'italic' }, { code: true, em: true })).toEqual({ ...BASE, fontFamily: CODE_FONT_FAMILY, fontWeight: 400 });
    expect(runStyle(BASE, { code: true, strong: true })).toEqual({ ...BASE, fontFamily: CODE_FONT_FAMILY, fontWeight: 700 });
  });
  it('size, line height and letter spacing never change (T31)', () => {
    for (const m of [{ strong: true }, { em: true }, { code: true }] as const) {
      const s = runStyle({ ...BASE, letterSpacing: 1.5 }, m);
      expect([s.fontSize, s.lineHeight, s.letterSpacing]).toEqual([13, 1.3, 1.5]);
    }
  });
});

describe('hashRuns (DD-11 T29)', () => {
  /** The pre-A18 key function (`packages/measure/src/run-key.ts` at `33af6e7`). */
  const mvpKey = (runs: readonly StyledRun[], maxWidth?: number): string =>
    fnv1a64(
      `${runs.map((r) => [r.text, r.style.fontFamily, String(r.style.fontSize), String(r.style.fontWeight), r.style.fontStyle, String(r.style.lineHeight), String(r.style.letterSpacing)].join('\x1f')).join('\x1e')}\x1d${maxWidth === undefined ? '*' : String(maxWidth)}`,
    );

  it('a plain run keys exactly as before A18', () => {
    for (const runs of [[{ text: 'API', style: BASE }], [{ text: 'a\nb', style: BASE }], [{ text: 'x', style: BASE }, { text: 'y', style: { ...BASE, fontWeight: 700 } }]]) {
      expect(hashRuns(runs, UNCONSTRAINED)).toBe(mvpKey(runs));
      expect(hashRuns(runs, { maxWidth: 80.5 })).toBe(mvpKey(runs, 80.5));
    }
  });

  it('a run with marks appends ␟ and its letters s, e, c in that order', () => {
    const bold = { ...BASE, fontWeight: 700 };
    expect(canonicalRunKey([{ text: 'x', style: bold, marks: { em: true, strong: true, code: true } }], UNCONSTRAINED).endsWith('\x1fsec\x1d*')).toBe(true);
    // A strong run at base weight 700 has the plain run's style; the marks still split the keys.
    expect(hashRuns([{ text: 'x', style: bold, marks: { strong: true } }], UNCONSTRAINED)).not.toBe(hashRuns([{ text: 'x', style: bold }], UNCONSTRAINED));
  });

  it('the box is part of the key', () => {
    const runs = [{ text: 'x', style: BASE }];
    expect(hashRuns(runs, { maxWidth: 10 })).not.toBe(hashRuns(runs, UNCONSTRAINED));
    expect(hashRuns(runs, { maxWidth: 10, keepWords: true })).not.toBe(hashRuns(runs, { maxWidth: 10 }));
    expect(hashRuns(runs, { maxWidth: -0 })).toBe(hashRuns(runs, { maxWidth: 0 }));
  });
});

describe('labelRuns (DD-11 T25)', () => {
  it('gives each run its face and marks, and a plain run its label\'s style and no marks', () => {
    const inline = { inline: () => [{ text: 'a' }, { text: 'b', strong: true as const }, { text: 'c', code: true as const, em: true as const }] };
    const styled = styledOf('n: { @label: "x" }\n', inline);
    const base = textStyleOf(styled.labelStyles['l:n']);
    expect(labelRuns(styled, 'l:n' as LabelId)).toEqual([
      { text: 'a', style: base },
      { text: 'b', style: { ...base, fontWeight: 700 }, marks: { strong: true } },
      { text: 'c', style: { ...base, fontFamily: CODE_FONT_FAMILY, fontWeight: 400 }, marks: { em: true, code: true } },
    ]);
  });
  it('an unknown label has no runs', () => {
    expect(labelRuns(styledOf('a\n'), 'l:nope' as LabelId)).toEqual([]);
  });
  it('plainText concatenates, \\n included (T22)', () => {
    expect(plainText([{ text: 'a\n' }, { text: 'b' }])).toBe('a\nb');
  });
});

describe('labelBox (DD-11 T29, T35, T36)', () => {
  const box = (src: string, id = 'l:a') => labelBox(styledOf(src), id as LabelId);
  // neutral-light's node padding is [8, 12, 8, 12].
  it('nothing without @size.maxWidth or @size.width: the MVP behaviour', () => {
    expect(box('a\n')).toBe(UNCONSTRAINED);
    expect(box('a: { @size: { minWidth: 50, height: 90 } }\n')).toBe(UNCONSTRAINED);
  });
  it('maxWidth, less the horizontal padding, through labelMaxWidth', () => {
    expect(box('a: { @size: { maxWidth: 124 } }\n')).toEqual({ maxWidth: 100 });
    expect(box('a: { @shape: ellipse, @size: { maxWidth: 124 } }\n')).toEqual({ maxWidth: labelMaxWidth('ellipse', 124, [8, 12, 8, 12]) });
    expect(box('a: { @shape: diamond, @size: { maxWidth: 124 } }\n')).toEqual({ maxWidth: 50 });
  });
  it('a fixed width wraps too, at spaces only; the narrower of the two wins; splitting needs maxWidth (T36, human decision H1)', () => {
    expect(box('a: { @size: { width: 104 } }\n')).toEqual({ maxWidth: 80, keepWords: true });
    expect(box('a: { @size: { width: 104, maxWidth: 124 } }\n')).toEqual({ maxWidth: 80 });
    expect(box('a: { @size: { width: 204, maxWidth: 124 } }\n')).toEqual({ maxWidth: 100 });
  });
  it("a class's @size counts: DD-04 step 4 merges it (human decision H2)", () => {
    expect(box('@classes: { narrow: { @size: { maxWidth: 64 } } }\na: { @type: narrow }\n')).toEqual({ maxWidth: 40 });
  });
  it('a zero or negative width is ignored, and padding wider than the node gives 0', () => {
    expect(box('a: { @size: { maxWidth: 0 } }\n')).toBe(UNCONSTRAINED);
    expect(box('a: { @size: { maxWidth: 10 } }\n')).toEqual({ maxWidth: 0 });
  });
  it('edge labels never wrap: they have no @size', () => {
    const styled = styledOf('a: { @size: { maxWidth: 40 } }\nb\na -> b: "a long edge label"\n');
    const edgeLabel = Object.values(styled.graph.labels).find((l) => l.role === 'edge')!;
    expect(labelBox(styled, edgeLabel.id)).toBe(UNCONSTRAINED);
  });
  it('labelRunKey is hashRuns(labelRuns, labelBox), and needsWrap sees any box', () => {
    const styled = styledOf('a: { @size: { maxWidth: 124 } }\nb\n');
    expect(labelRunKey(styled, 'l:a' as LabelId)).toBe(hashRuns(labelRuns(styled, 'l:a' as LabelId), { maxWidth: 100 }));
    expect(needsWrap(styled)).toBe(true);
    expect(needsWrap(styledOf('a\nb\na -> b: "x"\n'))).toBe(false);
  });
});
