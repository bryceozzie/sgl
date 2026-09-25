import { batch, computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import type { Autosave } from './autosave.js';
import { documentTitle } from './title.js';
import type { Pipeline } from './pipeline.js';
import type { DocumentRecord } from './storage.js';
import type { LastGood } from './types.js';

/** The slice of the pipeline a document record is built from. */
export type SessionPipeline = Pick<Pipeline, 'source' | 'model' | 'engineId' | 'engineOptions' | 'themeId' | 'lastGood'> & Partial<Pick<Pipeline, 'held'>>;

export interface DocumentSession {
  /** The open document as it stands now — DD-08 §9's whole record. */
  readonly record: ReadonlySignal<DocumentRecord>;
  /** DD-08 §7: remembered on Open, for the default save name. */
  setFileExtension(extension: string): void;
  /**
   * Make `record` the open document (fix round 2: Open as a new document,
   * the Documents list). In one batch: the pickers and options take the
   * record's values, `lastGood` is cleared (the old document's live SVG must
   * never be saved as this one's picture — until this one renders, its own
   * stored `lastGoodSvg` stands), and `loadText` puts the record's source
   * into the editor, which hands it to the pipeline. No intermediate record
   * pairing one document's id with the other's text is ever seen by
   * autosave. The caller flushes the previous document first.
   */
  switchTo(record: DocumentRecord, loadText: () => void): void;
  dispose(): void;
}

/**
 * Keeps the open document's record in step with the pipeline and hands every
 * change to autosave (DD-08 §9: "500 ms after the last change (source or
 * settings)"). The record's `engineId`/`themeId` are the *pickers'* values —
 * a document's own `@layout.engine`/`@theme` already lives in its source.
 * `lastGoodSvg` is the canvas's `lastGood.svg`, or the stored one until the
 * first live render replaces it, so a boot that never renders (a document
 * with errors) does not throw the stored picture away.
 *
 * **`lastGoodSvg` is read only when the record is** (F9 P4): after a
 * paint-only theme switch `lastGood.svg` is derived on first read, and this
 * session follows every change synchronously, inside the switch. So the
 * record carries it as a getter onto `lastGood`, and nothing here reads it:
 * two live pictures are compared by which `lastGood` they come from, never
 * by their text, and the record is handed to autosave with the getter
 * intact. The write 500 ms later (IndexedDB clones the record)
 * is what reads it — the exact bytes `render()` gives, whatever path made
 * them.
 */
export function createDocumentSession(pipeline: SessionPipeline, initial: DocumentRecord, autosave: Autosave, now: () => number): DocumentSession {
  /** The stored record the open document started from: its id, dates and
   *  stored picture. Replaced by `switchTo`. */
  const base = signal<DocumentRecord>(initial);
  const fileExtension = signal<string | undefined>(initial.fileExtension);

  const record = computed<DocumentRecord>(() => {
    const from = base.value;
    const good = pipeline.lastGood.value;
    const ext = fileExtension.value;
    const out: { -readonly [K in keyof DocumentRecord]: DocumentRecord[K] } = {
      id: from.id,
      title: documentTitle(pipeline.model.value.model),
      source: pipeline.source.value,
      engineId: pipeline.engineId.value,
      engineOptions: pipeline.engineOptions.value,
      themeId: pipeline.themeId.value,
      createdAt: from.createdAt,
      updatedAt: from.updatedAt,
    };
    if (good !== null) {
      Object.defineProperty(out, 'lastGoodSvg', { get: () => good.svg, enumerable: true, configurable: true });
      pictures.set(out, good);
    } else if (from.lastGoodSvg !== undefined) out.lastGoodSvg = from.lastGoodSvg;
    if (ext !== undefined) out.fileExtension = ext;
    // A9 (DD-08 §15.1): carried unchanged from the stored record.
    if (from.fileName !== undefined) out.fileName = from.fileName;
    if (from.group !== undefined) out.group = from.group;
    return out;
  });

  // What is known to be stored for the open document. A record equal to it
  // is not saved again — opening a document, or a render that reproduces its
  // stored picture, changes nothing — while a document created this boot or
  // this switch, whose placeholder title the pipeline has now computed
  // properly, differs and is saved straight away.
  let stored: DocumentRecord = initial;
  const dispose = effect(() => {
    const current = record.value;
    // A9 (I25): held for its imports, the model is not this document's yet.
    if (pipeline.held?.value || sameContent(current, stored)) return;
    stored = current;
    // Copied by property descriptor, so a `lastGoodSvg` getter stays one (a
    // spread would read it).
    autosave.request(Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), updatedAt: { value: now(), enumerable: true } }) as DocumentRecord);
  });

  return {
    record,
    setFileExtension(extension) {
      fileExtension.value = extension;
    },
    switchTo(next, loadText) {
      batch(() => {
        stored = next;
        base.value = next;
        fileExtension.value = next.fileExtension;
        pipeline.engineId.value = next.engineId;
        pipeline.themeId.value = next.themeId;
        pipeline.engineOptions.value = next.engineOptions;
        pipeline.lastGood.value = null;
        loadText();
      });
    },
    dispose,
  };
}

/** The live render a record's `lastGoodSvg` getter reads from. */
const pictures = new WeakMap<DocumentRecord, LastGood>();

/** Whether two records carry the same picture, without deriving a lazy one
 *  (F9 P4): two live pictures are the same when they are the same `lastGood`
 *  (a different one is a new render, so it is saved); a live picture and a
 *  stored string are compared as text, which happens only for the first live
 *  render after a boot or a switch — always a full render, whose text
 *  already exists. */
function samePicture(a: DocumentRecord, b: DocumentRecord): boolean {
  const pa = pictures.get(a);
  const pb = pictures.get(b);
  if (pa !== undefined && pb !== undefined) return pa === pb;
  return a.lastGoodSvg === b.lastGoodSvg;
}

/** Equal but for `updatedAt`, which only a save changes. `lastGoodSvg` is
 *  compared last, and never by deriving it (`samePicture`, F9 P4). */
function sameContent(a: DocumentRecord, b: DocumentRecord): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.source === b.source &&
    a.engineId === b.engineId &&
    sameValue(a.engineOptions, b.engineOptions) &&
    a.themeId === b.themeId &&
    a.createdAt === b.createdAt &&
    a.fileExtension === b.fileExtension &&
    a.fileName === b.fileName &&
    a.group === b.group &&
    samePicture(a, b)
  );
}

/** Structural equality for the plain JSON-like data in `engineOptions`,
 *  independent of key order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
