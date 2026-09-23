import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../src/state/base64url.js';
import {
  decodeShareFragment,
  encodeShareFragment,
  inflateRawCapped,
  isLongShareLink,
  NATIVE_SHARE_CODEC,
  SHARE_INFLATED_CAP,
  SHARE_LINK_WARN_LENGTH,
  shareLink,
  type ByteTransform,
  type ShareCodec,
} from '../src/state/share.js';

/** DD-08 §8 — share by URL, DOM-free, with Node's own `CompressionStream`. */

const fragmentOf = (bytes: Uint8Array, extra = ''): string => `s=${encodeBase64Url(bytes)}${extra}`;

describe('base64url (RFC 4648 §5, no padding)', () => {
  it("agrees with Node's own encoder for every length mod 3", () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 31) & 0xff);
      const ours = encodeBase64Url(bytes);
      expect(ours).toBe(Buffer.from(bytes).toString('base64url'));
      expect(decodeBase64Url(ours)).toEqual(bytes);
    }
  });

  it('refuses anything that is not canonical unpadded base64url', () => {
    expect(decodeBase64Url('AAA=')).toBeNull(); // padding
    expect(decodeBase64Url('AA+/')).toBeNull(); // plain base64's alphabet
    expect(decodeBase64Url('A')).toBeNull(); // 6 bits cannot make a byte
    expect(decodeBase64Url('AB')).toBeNull(); // non-zero trailing bits
    expect(decodeBase64Url('A B')).toBeNull();
    expect(decodeBase64Url('é')).toBeNull();
    expect(decodeBase64Url('')).toEqual(new Uint8Array(0));
  });
});

describe('encode / decode round trip', () => {
  it.each([
    ['ASCII', 'checkout: {\n  web: "Web App"\n  api: "API"\n  web -> api\n}\n'],
    ['non-ASCII', 'ümlaut: "Grüße — 日本語 🚀"\n'],
    ['empty', ''],
  ])('%s source survives, with its engine and theme', async (_name, source) => {
    const fragment = await encodeShareFragment({ source, engineId: 'sgl.grid', themeId: 'neutral-dark' });
    expect(fragment).toMatch(/^s=[A-Za-z0-9_-]*&e=sgl\.grid&t=neutral-dark$/);
    expect(await decodeShareFragment(`#${fragment}`)).toEqual({
      kind: 'ok',
      payload: { source, engineId: 'sgl.grid', themeId: 'neutral-dark' },
    });
  });

  it('is deflate-raw: Node zlib inflates what the encoder wrote', async () => {
    const fragment = await encodeShareFragment({ source: 'a -> b\n' });
    const s = new URLSearchParams(fragment).get('s')!;
    const { inflateRawSync } = await import('node:zlib');
    expect(inflateRawSync(Buffer.from(s, 'base64url')).toString('utf8')).toBe('a -> b\n');
  });

  it('leaves e/t out when the payload has none, and decodes a link without them', async () => {
    const fragment = await encodeShareFragment({ source: 'x\n' });
    expect(fragment).not.toContain('&');
    expect(await decodeShareFragment(fragment)).toEqual({ kind: 'ok', payload: { source: 'x\n' } });
  });

  it('builds the whole link and measures it against the 8 000-character warning', () => {
    const link = shareLink('https://sgl.example/', 's=abc');
    expect(link).toBe('https://sgl.example/#s=abc');
    const base = 'https://sgl.example/#s=';
    expect(isLongShareLink(base + 'a'.repeat(SHARE_LINK_WARN_LENGTH - base.length))).toBe(false);
    expect(isLongShareLink(base + 'a'.repeat(SHARE_LINK_WARN_LENGTH - base.length + 1))).toBe(true);
  });
});

