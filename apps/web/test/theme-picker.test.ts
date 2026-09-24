import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentSession, type SessionPipeline } from '../src/state/document-session.js';
import { selectTheme } from '../src/state/picker-actions.js';
import type { TextChange } from '../src/state/root-config-edit.js';
import { decodeShareFragment, encodeShareFragment } from '../src/state/share.js';
import type { Autosave } from '../src/state/autosave.js';
import type { DocumentRecord } from '../src/state/storage.js';
import { createHarness, type Harness } from './harness.js';

/** Every `render()` the pipeline makes, counted at the module boundary. */
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@sgl/render-svg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sgl/render-svg')>();
  return {
    ...actual,
    render: (...args: Parameters<typeof actual.render>) => {
      renders.count += 1;
      return actual.render(...args);
    },
  };
});

/**
 * Theme ▾ end to end over the real pipeline (DD-08 §10). P1 (human decision,
 * 2026-09-24): the picker is a view preference — with no `@theme` it sets
 * `themeId` and nothing else, which the record persists and a share link's
 * `t=` carries; with `@theme` it edits that entry in place. P2
 * (orchestrator): one pick is one paint, whichever it does.
 */

const DOC = 'a: { @label: "A" }\nb: { @label: "B" }\nc: { @shape: round, @label: "C" }\na -> b: "ab"\nb -> c\n';

const applyChange = (text: string, c: TextChange): string => text.slice(0, c.from) + c.insert + text.slice(c.to);

/** The Theme ▾ `select(id)` with an editor that applies the change to the
 *  pipeline the way CodeMirror's `updateListener` does. */
function pick(h: Harness, id: string): ReturnType<typeof selectTheme> {
  return selectTheme(h.pipeline, id, (change) => h.setSource(applyChange(h.pipeline.source.peek(), change)));
}

function fakeAutosave(): Autosave & { readonly requests: DocumentRecord[] } {
  const requests: DocumentRecord[] = [];
  return { requests, request: (r) => void requests.push(r), flush: async () => undefined, dispose: () => undefined };
}

const record = (source: string): DocumentRecord => ({
  id: 'doc-1',
  title: 'diagram',
  source,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 1,
  updatedAt: 1,
});

let open: Harness[] = [];
afterEach(() => {
  for (const h of open) h.dispose();
  open = [];
});
async function harness(source: string, themeId = 'neutral-light'): Promise<Harness> {
  const h = await createHarness(source, { defaultThemeId: themeId });
  open.push(h);
  return h;
}

describe('Theme ▾ is a view preference (P1)', () => {
  it('with no @theme: the source is untouched, themeId is set, and the canvas shows the pick', async () => {
    const h = await harness(DOC);
    expect(pick(h, 'neutral-dark')).toBeNull();
    await h.settle();
    expect(h.pipeline.source.value).toBe(DOC);
    expect(h.pipeline.themeId.value).toBe('neutral-dark');
    expect(h.pipeline.documentThemeId.value).toBeUndefined(); // the label stays "Theme", not "(set by document)"
    expect(h.pipeline.effectiveThemeId.value).toBe('neutral-dark');
    expect(h.pipeline.lastGood.value?.styled.themeId).toBe('neutral-dark');
  });

  it('the choice is persisted on the record and survives a reload', async () => {
    const h = await harness(DOC);
    const autosave = fakeAutosave();
    const session = createDocumentSession(h.pipeline as SessionPipeline, record(DOC), autosave, () => 2);
    pick(h, 'neutral-dark');
    await h.settle();
    const saved = autosave.requests.at(-1)!;
    expect(saved.themeId).toBe('neutral-dark');
    expect(saved.source).toBe(DOC);
    session.dispose();

    // A reload boots the pipeline from the stored record (App: `defaultThemeId: boot.record.themeId`).
    const reloaded = await harness(saved.source, saved.themeId);
    expect(reloaded.pipeline.effectiveThemeId.value).toBe('neutral-dark');
    expect(reloaded.pipeline.lastGood.value?.styled.themeId).toBe('neutral-dark');
  });

  it("travels in a share link's t=, with the source as it was", async () => {
    const h = await harness(DOC);
    pick(h, 'neutral-dark');
    // What FileMenu's Share encodes: the source and the *effective* engine and theme.
    const encoded = await encodeShareFragment({ source: h.pipeline.source.peek(), engineId: h.pipeline.effectiveEngineId.peek(), themeId: h.pipeline.effectiveThemeId.peek() });
    expect(encoded.ok).toBe(true);
    const decoded = await decodeShareFragment(encoded.ok ? encoded.fragment : '');
    expect(decoded).toEqual({ kind: 'ok', payload: { source: DOC, engineId: 'sgl.grid', themeId: 'neutral-dark' } });
  });

  it('with @theme: the entry is edited in place, and @theme still overrides the picker ("set by document")', async () => {
    const source = `@theme: "neutral-light"\n${DOC}`;
    const h = await harness(source, 'neutral-dark'); // a record whose picker says dark
    expect(h.pipeline.documentThemeId.value).toBe('neutral-light');
    expect(h.pipeline.effectiveThemeId.value).toBe('neutral-light'); // the document wins
    pick(h, 'neutral-dark');
    await h.settle();
    expect(h.pipeline.source.value).toBe(`@theme: "neutral-dark"\n${DOC}`);
    expect(h.pipeline.documentThemeId.value).toBe('neutral-dark');
    expect(h.pipeline.lastGood.value?.styled.themeId).toBe('neutral-dark');

    // The picker's own signal cannot move it while the document names a theme.
    h.pipeline.themeId.value = 'neutral-light';
    await h.settle();
    expect(h.pipeline.effectiveThemeId.value).toBe('neutral-dark');
  });
});

describe('one pick is one paint (P2)', () => {
  // The last column: full `render()`s per pick. Without `@theme` the pick is
  // paint-only (P3): the one paint is a `<style>` swap, no render at all.
  const CASES: readonly (readonly [string, string, number])[] = [
    ['no @theme (the picker sets themeId only)', DOC, 0],
    ['@theme (the picker sets themeId and edits the entry)', `@theme: "neutral-light"\n${DOC}`, 1],
    // Not an override (not a string), so the themeId write alone changes the
    // effective theme, and the edit then changes the document too: without
    // one batch, that is two paints.
    ['a non-string @theme (both halves of the pick repaint)', `@theme: 42\n${DOC}`, 1],
  ];
  for (const [what, source, fullRenders] of CASES) {
    it(what, async () => {
      const h = await harness(source);
      for (const id of ['neutral-dark', 'neutral-light', 'neutral-dark']) {
        const writes = h.lastGoodWrites();
        const before = renders.count;
        const layouts = h.layoutRequests();
        pick(h, id);
        // Synchronously, before anything asynchronous could add a paint.
        expect(h.lastGoodWrites() - writes, `${id}: lastGood writes`).toBe(1);
        expect(h.pipeline.lastGood.value?.styled.themeId).toBe(id);
        await h.settle();
        expect(h.lastGoodWrites() - writes, `${id}: lastGood writes once idle`).toBe(1);
        expect(renders.count - before, `${id}: full renders`).toBe(fullRenders);
        expect(h.layoutRequests() - layouts, `${id}: layout requests`).toBe(0);
      }
    });
  }
});
