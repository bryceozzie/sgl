import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import { create, safeId, type BootNotice, type ShareImport, type ShareImportDeps } from './boot.js';
import type { DocumentRecord } from './storage.js';

/**
 * Share by URL (DD-08 §8): `#s={base64url(deflate-raw(utf8(source)))}&e={engineId}&t={themeId}`,
 * and, for a document with imports, `&i={base64url(deflate-raw(utf8(JSON)))}`
 * carrying the documents it imports (A9, DD-08 §15.3).
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
 *  whole bomb before the cap could be checked. Exported for the test that
 *  holds every write to it (`test/share.test.ts`). */
export const INFLATE_SLICE_BYTES = 512;

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

/** A document a link carries for the main one to import (I26): the name it
 *  was imported by (`n`, normalised), its title and its source. */
export interface SharedImport {
  readonly n: string;
  readonly t: string;
  readonly s: string;
}

/** DD-08 §15.3, I28: the most documents one `i=` may carry (DD-02 I21's
 *  64 import instances). */
export const SHARE_MAX_IMPORTS = 64;

export interface SharePayload {
  readonly source: string;
  /** Absent when the link carries no `e=`/`t=`: the receiver keeps its own. */
  readonly engineId?: string;
  readonly themeId?: string;
  /** The documents `i=` carries (A9, I26). */
  readonly imports?: readonly SharedImport[];
  /** An `i=` that could not be read (`invalid`: I28) or is of a version
   *  this app does not know (`version`): the link still opens, without it. */
  readonly importsProblem?: 'invalid' | 'version';
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

/** `ok: false` when this browser cannot compress at all — no
 *  `CompressionStream` (an older engine, or one that locks it down) — or the
 *  compressor errors. The Share button toasts and offers the file save. */
export type ShareEncodeResult = { readonly ok: true; readonly fragment: string } | { readonly ok: false };

/** The fragment (no leading `#`) for `payload`. Never rejects (fix round 1,
 *  item 11): a missing or failing compressor is a value. */
export async function encodeShareFragment(payload: SharePayload, codec: ShareCodec = NATIVE_SHARE_CODEC): Promise<ShareEncodeResult> {
  let compressed: Uint8Array;
  let imports: Uint8Array | undefined;
  try {
    compressed = await deflateRaw(new TextEncoder().encode(payload.source), codec);
    // A second stream rather than one shared with `s=` (I26): every
    // existing link, and every older build reading this one, keeps working.
    if (payload.imports !== undefined && payload.imports.length > 0) {
      imports = await deflateRaw(new TextEncoder().encode(JSON.stringify({ v: 1, d: payload.imports.map(({ n, t, s }) => ({ n, t, s })) })), codec);
    }
  } catch {
    return { ok: false };
  }
  let fragment = `s=${encodeBase64Url(compressed)}`;
  if (payload.engineId !== undefined) fragment += `&e=${encodeURIComponent(payload.engineId)}`;
  if (payload.themeId !== undefined) fragment += `&t=${encodeURIComponent(payload.themeId)}`;
  if (imports !== undefined) fragment += `&i=${encodeBase64Url(imports)}`;
  return { ok: true, fragment };
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

  const text = await inflateText(s, codec, cap);
  if (typeof text !== 'string') return { kind: 'invalid', reason: text.reason };

  const e = params.get('e');
  const t = params.get('t');
  const i = params.get('i');
  return {
    kind: 'ok',
    payload: {
      source: text,
      ...(e !== null && e !== '' ? { engineId: e } : {}),
      ...(t !== null && t !== '' ? { themeId: t } : {}),
      ...(i !== null ? await decodeImports(i, codec, cap) : {}),
    },
  };
}

/** One base64url deflate-raw stream as UTF-8 text, inflated under `cap`. */
async function inflateText(encoded: string, codec: ShareCodec, cap: number): Promise<string | { readonly reason: 'corrupt' | 'oversize' }> {
  // A deflate stream is never much larger than its input (stored blocks add 5
  // bytes per 64 KiB), so a fragment whose compressed payload alone is well
  // past the cap cannot inflate to something under it: refuse it before even
  // decoding the base64.
  if (encoded.length > Math.ceil(((cap + 1024) * 4) / 3) + 1024) return { reason: 'oversize' };

  const compressed = decodeBase64Url(encoded);
  if (compressed === null || compressed.length === 0) return { reason: 'corrupt' };

  const inflated = await inflateRawCapped(compressed, cap, codec);
  if (!inflated.ok) return { reason: inflated.reason };

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(inflated.bytes);
  } catch {
    return { reason: 'corrupt' };
  }
}

