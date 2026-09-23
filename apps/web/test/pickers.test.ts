import { describe, expect, it } from 'vitest';
import { engineOptionsFor, themeOptions } from '../src/state/pickers.js';

describe('themeOptions (DD-08 §10)', () => {
  it('lists both built-in themes, sorted by id, with a 4-colour swatch', () => {
    const options = themeOptions('neutral-light');
    expect(options.map((o) => o.id)).toEqual(['neutral-dark', 'neutral-light']);
    for (const o of options) {
      expect(o.swatch.bg).toMatch(/^#/);
      expect(o.swatch.surface).toMatch(/^#/);
      expect(o.swatch.ink).toMatch(/^#/);
      expect(o.swatch.accent).toMatch(/^#/);
    }
  });

  it('marks exactly the effective theme as selected', () => {
    const options = themeOptions('neutral-dark');
    expect(options.find((o) => o.id === 'neutral-dark')?.selected).toBe(true);
    expect(options.find((o) => o.id === 'neutral-light')?.selected).toBe(false);
  });

  it('the two built-in themes have different swatches', () => {
    const [dark, light] = themeOptions('neutral-light');
    expect(dark!.swatch.bg).not.toBe(light!.swatch.bg);
  });
});

describe('engineOptionsFor (DD-08 §10)', () => {
  const grid = { id: 'sgl.grid', name: 'Grid', determinism: 'bitwise' as const };
  const elk = { id: 'sgl.elk', name: 'ELK', determinism: 'quantized' as const };

  it('lists the registered engines, sorted by id, with the determinism badge', () => {
    const options = engineOptionsFor([elk, grid], 'sgl.grid');
    expect(options.map((o) => o.id)).toEqual(['sgl.elk', 'sgl.grid']);
    expect(options.find((o) => o.id === 'sgl.grid')?.determinism).toBe('bitwise');
  });

  it('marks exactly the effective engine as selected', () => {
    const options = engineOptionsFor([grid], 'sgl.grid');
    expect(options[0]?.selected).toBe(true);
  });

  it('a single registered engine (today: only grid) is still listed correctly', () => {
    const options = engineOptionsFor([grid], 'sgl.grid');
    expect(options).toHaveLength(1);
    expect(options[0]?.name).toBe('Grid');
  });
});