describe('decode refusals', () => {
  it('a hash without s= is not a share link at all', async () => {
    expect(await decodeShareFragment('')).toEqual({ kind: 'none' });
    expect(await decodeShareFragment('#')).toEqual({ kind: 'none' });
    expect(await decodeShareFragment('#e=sgl.grid&t=neutral-dark')).toEqual({ kind: 'none' });
  });

  it('corrupt base64 is invalid', async () => {
    expect(await decodeShareFragment('#s=not*base64')).toEqual({ kind: 'invalid', reason: 'corrupt' });
    expect(await decodeShareFragment('#s=')).toEqual({ kind: 'invalid', reason: 'corrupt' });
    expect(await decodeShareFragment('#s=A')).toEqual({ kind: 'invalid', reason: 'corrupt' });
  });

  it('valid base64 of bytes that are not a deflate stream is invalid', async () => {
    expect(await decodeShareFragment(fragmentOf(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff])))).toEqual({ kind: 'invalid', reason: 'corrupt' });
  });

  it('a truncated deflate stream is invalid', async () => {
    const whole = deflateRawSync(Buffer.from('a'.repeat(5000) + 'b'.repeat(5000)));
    expect(await decodeShareFragment(fragmentOf(whole.subarray(0, whole.length - 4)))).toEqual({ kind: 'invalid', reason: 'corrupt' });
  });

  it('inflated bytes that are not UTF-8 are invalid', async () => {
    expect(await decodeShareFragment(fragmentOf(deflateRawSync(Buffer.from([0xc3, 0x28, 0xa0, 0xa1]))))).toEqual({ kind: 'invalid', reason: 'corrupt' });
  });

  it('exactly the cap inflates; one byte over is oversize', async () => {
    const cap = 4096;
    const at = await decodeShareFragment(fragmentOf(deflateRawSync(Buffer.alloc(cap, 0x61))), NATIVE_SHARE_CODEC, cap);
    expect(at.kind).toBe('ok');
    const over = await decodeShareFragment(fragmentOf(deflateRawSync(Buffer.alloc(cap + 1, 0x61))), NATIVE_SHARE_CODEC, cap);
    expect(over).toEqual({ kind: 'invalid', reason: 'oversize' });
  });

  it('a fragment too long to inflate under the cap is refused before decoding', async () => {
    expect(await decodeShareFragment(`#s=${'A'.repeat(4 * SHARE_INFLATED_CAP)}`)).toEqual({ kind: 'invalid', reason: 'oversize' });
  });
});

describe('decompression-bomb guard (DD-09 §1.1: hard 2 MB inflated cap)', () => {
  /** The native decompressor, with a meter on how many bytes it actually
   *  produced — what the cap has to bound. */
  function meteredCodec(): { readonly codec: ShareCodec; readonly produced: () => number } {
    let produced = 0;
    const codec: ShareCodec = {
      compress: NATIVE_SHARE_CODEC.compress,
      decompress: () => {
        const inner = NATIVE_SHARE_CODEC.decompress();
        const meter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            produced += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        const stream: ByteTransform = { writable: inner.writable, readable: inner.readable.pipeThrough(meter) };
        return stream;
      },
    };
    return { codec, produced: () => produced };
  }

  it('stops at the cap: a 64 MB bomb is refused without inflating it', async () => {
    const bombSize = 64 * 1024 * 1024;
    const bomb = deflateRawSync(Buffer.alloc(bombSize)); // ~64 KB of compressed zeros.
    const metered = meteredCodec();

    const result = await decodeShareFragment(fragmentOf(bomb), metered.codec);

    expect(result).toEqual({ kind: 'invalid', reason: 'oversize' });
    // The decompressor produced just past the cap — within a couple of input
    // slices' worth — and nowhere near the 64 MB the payload inflates to:
    // reading stopped at the cap rather than inflating everything and then
    // measuring it.
    expect(metered.produced()).toBeGreaterThan(SHARE_INFLATED_CAP);
    expect(metered.produced()).toBeLessThan(SHARE_INFLATED_CAP + 2 * 1024 * 1024);
  });

  it('inflateRawCapped reports oversize and corrupt as values, never throws', async () => {
    await expect(inflateRawCapped(deflateRawSync(Buffer.alloc(10_000)), 100)).resolves.toEqual({ ok: false, reason: 'oversize' });
    await expect(inflateRawCapped(Uint8Array.from([0xff, 0xfe]), 100)).resolves.toEqual({ ok: false, reason: 'corrupt' });
    const broken: ShareCodec = {
      compress: NATIVE_SHARE_CODEC.compress,
      decompress: () => {
        throw new TypeError('unsupported format');
      },
    };
    await expect(inflateRawCapped(Uint8Array.from([1]), 100, broken)).resolves.toEqual({ ok: false, reason: 'corrupt' });
  });
});
