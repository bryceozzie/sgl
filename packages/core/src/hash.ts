/**
 * FNV-1a, 64-bit, over a canonical string (DD-00 §3).
 *
 * Used for edge IDs, geometry/paint hashes, cache keys and generated class names.
 * The algorithm is part of the compatibility surface, because edge IDs appear in
 * exported SVG — changing it changes every exported document's element IDs.
 */

const OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const PRIME = 0x0000_0100_0000_01b3n;
const MASK = 0xffff_ffff_ffff_ffffn;

/** Returns the hash as 16 lowercase hex digits. */
export function fnv1a64(input: string): string {
  let h = OFFSET_BASIS;
  for (const byte of utf8Bytes(input)) {
    h = ((h ^ BigInt(byte)) * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * UTF-8 encode, by hand.
 *
 * The hash must be over bytes, not UTF-16 code units, or the same document would
 * produce different edge IDs depending on the host's string representation.
 * `TextEncoder` would do this, but it is not in the ES2022 lib, and reaching for a
 * platform global here would cost `@sgl/core` its "no ambient environment" property
 * (DD-00 §2) for fifteen lines of arithmetic.
 */
function* utf8Bytes(s: string): Generator<number> {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      yield cp;
    } else if (cp < 0x800) {
      yield 0xc0 | (cp >> 6);
      yield 0x80 | (cp & 0x3f);
    } else if (cp < 0x1_0000) {
      yield 0xe0 | (cp >> 12);
      yield 0x80 | ((cp >> 6) & 0x3f);
      yield 0x80 | (cp & 0x3f);
    } else {
      yield 0xf0 | (cp >> 18);
      yield 0x80 | ((cp >> 12) & 0x3f);
      yield 0x80 | ((cp >> 6) & 0x3f);
      yield 0x80 | (cp & 0x3f);
    }
  }
}

/** The short form used in element IDs and class names: the first 8 hex digits. */
export function shortHash(input: string): string {
  return fnv1a64(input).slice(0, 8);
}

/** Canonical `k=v` serialisation of a flat style bag, sorted by key.
 *  Sorting is what makes the geometry/paint hashes independent of insertion order. */
export function canonicalise(bag: Readonly<Record<string, unknown>>): string {
  return Object.keys(bag)
    .sort()
    .map((k) => `${k}=${JSON.stringify(bag[k])}`)
    .join(';');
}
