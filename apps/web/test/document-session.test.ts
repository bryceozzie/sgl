import { computed, signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { parse, resolve } from '@sgl/core';
import { createAutosave, type Autosave } from '../src/state/autosave.js';
import { createDocumentSession, type SessionPipeline } from '../src/state/document-session.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';
import type { LastGood } from '../src/state/types.js';

/** DD-08 §9 — the open document's record follows the pipeline, and every
 *  change (source or settings) goes to autosave as the whole record. */

function fakePipeline(source: string) {
  const src = signal(source);
  const pipeline = {
    source: src,
    model: computed(() => resolve(parse(src.value).ast)),
    engineId: signal('sgl.grid'),
    engineOptions: signal<Readonly<Record<string, unknown>>>({}),
    themeId: signal('neutral-light'),
    lastGood: signal<LastGood | null>(null),
  };
  return pipeline;
}

function fakeAutosave(): Autosave & { readonly requests: DocumentRecord[] } {
  const requests: DocumentRecord[] = [];
  return { requests, request: (r) => void requests.push(r), flush: async () => undefined, dispose: () => undefined };
}

const initial = (extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'doc-1',
  title: 'Flow',
  source: '@title: "Flow"\na: "A"\n',
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 5,
  updatedAt: 6,
  lastGoodSvg: '<svg id="stored"/>',
  ...extra,
});

