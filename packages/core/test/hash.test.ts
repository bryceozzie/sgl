import { describe, expect, it } from 'vitest';
import { canonicalise, fnv1a64, shortHash } from '../src/hash.js';

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
