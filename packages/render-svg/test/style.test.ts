import type { ComputedStyle, ResolvedTheme } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { buildStyleBlock, buildTokenBlock, ClassTable, geometryDeclarations, paintDeclarations } from '../src/style.js';

function style(paint: Readonly<Record<string, unknown>>, geometry: Readonly<Record<string, unknown>> = {}): ComputedStyle {
  return { paint, geometry, paintHash: 'p1', geometryHash: 'g1' } as ComputedStyle;
}

describe('paintDeclarations()', () => {
  it('shape: fill, opacity, stroke, stroke-dasharray', () => {
    const decls = paintDeclarations({ fill: '#fff', opacity: 0.5, stroke: '#000', strokeDash: [4, 2] }, 'shape');
    expect(decls).toEqual(['fill:#fff', 'opacity:0.5', 'stroke:#000', 'stroke-dasharray:4 2']);
  });

  it('text: fill (from color) and opacity only', () => {
    expect(paintDeclarations({ color: '#111', opacity: 1 }, 'text')).toEqual(['fill:#111', 'opacity:1']);
  });

  it('plate: fill from labelPlate, "none" emits nothing', () => {
    expect(paintDeclarations({ labelPlate: '#eee' }, 'plate')).toEqual(['fill:#eee']);
    expect(paintDeclarations({ labelPlate: 'none' }, 'plate')).toEqual([]);
    expect(paintDeclarations({}, 'plate')).toEqual([]);
  });

  it('omits a property that is absent rather than emitting an empty declaration', () => {
    expect(paintDeclarations({}, 'shape')).toEqual([]);
  });

  it('strokeDash: solid/none are not a dash array', () => {
    expect(paintDeclarations({ strokeDash: 'solid' }, 'shape')).toEqual([]);
  });
});

describe('geometryDeclarations()', () => {
  it('shape: stroke-width only, in px', () => {
    expect(geometryDeclarations({ strokeWidth: 1.5 }, 'shape')).toEqual(['stroke-width:1.5px']);
  });

  it('text: font-family, font-size, font-style, font-weight, letter-spacing', () => {
    const decls = geometryDeclarations(
      { fontFamily: 'Inter, sans-serif', fontSize: 13, fontStyle: 'italic', fontWeight: 500, letterSpacing: 0.2 },
      'text',
    );
    expect(decls).toEqual([
      'font-family:Inter, sans-serif',
      'font-size:13px',
      'font-style:italic',
      'font-weight:500',
      'letter-spacing:0.2px',
    ]);
  });
});

describe('ClassTable', () => {
  it('shapeClasses returns "g-<hash> s-<paintHash>" style pair, geometry first', () => {
    const t = new ClassTable();
    const cls = t.shapeClasses(style({ fill: '#fff' }, { strokeWidth: 1 }));
    expect(cls).toMatch(/^g-\S+ s-p1$/);
  });

  it('a style with no declarations in a half contributes no class for that half', () => {
    const t = new ClassTable();
    const cls = t.shapeClasses(style({}, {}));
    expect(cls).toBe('');
  });

  it('two identical styles share one class (dedup by declarations/hash)', () => {
    const t = new ClassTable();
    const a = t.shapeClasses(style({ fill: '#fff' }));
    const b = t.shapeClasses(style({ fill: '#fff' }));
    expect(a).toBe(b);
    expect(t.emit()).toHaveLength(1);
  });

  it('two elements with the same geometryHash but different emitted geometry declarations get different classes (keyed by declarations, not geometryHash)', () => {
    const t = new ClassTable();
    const a = t.shapeClasses({ paint: {}, geometry: { strokeWidth: 1 }, paintHash: 'p', geometryHash: 'same' } as ComputedStyle);
    const b = t.shapeClasses({ paint: {}, geometry: { strokeWidth: 2 }, paintHash: 'p', geometryHash: 'same' } as ComputedStyle);
    expect(a).not.toBe(b);
  });

  it('emit() is sorted by class name regardless of discovery order', () => {
    const t1 = new ClassTable();
    t1.shapeClasses(style({ fill: '#111' }));
    t1.textClasses(style({ color: '#222' }));

    const t2 = new ClassTable();
    t2.textClasses(style({ color: '#222' }));
    t2.shapeClasses(style({ fill: '#111' }));

    expect(t1.emit()).toEqual(t2.emit());
  });

  it('plateClasses carries no geometry component', () => {
    const t = new ClassTable();
    const cls = t.plateClasses(style({ labelPlate: '#eee' }, { strokeWidth: 99 }));
    expect(cls).toBe('p-p1');
  });
});

describe('buildStyleBlock() / buildTokenBlock() (F17, DD-07 §6)', () => {
  const theme = {
    tokens: { 'surface.sunken': '#f0f0f0', 'font.sans': 'Inter, sans-serif' },
  } as unknown as ResolvedTheme;

  it('the main block is .canvas with its literal colour, the fixed preamble, then generated rules, in that order', () => {
    const block = buildStyleBlock('#ffffff', ['.s-1{fill:#fff}']);
    const lines = block.split('\n');
    expect(lines[0]).toBe('.canvas{fill:#ffffff}');
    expect(lines[lines.length - 1]).toBe('.s-1{fill:#fff}');
  });

  it('the main block declares no custom property and reads none with var()', () => {
    const block = buildStyleBlock('#ffffff', ['.s-1{fill:#fff}']);
    expect(block).not.toContain('--');
    expect(block).not.toContain('var(');
    expect(block).not.toContain('svg.sgl');
  });

  it('the token block is one svg.sgl rule: --sgl-canvas first, then every token', () => {
    const block = buildTokenBlock(theme, '#ffffff');
    expect(block).toBe('svg.sgl{--sgl-canvas:#ffffff;--font-sans:Inter, sans-serif;--surface-sunken:#f0f0f0}');
  });

  it('tokens are sorted by name for determinism', () => {
    const block = buildTokenBlock(theme, '#fff');
    expect(block.indexOf('--font-sans')).toBeLessThan(block.indexOf('--surface-sunken'));
  });

  it('a bad canvas background gets the loud fallback in both blocks, not passed through', () => {
    expect(buildStyleBlock('javascript:alert(1)', [])).toContain('.canvas{fill:#FF00FF}');
    expect(buildTokenBlock(theme, 'javascript:alert(1)')).toContain('--sgl-canvas:#FF00FF');
  });
});
