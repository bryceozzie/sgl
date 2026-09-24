import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalise, fnv1a64, shortHash } from '../src/hash.js';

/**
 * FNV-1a 64 as the specification states it (and as `hash.ts` computed it
 * before F9): 64-bit `BigInt` arithmetic over the input's UTF-8 bytes, where a
 * code point is taken with `for…of` (so a lone surrogate is encoded as its own
 * three-byte sequence). Test-only: the production hash must equal this.
 */
function referenceFnv1a64(input: string): string {
  const PRIME = 0x0000_0100_0000_01b3n;
  const MASK = 0xffff_ffff_ffff_ffffn;
  let h = 0xcbf2_9ce4_8422_2325n;
  const bytes: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x1_0000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  for (const byte of bytes) h = ((h ^ BigInt(byte)) * PRIME) & MASK;
  return h.toString(16).padStart(16, '0');
}

describe('fnv1a64', () => {
  it('matches the reference vectors', () => {
    // Standard FNV-1a 64-bit test vectors. These are locked because edge IDs made
    // from this hash appear in exported SVG — the algorithm is part of the
    // compatibility surface, not an implementation detail.
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // A rocket is four UTF-8 bytes but two UTF-16 units. Locking the value keeps
    // the CLI, the browser and the Worker agreeing on IDs for the same document.
    expect(fnv1a64('\u{1F680}')).toBe('ff06d33875097bda');
  });

  it('is stable across runs', () => {
    const key = 'payments.api->payments.ledger';
    expect(fnv1a64(key)).toBe(fnv1a64(key));
  });

  // F9 (execution plan §2.1): `fnv1a64` runs once per element per paint and
  // geometry hash in `styleGraph`, on every theme switch, so it is computed in
  // plain 16-bit limbs rather than `BigInt`. Its output is the compatibility
  // surface (edge IDs, class names in every exported SVG), so it is held to
  // the straightforward BigInt definition, kept here as the reference.
  describe('agrees with the BigInt reference definition', () => {
    it('on arbitrary strings of UTF-16 code units, lone surrogates included', () => {
      const codeUnits = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 64 }).map((units) => String.fromCharCode(...units));
      fc.assert(
        fc.property(codeUnits, (s) => fnv1a64(s) === referenceFnv1a64(s)),
        { numRuns: 2000 },
      );
    });

    it('on arbitrary Unicode strings (astral code points)', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (s) => fnv1a64(s) === referenceFnv1a64(s)),
        { numRuns: 2000 },
      );
    });

    it('on arbitrary ASCII, the common case (style bags, ids)', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary-ascii', maxLength: 256 }), (s) => fnv1a64(s) === referenceFnv1a64(s)),
        { numRuns: 2000 },
      );
    });

    it('on the edge cases by name', () => {
      for (const s of ['', '\u0000', '\u007f', '\u0080', '߿', 'ࠀ', '￿', '\u{10000}', '\u{10ffff}', '\ud800', '\udfff', 'a\ud800b', '\udc00\ud800', 'héllo wörld', '日本語', '\u{1F680}'.repeat(40)]) {
        expect(fnv1a64(s)).toBe(referenceFnv1a64(s));
      }
    });
  });

  it('shortens to eight hex digits', () => {
    expect(shortHash('anything')).toBe(fnv1a64('anything').slice(0, 8));
    expect(shortHash('anything')).toHaveLength(8);
  });
});

describe('canonicalise', () => {
  it('is independent of insertion order', () => {
    // This is what makes the geometry and paint hashes order-independent, and so
    // what makes "does layout need to re-run?" answerable by comparing two strings.
    expect(canonicalise({ fill: '#fff', stroke: '#000' })).toBe(
      canonicalise({ stroke: '#000', fill: '#fff' }),
    );
  });

  it('distinguishes values by type', () => {
    expect(canonicalise({ strokeWidth: 1 })).not.toBe(canonicalise({ strokeWidth: '1' }));
  });
});