describe('document session', () => {
  it('opening a stored document saves nothing until something changes', () => {
    const autosave = fakeAutosave();
    const pipeline = fakePipeline(initial().source);
    createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => 100);
    expect(autosave.requests).toEqual([]);
  });

  it('a document created this boot is saved straight away, with its real title', () => {
    const autosave = fakeAutosave();
    const fresh = initial({ title: 'diagram', lastGoodSvg: undefined });
    delete (fresh as { lastGoodSvg?: string }).lastGoodSvg;
    createDocumentSession(fakePipeline(fresh.source) as unknown as SessionPipeline, fresh, autosave, () => 100);
    expect(autosave.requests).toHaveLength(1);
    expect(autosave.requests[0]).toMatchObject({ id: 'doc-1', title: 'Flow', updatedAt: 100, createdAt: 5 });
  });

  it('every change requests the whole record: source, pickers, options, the live SVG', () => {
    const autosave = fakeAutosave();
    const pipeline = fakePipeline(initial().source);
    let now = 100;
    createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => now);

    pipeline.source.value = '@title: "Renamed"\na: "A"\n';
    now = 200;
    pipeline.themeId.value = 'neutral-dark';
    now = 300;
    pipeline.engineOptions.value = { columns: 3 };
    now = 400;
    pipeline.lastGood.value = { svg: '<svg id="live"/>' } as LastGood;

    expect(autosave.requests.map((r) => r.updatedAt)).toEqual([100, 200, 300, 400]);
    expect(autosave.requests.at(-1)).toEqual({
      id: 'doc-1',
      title: 'Renamed',
      source: '@title: "Renamed"\na: "A"\n',
      engineId: 'sgl.grid',
      engineOptions: { columns: 3 },
      themeId: 'neutral-dark',
      createdAt: 5,
      updatedAt: 400,
      lastGoodSvg: '<svg id="live"/>',
    });
    // Until the first live render, the stored picture is kept, not dropped.
    expect(autosave.requests[0]!.lastGoodSvg).toBe('<svg id="stored"/>');
  });

  it("never reads lastGood.svg to follow a change: autosave's record reads it when it is written (F9 P4)", () => {
    const autosave = fakeAutosave();
    const pipeline = fakePipeline(initial().source);
    const session = createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => 100);
    let reads = 0;
    const lazy = (svg: string): LastGood =>
      ({
        get svg() {
          reads += 1;
          return svg;
        },
      }) as LastGood;

    // The first live render (always a full one: its text exists) replaces
    // the stored picture; then a theme switch, whose paint-only render's
    // text does not exist until it is read. The picker and the picture
    // change one after the other, the order that costs most.
    pipeline.lastGood.value = { svg: '<svg id="light"/>' } as LastGood;
    expect(autosave.requests.at(-1)!.lastGoodSvg).toBe('<svg id="light"/>');
    pipeline.themeId.value = 'neutral-dark';
    pipeline.lastGood.value = lazy('<svg id="dark"/>');
    void session.record.value;
    expect(reads, 'following the change must not derive the SVG').toBe(0);
    const saved = autosave.requests.at(-1)!;
    expect(saved.themeId).toBe('neutral-dark');
    expect(reads).toBe(0);
    // The write itself (IndexedDB clones the record) is where it is read.
    expect(structuredClone(saved).lastGoodSvg).toBe('<svg id="dark"/>');
    expect(reads).toBe(1);
    expect(saved.lastGoodSvg).toBe('<svg id="dark"/>');
  });

  it("a switch while A's paint-only record is queued to be written: A is stored with A's own picture (fix round 1, item 2)", async () => {
    // The real autosave over a store that clones what it writes, as IndexedDB does.
    const memory = createMemoryStore();
    const writes: DocumentRecord[] = [];
    const store = { ...memory, putDocument: async (r: DocumentRecord) => void writes.push(structuredClone(r)) };
    const timers: (() => void)[] = [];
    const autosave = createAutosave({ store, schedule: (fn) => (timers.push(fn), () => undefined), onQuotaExceeded: () => undefined, onError: () => undefined });
    const pipeline = fakePipeline(initial().source);
    const session = createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => 100);
    // A's first live render (a full one, its text exists), then a paint-only
    // one, whose SVG exists only behind the getter.
    pipeline.lastGood.value = { svg: '<svg id="A-light"/>' } as LastGood;
    let derived = 0;
    pipeline.themeId.value = 'neutral-dark';
    pipeline.lastGood.value = {
      get svg() {
        derived += 1;
        return '<svg id="A-dark"/>';
      },
    } as LastGood;
    expect(derived).toBe(0); // requested, not yet written
    // The autosave timer fires: A's record leaves `pending` and is queued on
    // the write chain (issued on a later microtask). Before it is issued, the
    // tab switches to B (which clears lastGood until B renders).
    for (const fire of timers.splice(0)) fire();
    expect(derived).toBe(0);
    const b: DocumentRecord = { ...initial(), id: 'doc-2', source: '@title: "B"\nb: "B"\n', title: 'B', lastGoodSvg: '<svg id="B-stored"/>' };
    session.switchTo(b, () => {
      pipeline.source.value = b.source;
    });
    expect(pipeline.lastGood.value).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the queued write is issued now
    expect(derived).toBe(1);
    const a = writes.filter((r) => r.id === 'doc-1');
    expect(a.length).toBeGreaterThan(0);
    for (const r of a) expect(r.lastGoodSvg).toBe('<svg id="A-dark"/>');
  });

  it('remembers the extension a file was opened from (DD-08 §7)', () => {
    const autosave = fakeAutosave();
    const session = createDocumentSession(fakePipeline(initial().source) as unknown as SessionPipeline, initial(), autosave, () => 1);
    session.setFileExtension('.txt');
    expect(session.record.value.fileExtension).toBe('.txt');
    expect(autosave.requests.at(-1)?.fileExtension).toBe('.txt');
  });

  describe('switching to another record (fix round 2: Open as a new document, the Documents list)', () => {
    const other = (extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
      id: 'doc-2',
      title: 'Other',
      source: '@title: "Other"\nb: "B"\n',
      engineId: 'sgl.grid',
      engineOptions: { columns: 2 },
      themeId: 'neutral-dark',
      createdAt: 50,
      updatedAt: 60,
      lastGoodSvg: '<svg id="other-stored"/>',
      fileExtension: '.txt',
      ...extra,
    });

    it('the record becomes the other one, with its pickers, extension and stored picture — never the old live SVG', () => {
      const autosave = fakeAutosave();
      const pipeline = fakePipeline(initial().source);
      const session = createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => 100);
      pipeline.lastGood.value = { svg: '<svg id="doc-1-live"/>' } as LastGood;
      autosave.requests.length = 0;

      session.switchTo(other(), () => {
        pipeline.source.value = other().source;
      });

      expect(session.record.value).toEqual(other());
      expect(pipeline.engineOptions.value).toEqual({ columns: 2 });
      expect(pipeline.themeId.value).toBe('neutral-dark');
      expect(pipeline.lastGood.value).toBeNull();
      // Nothing changed relative to what is stored: no save, so merely
      // opening a document does not reorder the list.
      expect(autosave.requests).toEqual([]);
    });

    it('never requests a record that pairs the new id with the old text (or the old id with the new text)', () => {
      const autosave = fakeAutosave();
      const pipeline = fakePipeline(initial().source);
      const session = createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => 100);
      const fresh = other({ title: 'diagram', lastGoodSvg: undefined });
      delete (fresh as { lastGoodSvg?: string }).lastGoodSvg;
      session.switchTo(fresh, () => {
        pipeline.source.value = fresh.source;
      });
      // A new record's placeholder title differs from its computed one: saved.
      expect(autosave.requests).toHaveLength(1);
      expect(autosave.requests[0]).toMatchObject({ id: 'doc-2', title: 'Other', source: fresh.source, createdAt: 50, updatedAt: 100 });
      for (const r of autosave.requests) expect(r.id === 'doc-2').toBe(r.source === fresh.source);

      // Later edits go to the new record.
      pipeline.source.value = '@title: "Other"\nb: "B"\nc: "C"\n';
      expect(autosave.requests.at(-1)).toMatchObject({ id: 'doc-2', source: '@title: "Other"\nb: "B"\nc: "C"\n' });
    });
  });

  it('dispose stops following the pipeline', () => {
    const autosave = fakeAutosave();
    const pipeline = fakePipeline(initial().source);
    const session = createDocumentSession(pipeline as unknown as SessionPipeline, initial(), autosave, () => 1);
    session.dispose();
    pipeline.source.value = 'b\n';
    expect(autosave.requests).toEqual([]);
  });
});