/**
 * `i=` (A9, DD-08 §15.3, I28): under its own 2 MB inflated cap, valid
 * UTF-8, `{"v":1,"d":[…]}` with at most 64 entries, each with a non-empty
 * string `n` and string `t` and `s`. A bad one does not invalidate the link:
 * it comes back as `importsProblem`, and the main document still opens.
 */
async function decodeImports(i: string, codec: ShareCodec, cap: number): Promise<Pick<SharePayload, 'imports' | 'importsProblem'>> {
  const text = await inflateText(i, codec, cap);
  let bundle: unknown;
  try {
    bundle = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    // below
  }
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return { importsProblem: 'invalid' };
  const { v, d } = bundle as { v?: unknown; d?: unknown };
  if (v !== 1) return { importsProblem: 'version' };
  if (!Array.isArray(d) || d.length > SHARE_MAX_IMPORTS) return { importsProblem: 'invalid' };
  const imports: SharedImport[] = [];
  for (const item of d as unknown[]) {
    const { n, t, s } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof n !== 'string' || n === '' || typeof t !== 'string' || typeof s !== 'string') return { importsProblem: 'invalid' };
    imports.push({ n, t, s });
  }
  return imports.length > 0 ? { imports } : {};
}

/**
 * Stores what a share link opened (A9, I29; boot calls it, fix round 1 item
 * 16 moved it here, off the boot path): the documents it imports as new
 * records in a new group with the main one, not remembered as the one to
 * open, then the main one, which is. `create` is boot's (engine and theme
 * already chosen). Returns the main record and boot's toast.
 */
export async function openShared(
  payload: SharePayload,
  create: (source: string, extra?: Partial<DocumentRecord>, open?: boolean) => Promise<DocumentRecord>,
  newId: () => string,
): Promise<{ readonly record: DocumentRecord; readonly toast: ReturnType<typeof bundleToast> }> {
  const group = payload.imports && newId();
  for (const d of payload.imports ?? []) await create(d.s, { title: d.t, fileName: `${d.n}.sgl`, group: group as string }, false);
  return { record: await create(payload.source, group ? { group } : undefined), toast: bundleToast(payload) };
}

/**
 * Stores a decoded link's documents (DD-08 §8; I29) and returns the main
 * one, to open: boot's path for a link on load, and — since F13 — the open
 * tab's for a link pasted into it, which then switches to the record in
 * place, as Open does (`App.tsx`), instead of reloading into boot. One
 * import path either way, in this lazy chunk. An engine or theme the app
 * does not know falls back to the default; a storage failure is a notice.
 */
export async function importShare(deps: ShareImportDeps, payload: SharePayload): Promise<ShareImport> {
  const notices: BootNotice[] = [];
  const engineId = payload.engineId !== undefined && deps.isKnownEngine(payload.engineId) ? payload.engineId : deps.defaultEngineId;
  const themeId = payload.themeId !== undefined && deps.isKnownTheme(payload.themeId) ? payload.themeId : deps.defaultThemeId;
  const { record, toast } = await openShared(payload, (source, extra, open) => create(deps, notices, source, engineId, themeId, extra, open), () => safeId(deps));
  return { record, notices: payload.imports ? notices : ['share-opened', ...notices], ...(toast ? { toasts: [toast] } : {}) };
}

/** What boot says about a link's imported documents (I28, I29), if
 *  anything: they were opened too, or could not be read. */
export function bundleToast(payload: SharePayload): { readonly message: string; readonly kind: 'info' | 'error' } | undefined {
  const n = payload.imports?.length ?? 0;
  if (n > 0) return { message: `Opened the shared diagram and its ${n === 1 ? 'imported document' : `${n} imported documents`} as new documents.`, kind: 'info' };
  if (payload.importsProblem === 'invalid') return { message: 'Opened the shared diagram, but its imported documents could not be read.', kind: 'error' };
  if (payload.importsProblem === 'version') return { message: 'Opened the shared diagram without its imported documents: this link is from a newer version of SGL.', kind: 'error' };
  return undefined;
}
