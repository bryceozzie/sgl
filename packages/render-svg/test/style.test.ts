import type { ComputedStyle } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { buildStyleBlock, cascadeSignature, ClassTable, geometryDeclarations, paintDeclarations, signatureToken } from '../src/style.js';

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

  it('plate: fill from labelPlate; "none" and no plate colour are fill:none, never the SVG default black (F7)', () => {
    expect(paintDeclarations({ labelPlate: '#eee' }, 'plate')).toEqual(['fill:#eee']);
    expect(paintDeclarations({ labelPlate: 'none' }, 'plate')).toEqual(['fill:none']);
    expect(paintDeclarations({}, 'plate')).toEqual(['fill:none']);
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

describe('cascadeSignature() (F7, DD-07 §6)', () => {
  it('is the cascade inputs: role, shape, classes in order, canonical inline style', () => {
    expect(cascadeSignature('node', 'rect', ['A', 'B'], { style: { stroke: '#f00', fill: '@accent' } })).toBe('node|rect|A,B|fill="@accent";stroke="#f00"');
    expect(cascadeSignature('edge', undefined, [], {})).toBe('edge|||');
  });

  it('inline style key order does not matter; class order does (linearised order is a cascade input)', () => {
    expect(cascadeSignature('node', 'rect', [], { style: { a: 1, b: 2 } })).toBe(cascadeSignature('node', 'rect', [], { style: { b: 2, a: 1 } }));
    expect(cascadeSignature('node', 'rect', ['A', 'B'], {})).not.toBe(cascadeSignature('node', 'rect', ['B', 'A'], {}));
  });

  it('every input is part of the key', () => {
    const base = cascadeSignature('node', 'rect', ['A'], { style: { fill: '#fff' } });
    for (const other of [
      cascadeSignature('container', 'rect', ['A'], { style: { fill: '#fff' } }),
      cascadeSignature('node.title', 'rect', ['A'], { style: { fill: '#fff' } }),
      cascadeSignature('node', 'round', ['A'], { style: { fill: '#fff' } }),
      cascadeSignature('node', 'rect', ['B'], { style: { fill: '#fff' } }),
      cascadeSignature('node', 'rect', ['A'], { style: { fill: '#000' } }),
      cascadeSignature('node', 'rect', ['A'], {}),
    ]) {
      expect(other).not.toBe(base);
    }
  });

  it('ignores everything that is not a cascade input (@size, @link, …)', () => {
    expect(cascadeSignature('node', 'rect', [], { size: { width: 9 }, link: 'https://x' })).toBe(cascadeSignature('node', 'rect', [], {}));
  });
});

describe('ClassTable', () => {
  const SIG = 'node|rect||';

  it('shapeClasses returns "g-<hash> s-<signature token>", geometry first', () => {
    const t = new ClassTable();
    const cls = t.shapeClasses(style({ fill: '#fff' }, { strokeWidth: 1 }), SIG);
    expect(cls).toMatch(new RegExp(`^g-\\S+ s-${signatureToken(SIG)}$`));
    expect(signatureToken(SIG)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the paint class name comes from the signature alone, never from the paint (F7)', () => {
    const a = new ClassTable().shapeClasses({ paint: { fill: '#fff' }, geometry: {}, paintHash: 'light', geometryHash: 'g' } as ComputedStyle, SIG);
    const b = new ClassTable().shapeClasses({ paint: { fill: '#000' }, geometry: {}, paintHash: 'dark', geometryHash: 'g' } as ComputedStyle, SIG);
    expect(a).toBe(b);
  });

  it('a paint class with no declarations is still on the element; only its rule is omitted (F7)', () => {
    const t = new ClassTable();
    expect(t.shapeClasses(style({}, {}), SIG)).toBe(`s-${signatureToken(SIG)}`);
    expect(t.emit()).toEqual([]);
  });

  it('two elements with one signature share one class and one rule', () => {
    const t = new ClassTable();
    const a = t.shapeClasses(style({ fill: '#fff' }), SIG);
    const b = t.shapeClasses(style({ fill: '#fff' }), SIG);
    expect(a).toBe(b);
    expect(t.emit()).toHaveLength(1);
  });

  it('two elements with the same geometryHash but different emitted geometry declarations get different classes (keyed by declarations, not geometryHash)', () => {
    const t = new ClassTable();
    const a = t.shapeClasses({ paint: {}, geometry: { strokeWidth: 1 }, paintHash: 'p', geometryHash: 'same' } as ComputedStyle, SIG);
    const b = t.shapeClasses({ paint: {}, geometry: { strokeWidth: 2 }, paintHash: 'p', geometryHash: 'same' } as ComputedStyle, SIG);
    expect(a).not.toBe(b);
  });

  it('emit() is sorted by class name regardless of discovery order', () => {
    const t1 = new ClassTable();
    t1.shapeClasses(style({ fill: '#111' }), 'node|rect||');
    t1.textClasses(style({ color: '#222' }), 'node.title|||');
    t1.markerPaint('mf-abc', false, '#333');

    const t2 = new ClassTable();
    t2.markerPaint('mf-abc', false, '#333');
    t2.textClasses(style({ color: '#222' }), 'node.title|||');
    t2.shapeClasses(style({ fill: '#111' }), 'node|rect||');

    expect(t1.emit()).toEqual(t2.emit());
  });

  it('plateClasses carries no geometry component', () => {
    const t = new ClassTable();
    const cls = t.plateClasses(style({ labelPlate: '#eee' }, { strokeWidth: 99 }), 'edge|||');
    expect(cls).toBe(`p-${signatureToken('edge|||')}`);
  });

  it("markerPaint: a filled head's rule is fill, an open head's is stroke, and a bad colour is the loud fallback", () => {
    const t = new ClassTable();
    t.markerPaint('mf-a', false, '#123456');
    t.markerPaint('ms-a', true, '#123456');
    t.markerPaint('mf-b', false, 'javascript:alert(1)');
    expect(t.emit()).toEqual(['.mf-a{fill:#123456}', '.mf-b{fill:#FF00FF}', '.ms-a{stroke:#123456}']);
  });
});

describe('buildStyleBlock() (F17, F18, DD-07 §6)', () => {
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

  it('a bad canvas background gets the loud fallback, not passed through', () => {
    expect(buildStyleBlock('javascript:alert(1)', [])).toContain('.canvas{fill:#FF00FF}');
  });
});
