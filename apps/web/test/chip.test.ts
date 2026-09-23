import { diagnostic, NO_SPAN } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { deriveChipState } from '../src/state/chip.js';

const BASE = { crashed: false, layingOutVisible: false, diagnostics: [], offerFit: false };

describe('deriveChipState (DD-08 §11, §13)', () => {
  it('idle when nothing is happening', () => {
    expect(deriveChipState(BASE).kind).toBe('idle');
  });

  it('laying-out only when layingOutVisible is true', () => {
    expect(deriveChipState({ ...BASE, layingOutVisible: true }).kind).toBe('laying-out');
  });

  it('last-good with an error count when diagnostics carry an error', () => {
    const d = [diagnostic('SGL2001', NO_SPAN, { path: 'x', container: 'y' })];
    const state = deriveChipState({ ...BASE, diagnostics: d });
    expect(state.kind).toBe('last-good');
    expect(state.errorCount).toBe(1);
    expect(state.message).toBe('Showing last good render · 1 error');
  });

  it('pluralises the error count', () => {
    const d = [
      diagnostic('SGL2001', NO_SPAN, { path: 'x', container: 'y' }),
      diagnostic('SGL2004', NO_SPAN, { a: 'A', cycle: 'A' }),
    ];
    const state = deriveChipState({ ...BASE, diagnostics: d });
    expect(state.message).toBe('Showing last good render · 2 errors');
  });

  it('a warning-only diagnostic set does not trigger last-good (no error severity)', () => {
    const d = [diagnostic('SGL2003', NO_SPAN, { node: 'a', port: 'p' })]; // warning
    expect(deriveChipState({ ...BASE, diagnostics: d }).kind).toBe('idle');
  });

  it('SGL4001 wins over a generic error count', () => {
    const d = [
      diagnostic('SGL2001', NO_SPAN, { path: 'x', container: 'y' }),
      diagnostic('SGL4001', NO_SPAN, { id: 'sgl.grid', ms: 2000 }),
    ];
    const state = deriveChipState({ ...BASE, diagnostics: d });
    expect(state.kind).toBe('timeout');
    expect(state.message).toBe('Layout timed out — showing previous');
  });

  it('crashed wins over everything else', () => {
    const d = [diagnostic('SGL4001', NO_SPAN, { id: 'sgl.grid', ms: 2000 })];
    const state = deriveChipState({ crashed: true, layingOutVisible: true, diagnostics: d, offerFit: true });
    expect(state.kind).toBe('crashed');
    expect(state.message).toBe('Something went wrong rendering — your text is safe');
  });

  it('offerFit is independent of the chosen kind', () => {
    expect(deriveChipState({ ...BASE, offerFit: true }).offerFit).toBe(true);
    expect(deriveChipState({ ...BASE, layingOutVisible: true, offerFit: true }).offerFit).toBe(true);
  });
});
