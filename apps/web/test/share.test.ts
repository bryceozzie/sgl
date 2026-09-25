import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../src/state/base64url.js';
import {
  bundleToast,
  decodeShareFragment,
  encodeShareFragment,
  INFLATE_SLICE_BYTES,
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

/** The fragment of a successful encode (fails the test otherwise). */
function encoded(result: Awaited<ReturnType<typeof encodeShareFragment>>): string {
  if (!result.ok) throw new Error('encodeShareFragment failed');
  return result.fragment;
}

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
    const fragment = encoded(await encodeShareFragment({ source, engineId: 'sgl.grid', themeId: 'neutral-dark' }));
    expect(fragment).toMatch(/^s=[A-Za-z0-9_-]*&e=sgl\.grid&t=neutral-dark$/);
    expect(await decodeShareFragment(`#${fragment}`)).toEqual({
      kind: 'ok',
      payload: { source, engineId: 'sgl.grid', themeId: 'neutral-dark' },
    });
  });

  it('is deflate-raw: Node zlib inflates what the encoder wrote', async () => {
    const fragment = encoded(await encodeShareFragment({ source: 'a -> b\n' }));
    const s = new URLSearchParams(fragment).get('s')!;
    const { inflateRawSync } = await import('node:zlib');
    expect(inflateRawSync(Buffer.from(s, 'base64url')).toString('utf8')).toBe('a -> b\n');
  });

  it('leaves e/t out when the payload has none, and decodes a link without them', async () => {
    const fragment = encoded(await encodeShareFragment({ source: 'x\n' }));
    expect(fragment).not.toContain('&');
    expect(await decodeShareFragment(fragment)).toEqual({ kind: 'ok', payload: { source: 'x\n' } });
  });

  it('an encoder that cannot run (no CompressionStream: an old or locked-down browser) is a value, not a rejection', async () => {
    const missing: ShareCodec = {
      compress: () => {
        throw new ReferenceError('CompressionStream is not defined');
      },
      decompress: NATIVE_SHARE_CODEC.decompress,
    };
    await expect(encodeShareFragment({ source: 'a\n' }, missing)).resolves.toEqual({ ok: false });
    const failing: ShareCodec = {
      compress: () => {
        const t = new TransformStream<Uint8Array, Uint8Array>({
          transform() {
            throw new TypeError('compression failed');
          },
        });
        return t;
      },
      decompress: NATIVE_SHARE_CODEC.decompress,
    };
    await expect(encodeShareFragment({ source: 'a\n' }, failing)).resolves.toEqual({ ok: false });
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

  it('the default cap is exactly 2 MB (DD-08 §8, DD-09 §1.1)', () => {
    expect(SHARE_INFLATED_CAP).toBe(2 * 1024 * 1024);
  });

  it('with the default cap, exactly 2 MB inflates and 2 MB + 1 byte is oversize', async () => {
    const twoMb = 2 * 1024 * 1024;
    const at = await decodeShareFragment(fragmentOf(deflateRawSync(Buffer.alloc(twoMb, 0x61))));
    expect(at.kind).toBe('ok');
    expect(at.kind === 'ok' && at.payload.source.length).toBe(twoMb);
    const over = await decodeShareFragment(fragmentOf(deflateRawSync(Buffer.alloc(twoMb + 1, 0x61))));
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

  it('no single write to the decompressor exceeds 512 bytes (INFLATE_SLICE_BYTES)', async () => {
    // The slice size is what bounds the overshoot past the cap: a
    // TransformStream inflates each written chunk in full, whatever the
    // reader does. So record every chunk the decompressor is handed, and hold
    // it to the literal bound DD-08 §8 reasons about (512 B × ~1032:1 ≈
    // 0.5 MB), not to the constant, which could drift with it.
    const MAX_WRITE = 512;
    const writes: number[] = [];
    const recording: ShareCodec = {
      compress: NATIVE_SHARE_CODEC.compress,
      decompress: () => {
        const inner = NATIVE_SHARE_CODEC.decompress();
        const recorder = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            writes.push(chunk.byteLength);
            controller.enqueue(chunk);
          },
        });
        void recorder.readable.pipeTo(inner.writable).catch(() => undefined);
        return { writable: recorder.writable, readable: inner.readable };
      },
    };
    // Incompressible text, so the compressed payload spans many slices…
    let seed = 7;
    const noisy = Array.from({ length: 20_000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return String.fromCharCode(33 + (seed % 90));
    }).join('');
    const compressed = deflateRawSync(Buffer.from(noisy));
    expect(compressed.length).toBeGreaterThan(8 * MAX_WRITE);
    expect(await decodeShareFragment(fragmentOf(compressed), recording)).toEqual({ kind: 'ok', payload: { source: noisy } });
    expect(writes.reduce((a, b) => a + b, 0)).toBe(compressed.length);
    expect(Math.max(...writes)).toBeLessThanOrEqual(MAX_WRITE);
    expect(writes.length).toBeGreaterThanOrEqual(Math.ceil(compressed.length / INFLATE_SLICE_BYTES));

    // …and a bomb, which is refused while still being fed.
    writes.length = 0;
    const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
    expect(await decodeShareFragment(fragmentOf(bomb), recording)).toEqual({ kind: 'invalid', reason: 'oversize' });
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.max(...writes)).toBeLessThanOrEqual(MAX_WRITE);
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

describe('imported documents in the link, `i=` (A9, DD-08 §15.3: I26, I28)', () => {
  const DOCS = [
    { n: 'classes', t: 'Shared classes', s: '@classes: { Svc: { @shape: round } }\n' },
    { n: 'aws icons', t: 'AWS — ümlaut 🚀', s: 'lambda\n' },
  ];
  /** `i=` for `json` as sent: deflate-raw, base64url. */
  const iParam = (json: string | Uint8Array): string => `&i=${encodeBase64Url(deflateRawSync(typeof json === 'string' ? Buffer.from(json, 'utf8') : json))}`;
  const main = fragmentOf(deflateRawSync(Buffer.from('api: Svc\n', 'utf8')));

  it('round trip: `i=` beside `s=`, `e=` and `t=`, which are unchanged', async () => {
    const fragment = encoded(await encodeShareFragment({ source: 'api: Svc\n', engineId: 'sgl.grid', imports: DOCS }));
    expect(fragment).toMatch(/^s=[A-Za-z0-9_-]+&e=sgl\.grid&i=[A-Za-z0-9_-]+$/);
    expect(await decodeShareFragment(fragment)).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n', engineId: 'sgl.grid', imports: DOCS } });
    // The stream is deflate-raw of `{"v":1,"d":[…]}`.
    const i = new URLSearchParams(fragment).get('i')!;
    expect(JSON.parse(inflateRawSync(decodeBase64Url(i)!).toString('utf8'))).toEqual({ v: 1, d: DOCS });
  });

  it('a link without `i=` opens exactly as before, and an empty closure adds none', async () => {
    expect(encoded(await encodeShareFragment({ source: 'a\n', imports: [] }))).not.toContain('i=');
    expect(await decodeShareFragment(main)).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n' } });
  });

  it('an older app ignores `i=`: a decoder reading only s, e and t still gets the document', async () => {
    const fragment = encoded(await encodeShareFragment({ source: 'api: Svc\n', imports: DOCS }));
    const params = new URLSearchParams(fragment);
    params.delete('i');
    expect(await decodeShareFragment(params.toString())).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n' } });
  });

  it('a `v` other than 1 is left out, and says so; the document still opens', async () => {
    expect(await decodeShareFragment(main + iParam(JSON.stringify({ v: 2, d: DOCS })))).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n', importsProblem: 'version' } });
  });

  it.each([
    ['not base64url', '&i=a+b'],
    ['not deflate', `&i=${encodeBase64Url(new Uint8Array([1, 2, 3, 4, 5]))}`],
    ['not UTF-8', iParam(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))],
    ['not JSON', iParam('{"v":1,')],
    ['not an object', iParam('[1]')],
    ['`d` not an array', iParam('{"v":1,"d":{}}')],
    ['an entry without `s`', iParam(JSON.stringify({ v: 1, d: [{ n: 'a', t: 'A' }] }))],
    ['an entry with a number', iParam(JSON.stringify({ v: 1, d: [{ n: 'a', t: 3, s: '' }] }))],
    ['an empty name', iParam(JSON.stringify({ v: 1, d: [{ n: '', t: 'A', s: '' }] }))],
    ['65 entries', iParam(JSON.stringify({ v: 1, d: Array.from({ length: 65 }, (_, k) => ({ n: `d${k}`, t: 'T', s: '' })) }))],
  ])('a bad bundle (%s) does not invalidate the link: the document opens, and it says so', async (_name, extra) => {
    expect(await decodeShareFragment(main + extra)).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n', importsProblem: 'invalid' } });
  });

  it('64 entries are fine', async () => {
    const d = Array.from({ length: 64 }, (_, k) => ({ n: `d${k}`, t: 'T', s: '' }));
    expect(await decodeShareFragment(main + iParam(JSON.stringify({ v: 1, d })))).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n', imports: d } });
  });

  it('`i=` has its own 2 MB inflated cap: a bomb in it is refused, and the document still opens', async () => {
    const bomb = new Uint8Array(SHARE_INFLATED_CAP + 1).fill(0x20);
    expect(await decodeShareFragment(main + iParam(bomb))).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n', importsProblem: 'invalid' } });
    const huge = `&i=${'A'.repeat(Math.ceil(((SHARE_INFLATED_CAP + 1024) * 4) / 3) + 2048)}`;
    expect(await decodeShareFragment(main + huge)).toEqual({ kind: 'ok', payload: { source: 'api: Svc\n', importsProblem: 'invalid' } });
  });

  it('the length guard measures the whole link, `i=` included', async () => {
    const big = [{ n: 'big', t: 'Big', s: Array.from({ length: 4000 }, (_, k) => `n${(k * 7919) % 100003}\n`).join('') }];
    const without = shareLink('https://sgl.example/', encoded(await encodeShareFragment({ source: 'api\n' })));
    const withImports = shareLink('https://sgl.example/', encoded(await encodeShareFragment({ source: 'api\n', imports: big })));
    expect(isLongShareLink(without)).toBe(false);
    expect(isLongShareLink(withImports)).toBe(true);
  });

  it('what boot says about a bundle', () => {
    expect(bundleToast({ source: '', imports: DOCS })).toEqual({ message: 'Opened the shared diagram and its 2 imported documents as new documents.', kind: 'info' });
    expect(bundleToast({ source: '', imports: [DOCS[0]!] })).toEqual({ message: 'Opened the shared diagram and its imported document as new documents.', kind: 'info' });
    expect(bundleToast({ source: '', importsProblem: 'invalid' })?.kind).toBe('error');
    expect(bundleToast({ source: '', importsProblem: 'version' })?.kind).toBe('error');
    expect(bundleToast({ source: '' })).toBeUndefined();
  });
});
