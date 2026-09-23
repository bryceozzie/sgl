import { describe, expect, it } from 'vitest';
import { diagnostic } from '@sgl/core';
import { toCmDiagnostic } from '../src/editor/diagnostics.js';

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

  it('carries the message through unchanged', () => {
    const d = diagnostic('SGL1003', { from: 0, to: 1 });
    expect(toCmDiagnostic(d).message).toBe(d.message);
  });
});
