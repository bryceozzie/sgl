import { describe, expect, it } from 'vitest';
import { diagnostic } from '@sgl/core';
import { clampSpan, toCmDiagnostic } from '../src/editor/diagnostics.js';

describe('toCmDiagnostic (DD-08 §4)', () => {
  it('maps span.from/to to from/to verbatim (already offsets, no conversion)', () => {
    const d = diagnostic('SGL1003', { from: 12, to: 19 });
    const cm = toCmDiagnostic(d);
    expect(cm.from).toBe(12);
    expect(cm.to).toBe(19);
  });

  it.each([
    ['error', 'error'],
    ['warning', 'warning'],
    ['info', 'info'],
  ] as const)('maps severity %s -> %s verbatim', (sglSeverity, cmSeverity) => {
    // SGL2005 is 'info', SGL2003 is 'warning', SGL1003 is 'error' — one real
    // catalogue code per severity rather than a hand-built Diagnostic, so this
    // also pins which codes carry which severity.
    const code = sglSeverity === 'error' ? 'SGL1003' : sglSeverity === 'warning' ? 'SGL2003' : 'SGL2005';
    const d = diagnostic(code, { from: 0, to: 1 }, code === 'SGL2003' ? { node: 'a', port: 'p' } : code === 'SGL2005' ? { key: 'x' } : {});
    expect(toCmDiagnostic(d).severity).toBe(cmSeverity);
  });

  // Fix round 1, item 2: CodeMirror throws a RangeError for a position outside
  // the document, so every span is clamped to it before it is dispatched.
  it.each([
    [{ from: 12, to: 19 }, 100, { from: 12, to: 19 }],
    [{ from: -1e15, to: 1.5 }, 100, { from: 0, to: 1 }],
    [{ from: 5, to: 1 }, 100, { from: 5, to: 5 }],
    [{ from: 90, to: 1e15 }, 20, { from: 20, to: 20 }],
    [{ from: Number.NaN, to: Number.POSITIVE_INFINITY }, 20, { from: 0, to: 20 }],
    [{ from: 3, to: 7 }, 0, { from: 0, to: 0 }],
  ])('clampSpan(%o, %i) is %o', (span, length, expected) => {
    expect(clampSpan(span, length)).toEqual(expected);
  });

  it('toCmDiagnostic clamps to the document length it is given', () => {
    const d = diagnostic('SGL1003', { from: 40, to: 1e12 });
    expect(toCmDiagnostic(d, 30)).toMatchObject({ from: 30, to: 30 });
  });

  it('carries the message through unchanged', () => {
    const d = diagnostic('SGL1003', { from: 0, to: 1 });
    expect(toCmDiagnostic(d).message).toBe(d.message);
  });
});
