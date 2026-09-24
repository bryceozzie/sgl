/**
 * FNV-1a, 64-bit, over a canonical string (DD-00 §3).
 *
 * Used for edge IDs, geometry/paint hashes, cache keys and generated class names.
 * The algorithm is part of the compatibility surface, because edge IDs appear in
 * exported SVG — changing it changes every exported document's element IDs.
 */

/** Returns the hash as 16 lowercase hex digits.
 *
 * The 64-bit state is four 16-bit limbs in plain numbers rather than a
 * `BigInt` (F9, execution plan §2.1): `styleGraph` hashes every element's
 * paint and geometry bags, so a theme switch on a 2 000-node document calls
 * this ~13 000 times, and the `BigInt` form spent ~110 ms of it. The output is
 * the textbook definition's, bit for bit — `test/hash.test.ts` holds it to a
 * `BigInt` reference over arbitrary strings, lone surrogates included.
 *
 * Multiplying by the FNV prime 2^40 + 0x1b3 is `h * 0x1b3 + (h << 40)`: the
 * first term limb by limb, the second adding limb 0 into limb 2 and limb 1 into
 * limb 3 (each shifted up 8 bits), carries propagated upward and the top
 * dropped (mod 2^64). Every intermediate stays below 2^31.
 */
export function fnv1a64(input: string): string {
  // The offset basis 0xcbf29ce484222325, least significant limb first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const mix = (byte: number): void => {
    h0 ^= byte;
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (h0 << 8) + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + (h1 << 8) + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  };

  // UTF-8, by hand. The hash must be over bytes, not UTF-16 code units, or the
  // same document would produce different edge IDs depending on the host's
  // string representation. `TextEncoder` would do this, but it is not in the
  // ES2022 lib, and reaching for a platform global here would cost `@sgl/core`
  // its "no ambient environment" property (DD-00 §2) for a few lines of
  // arithmetic. Code points are taken as `for…of` takes them: a surrogate pair
  // is one code point, a lone surrogate is encoded as its own three bytes.
  for (let i = 0; i < input.length; ) {
    const cp = input.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    if (cp < 0x80) {
      mix(cp);
    } else if (cp < 0x800) {
      mix(0xc0 | (cp >> 6));
      mix(0x80 | (cp & 0x3f));
    } else if (cp < 0x1_0000) {
      mix(0xe0 | (cp >> 12));
      mix(0x80 | ((cp >> 6) & 0x3f));
      mix(0x80 | (cp & 0x3f));
    } else {
      mix(0xf0 | (cp >> 18));
      mix(0x80 | ((cp >> 12) & 0x3f));
      mix(0x80 | ((cp >> 6) & 0x3f));
      mix(0x80 | (cp & 0x3f));
    }
  }
  return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
}

function hex4(limb: number): string {
  return limb.toString(16).padStart(4, '0');
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
