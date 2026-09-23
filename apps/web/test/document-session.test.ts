import { computed, signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { parse, resolve } from '@sgl/core';
import type { Autosave } from '../src/state/autosave.js';
import { createDocumentSession, type SessionPipeline } from '../src/state/document-session.js';
import type { DocumentRecord } from '../src/state/storage.js';
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

  it('remembers the extension a file was opened from (DD-08 §7)', () => {
    const autosave = fakeAutosave();
    const session = createDocumentSession(fakePipeline(initial().source) as unknown as SessionPipeline, initial(), autosave, () => 1);
    session.setFileExtension('.txt');
    expect(session.record.value.fileExtension).toBe('.txt');
    expect(autosave.requests.at(-1)?.fileExtension).toBe('.txt');
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
