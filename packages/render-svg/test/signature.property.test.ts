import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cascadeSignature } from '../src/style.js';

/**
 * Fix round 1, item 8: the cascade signature names a paint class (DD-07 §6),
 * so its inline-style part must be a faithful canonical form of the `@style`
 * bag: two bags that differ in content give different signatures, and two
 * that differ only in key order — at any depth — give the same one.
 */

/** A JSON-like value, nested; keys drawn from a small alphabet so collisions
 *  and permutations actually happen. */
const key = fc.constantFrom('a', 'b', 'c', 'fill', 'stroke', '1', '10', '');
const leaf = fc.oneof(fc.integer({ min: -3, max: 12 }), fc.constantFrom('1', '10', '#fff', 'a', ''), fc.boolean(), fc.constant(null));
const { value } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leaf, fc.array(tie('value'), { maxLength: 3 }), fc.dictionary(key, tie('value'), { maxKeys: 4 })),
}));
const style = fc.dictionary(key, value, { maxKeys: 5 });

/** Reference canonical form: keys sorted at every depth, then JSON. */
function reference(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(reference).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${reference(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The same value with every object's keys in reverse insertion order. */
function permuted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(permuted);
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).reverse().map((k) => [k, permuted(o[k])]));
  }
  return v;
}

const sig = (s: Record<string, unknown>): string => cascadeSignature('node', 'rect', ['K'], { style: s });

describe('cascadeSignature: the inline style is canonical (fix round 1, item 8)', () => {
  it('key permutations at any depth give the same signature', () => {
    fc.assert(
      fc.property(style, (s) => {
        expect(sig(permuted(s) as Record<string, unknown>)).toBe(sig(s));
      }),
      { numRuns: 500 },
    );
  });

  it('distinct canonical styles give distinct signatures', () => {
    fc.assert(
      fc.property(style, style, (a, b) => {
        if (reference(a) === reference(b)) return;
        expect(sig(a)).not.toBe(sig(b));
      }),
      { numRuns: 1000 },
    );
  });

  it('distinct canonical styles give distinct signatures, over a tiny domain where near-misses are common', () => {
    const tinyLeaf = fc.constantFrom<unknown>(1, '1', 'true', true, null, 0, '0', '');
    const tinyKey = fc.constantFrom('a', 'b');
    const { tiny } = fc.letrec<{ tiny: unknown }>((tie) => ({
      tiny: fc.oneof({ depthSize: 'small' }, tinyLeaf, fc.array(tie('tiny'), { maxLength: 2 }), fc.dictionary(tinyKey, tie('tiny'), { maxKeys: 2 })),
    }));
    const tinyStyle = fc.dictionary(tinyKey, tiny, { maxKeys: 2 });
    fc.assert(
      fc.property(tinyStyle, tinyStyle, (a, b) => {
        if (reference(a) === reference(b)) return;
        expect(sig(a)).not.toBe(sig(b));
      }),
      { numRuns: 2000 },
    );
  });

  it('the cases that matter, spelled out: 1 vs "1", nested order, null vs absent', () => {
    expect(sig({ fill: 1 })).not.toBe(sig({ fill: '1' }));
    expect(sig({ x: { a: 1, b: 2 } })).toBe(sig({ x: { b: 2, a: 1 } }));
    expect(sig({ x: { a: 1 } })).not.toBe(sig({ x: { a: '1' } }));
    expect(sig({ fill: null })).not.toBe(sig({}));
  });
});
