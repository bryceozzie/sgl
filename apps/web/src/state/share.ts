import { decodeBase64Url, encodeBase64Url } from './base64url.js';

/**
 * Share by URL (DD-08 §8): `#s={base64url(deflate-raw(utf8(source)))}&e={engineId}&t={themeId}`.
 * DOM-free — the compression streams are injected (`ShareCodec`), defaulting
 * to the platform's own `CompressionStream`/`DecompressionStream`, which Node
 * has too, so every branch here runs in the unit project.
 */

/** DD-08 §8 / DD-09 §1.1: the decompression-bomb guard. Inflation stops the
 *  moment output passes this, rather than inflating everything and checking. */
export const SHARE_INFLATED_CAP = 2 * 1024 * 1024;

/** DD-08 §8: above this, the Share dialog warns that chats and browsers
 *  truncate long URLs and offers the file save instead. Measured on the whole
 *  link — what actually gets pasted and truncated — not only the fragment. */
export const SHARE_LINK_WARN_LENGTH = 8000;

/** Compressed input is fed to the decompressor this many bytes at a time.
 *  A `TransformStream` inflates each written chunk in full, whatever the
 *  reader does, so the chunk size is what bounds the overshoot past the cap:
 *  deflate's maximum ratio is about 1032:1, so a 512-byte slice can add at
 *  most about 0.5 MB. Writing the whole payload as one chunk would inflate the
 *  whole bomb before the cap could be checked. */
const INFLATE_SLICE_BYTES = 512;

export interface ByteTransform {
  readonly writable: WritableStream<Uint8Array>;
  readonly readable: ReadableStream<Uint8Array>;
}

export interface ShareCodec {
  readonly compress: () => ByteTransform;
  readonly decompress: () => ByteTransform;
}

export const NATIVE_SHARE_CODEC: ShareCodec = {
  compress: () => new CompressionStream('deflate-raw') as unknown as ByteTransform,
  decompress: () => new DecompressionStream('deflate-raw') as unknown as ByteTransform,
};

export interface SharePayload {
  readonly source: string;
  /** Absent when the link carries no `e=`/`t=`: the receiver keeps its own. */
  readonly engineId?: string;
  readonly themeId?: string;
}

export type ShareDecodeResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly payload: SharePayload }
  | { readonly kind: 'invalid'; readonly reason: 'corrupt' | 'oversize' };

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  return concat(chunks, total);
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function deflateRaw(bytes: Uint8Array, codec: ShareCodec = NATIVE_SHARE_CODEC): Promise<Uint8Array> {
  const stream = codec.compress();
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes).then(() => writer.close());
  const [out] = await Promise.all([readAll(stream.readable), writing]);
  return out;
}

export type InflateResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: 'corrupt' | 'oversize' };

/**
 * Inflate `bytes`, stopping as soon as the output exceeds `cap`: the reader is
 * cancelled, which errors the writable side and ends the feeding loop, so
 * nothing past that point is ever decompressed. A malformed or truncated
 * stream is `corrupt`.
 */
export async function inflateRawCapped(bytes: Uint8Array, cap: number, codec: ShareCodec = NATIVE_SHARE_CODEC): Promise<InflateResult> {
  let stream: ByteTransform;
  try {
    stream = codec.decompress();
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const writer = stream.writable.getWriter();
  const feeding = (async () => {
    try {
      for (let at = 0; at < bytes.length; at += INFLATE_SLICE_BYTES) await writer.write(bytes.subarray(at, at + INFLATE_SLICE_BYTES));
      await writer.close();
    } catch {
      // The reader cancelled (cap reached) or the decompressor errored
      // (corrupt input): either way the read loop below reports it.
    }
  })();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        await feeding;
        return { ok: false, reason: 'oversize' };
      }
      chunks.push(value);
    }
  } catch {
    await feeding;
    return { ok: false, reason: 'corrupt' };
  }
  await feeding;
  return { ok: true, bytes: concat(chunks, total) };
}

/** The fragment (no leading `#`) for `payload`. */
export async function encodeShareFragment(payload: SharePayload, codec: ShareCodec = NATIVE_SHARE_CODEC): Promise<string> {
  const compressed = await deflateRaw(new TextEncoder().encode(payload.source), codec);
  let fragment = `s=${encodeBase64Url(compressed)}`;
  if (payload.engineId !== undefined) fragment += `&e=${encodeURIComponent(payload.engineId)}`;
  if (payload.themeId !== undefined) fragment += `&t=${encodeURIComponent(payload.themeId)}`;
  return fragment;
}

/** The whole link: `base` (origin + path, no hash) plus the fragment. */
export function shareLink(base: string, fragment: string): string {
  return `${base}#${fragment}`;
}

export function isLongShareLink(link: string): boolean {
  return link.length > SHARE_LINK_WARN_LENGTH;
}

/**
 * Decode `location.hash` (with or without its leading `#`). `none` when the
 * hash carries no `s=` at all — an ordinary load, not a share link. A present
 * but unusable `s=` is `invalid`: bad base64url, a malformed deflate stream,
 * output that is not UTF-8, or output past `cap` (`oversize`).
 */
export async function decodeShareFragment(
  hash: string,
  codec: ShareCodec = NATIVE_SHARE_CODEC,
  cap: number = SHARE_INFLATED_CAP,
): Promise<ShareDecodeResult> {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const s = params.get('s');
  if (s === null) return { kind: 'none' };

  // A deflate stream is never much larger than its input (stored blocks add 5
  // bytes per 64 KiB), so a fragment whose compressed payload alone is well
  // past the cap cannot inflate to something under it: refuse it before even
  // decoding the base64.
  if (s.length > Math.ceil(((cap + 1024) * 4) / 3) + 1024) return { kind: 'invalid', reason: 'oversize' };

  const compressed = decodeBase64Url(s);
  if (compressed === null || compressed.length === 0) return { kind: 'invalid', reason: 'corrupt' };

  const inflated = await inflateRawCapped(compressed, cap, codec);
  if (!inflated.ok) return { kind: 'invalid', reason: inflated.reason };

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(inflated.bytes);
  } catch {
    return { kind: 'invalid', reason: 'corrupt' };
  }

  const e = params.get('e');
  const t = params.get('t');
  return {
    kind: 'ok',
    payload: { source, ...(e !== null && e !== '' ? { engineId: e } : {}), ...(t !== null && t !== '' ? { themeId: t } : {}) },
  };
}
