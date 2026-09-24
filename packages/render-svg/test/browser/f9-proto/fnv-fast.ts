/**
 * F9 PHASE 1 PROTOTYPE: measurement only, not production code.
 *
 * FNV-1a 64 with the same output as `@sgl/core`'s `fnv1a64` (the bench
 * asserts equality on every string it times), computed in four 16-bit limbs
 * with plain number arithmetic instead of `BigInt`, and without the
 * generator. `fnv1a64` is on every element's path in `styleGraph` (paint and
 * geometry hashes) and in `render()` (every `g-` class name), so a theme
 * switch pays for it thousands of times.
 */
export function fnv1a64Fast(input: string): string {
  // Offset basis 0xcbf29ce484222325, little-endian 16-bit limbs.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const step = (byte: number): void => {
    h0 ^= byte;
    // h * 0x100000001b3 = h * 0x1b3 + (h << 40)
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (h0 << 8) + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + (h1 << 8) + (t2 >>> 16);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  };
  for (let i = 0; i < input.length; ) {
    const cp = input.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    if (cp < 0x80) {
      step(cp);
    } else if (cp < 0x800) {
      step(0xc0 | (cp >> 6));
      step(0x80 | (cp & 0x3f));
    } else if (cp < 0x1_0000) {
      step(0xe0 | (cp >> 12));
      step(0x80 | ((cp >> 6) & 0x3f));
      step(0x80 | (cp & 0x3f));
    } else {
      step(0xf0 | (cp >> 18));
      step(0x80 | ((cp >> 12) & 0x3f));
      step(0x80 | ((cp >> 6) & 0x3f));
      step(0x80 | (cp & 0x3f));
    }
  }
  const hex = (n: number): string => n.toString(16).padStart(4, '0');
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}
