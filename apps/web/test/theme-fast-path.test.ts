import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN, neutralLight, type ThemeDoc } from '@sgl/theme';
import { render } from '@sgl/render-svg';
import { createAutosave } from '../src/state/autosave.js';
import { bootDocument } from '../src/state/boot.js';
import { createDocumentSession, type SessionPipeline } from '../src/state/document-session.js';
import { saveContent } from '../src/state/files.js';
import { decodeShareFragment, encodeShareFragment } from '../src/state/share.js';
import { createMemoryStore, type DocumentRecord, type DocumentStore } from '../src/state/storage.js';
import type { LastGood } from '../src/state/types.js';
import { createHarness, type Harness } from './harness.js';

/** Every full `render()`, paint-only restyle and pre-measure the pipeline
 *  makes, counted at the module boundary. */
const counts = vi.hoisted(() => ({ render: 0, paintOnly: 0, premeasure: 0 }));
vi.mock('@sgl/render-svg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sgl/render-svg')>();
  return {
    ...actual,
    render: (...args: Parameters<typeof actual.render>) => {
      counts.render += 1;
      return actual.render(...args);
    },
    renderPaintOnly: (...args: Parameters<typeof actual.renderPaintOnly>) => {
      const out = actual.renderPaintOnly(...args);
      if (out !== null) counts.paintOnly += 1;
      return out;
    },
  };
});
vi.mock('@sgl/measure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sgl/measure')>();
  return {
    ...actual,
    premeasure: (...args: Parameters<typeof actual.premeasure>) => {
      counts.premeasure += 1;
      return actual.premeasure(...args);
    },
  };
});

/**
 * F9 P3/P4 in the application's pipeline (DD-08 §3, §6). A change of the
 * effective theme alone — same graph, same layout, same geometry, same
 * `structureHash` — takes the paint-only path: no `render()`, no re-measure,
 * the same element tree (`paintPlan`) with a new `<style>` text; and
 * `lastGood.svg` is still exactly the bytes a full `render()` gives, derived
 * only when read. Anything else falls back to the full path.
 */

const DOC = [
  '@classes: { Hot: {} }',
  'a: { @label: "A", @type: Hot }',
  'b: { @shape: round, @label: "B" }',
  'g: { @label: "G", x: { @label: "x" }, y: { @label: "y", @style: { fill: "#abcdef" } } }',
  'a -> b: "ab"',
  'b <-> g.x: { @type: Hot }',
  'g.x -- g.y',
].join('\n');

let open: Harness[] = [];
afterEach(() => {
  for (const h of open) h.dispose();
  open = [];
});
async function harness(source: string, deps: Parameters<typeof createHarness>[1] = {}): Promise<Harness> {
  const h = await createHarness(source, { defaultThemeId: 'neutral-light', ...deps });
  open.push(h);
  return h;
}

/** What a full render of the current state would be. */
function fullRender(h: Harness): ReturnType<typeof render> {
  const good = h.pipeline.lastGood.peek()!;
  return render(good.styled, good.layout, h.pipeline.theme.peek().value);
}

function snapshot(h: Harness): { readonly good: LastGood; readonly render: number; readonly paintOnly: number; readonly premeasure: number; readonly layouts: number } {
  return { good: h.pipeline.lastGood.peek()!, render: counts.render, paintOnly: counts.paintOnly, premeasure: counts.premeasure, layouts: h.layoutRequests() };
}

describe('a theme-only change takes the paint-only path (P3)', () => {
  it('no render(), no pre-measure, no layout; the same element tree with the new <style> text, exactly a full render', async () => {
    const h = await harness(DOC);
    for (const id of ['neutral-dark', 'neutral-light', 'neutral-dark']) {
      const before = snapshot(h);
      h.pipeline.themeId.value = id;
      await h.settle();
      const good = h.pipeline.lastGood.value!;
      expect(good.styled.themeId).toBe(id);
      expect(counts.render - before.render, 'full renders').toBe(0);
      expect(counts.paintOnly - before.paintOnly, 'paint-only restyles').toBe(1);
      expect(counts.premeasure - before.premeasure, 'pre-measures').toBe(0);
      expect(h.layoutRequests() - before.layouts, 'layout requests').toBe(0);
      expect(good.layout).toBe(before.good.layout);
      expect(good.paintPlan).toBe(before.good.paintPlan); // the element tree on screen is kept
      expect(good.styleBlock).not.toBe(before.good.styleBlock);

      const counted = counts.render;
      const full = fullRender(h);
      expect(good.styleBlock).toBe(full.styleBlock);
      expect(good.svg).toBe(full.svg); // P4: the very bytes
      counts.render = counted;
    }
  });

  it('a first paint-only switch after an edit starts from that edit\'s full render', async () => {
    const h = await harness(DOC);
    h.setSource(`${DOC}\nextra: "E"`);
    await h.settle();
    const edited = snapshot(h);
    h.pipeline.themeId.value = 'neutral-dark';
    await h.settle();
    expect(counts.render - edited.render).toBe(0);
    expect(h.pipeline.lastGood.value!.paintPlan).toBe(edited.good.paintPlan);
    expect(h.pipeline.lastGood.value!.svg).toBe(fullRender(h).svg);
  });
});

describe('anything else falls back to the full path (P3)', () => {
  it('structureHash differs with the same graph geometry and layout: an inline colour edit', async () => {
    const h = await harness(DOC);
    const before = snapshot(h);
    h.setSource(DOC.replace('#abcdef', '#123456'));
    await h.settle();
    expect(h.pipeline.lastGood.value!.styled.geometryHash).toBe(before.good.styled.geometryHash);
    expect(h.pipeline.lastGood.value!.layout).toBe(before.good.layout); // layout skipped: same geometry
    expect(counts.render - before.render).toBe(1);
    expect(counts.paintOnly - before.paintOnly).toBe(0);
    expect(h.pipeline.lastGood.value!.paintPlan).not.toBe(before.good.paintPlan);
  });

  it('the graph differs: a document whose own @theme changes re-renders in full', async () => {
    const h = await harness(`@theme: "neutral-light"\n${DOC}`);
    const before = snapshot(h);
    h.setSource(`@theme: "neutral-dark"\n${DOC}`);
    await h.settle();
    expect(h.pipeline.lastGood.value!.styled.themeId).toBe('neutral-dark');
    expect(counts.render - before.render).toBe(1);
    expect(counts.paintOnly - before.paintOnly).toBe(0);
    expect(h.pipeline.lastGood.value!.svg).toBe(fullRender(h).svg);
  });

  it('the layout differs: new engine options re-lay out and re-render in full, under the same theme', async () => {
    const h = await harness(DOC);
    const before = snapshot(h);
    h.pipeline.engineOptions.value = { columns: 1 };
    await h.settle();
    expect(h.layoutRequests() - before.layouts).toBe(1);
    expect(h.pipeline.lastGood.value!.layout).not.toBe(before.good.layout);
    expect(counts.render - before.render).toBe(1);
    expect(counts.paintOnly - before.paintOnly).toBe(0);
  });

  it('the geometry differs: a theme with another stroke width re-renders in full, then again on its own layout', async () => {
    const wide: ThemeDoc = { ...neutralLight, id: 'test-wide-stroke', extends: 'neutral-dark', tokens: {}, rules: { node: { strokeWidth: 4 } }, byShape: {}, byClass: {} };
    (BUILT_IN as Record<string, ThemeDoc>)[wide.id] = wide;
    try {
      const h = await harness(DOC);
      const before = snapshot(h);
      h.pipeline.themeId.value = wide.id;
      await h.settle();
      const good = h.pipeline.lastGood.value!;
      expect(good.styled.geometryHash).not.toBe(before.good.styled.geometryHash);
      expect(counts.paintOnly - before.paintOnly).toBe(0);
      expect(counts.render - before.render).toBeGreaterThanOrEqual(1);
      expect(good.paintPlan).not.toBe(before.good.paintPlan);
      expect(good.svg).toBe(fullRender(h).svg);
    } finally {
      delete (BUILT_IN as Record<string, ThemeDoc>)[wide.id];
    }
  });
});

describe('lastGood.svg is lazy on the paint-only path (P4)', () => {
  it('is not derived by the switch itself, and is exactly render() when read', async () => {
    const h = await harness(DOC);
    h.pipeline.themeId.value = 'neutral-dark';
    const good = h.pipeline.lastGood.value!;
    expect(typeof Object.getOwnPropertyDescriptor(good, 'svg')?.get).toBe('function');
    await h.settle();
    const counted = counts.render;
    expect(good.svg).toBe(fullRender(h).svg);
    counts.render = counted;
  });
});

describe('every consumer of lastGood.svg gets exactly the bytes of a full render() (P4)', () => {
  it('autosave (and so the next boot paint, J6), Save ▾ SVG and a share link, after paint-only switches', async () => {
    const h = await harness(DOC);
    // IndexedDB stores a structured clone of the record: so does this store.
    const memory = createMemoryStore();
    const store: DocumentStore = { ...memory, putDocument: (record) => memory.putDocument(structuredClone(record)) };
    const autosave = createAutosave({
      store,
      schedule: (fn) => {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      },
      onQuotaExceeded: () => undefined,
      onError: (err) => {
        throw err;
      },
    });
    const record: DocumentRecord = { id: 'doc-1', title: 'diagram', source: DOC, engineId: 'sgl.grid', engineOptions: {}, themeId: 'neutral-light', createdAt: 1, updatedAt: 1 };
    await store.putSetting('lastOpenDocId', record.id);
    const session = createDocumentSession(h.pipeline as SessionPipeline, record, autosave, () => 2);
    try {
      for (const id of ['neutral-dark', 'neutral-light', 'neutral-dark']) {
        const before = counts.paintOnly;
        h.pipeline.themeId.value = id;
        await h.settle();
        expect(counts.paintOnly - before, id).toBe(1);
        await autosave.flush();
        const counted = counts.render;
        const full = fullRender(h).svg;
        counts.render = counted;

        // Autosave's lastGoodSvg, which the next boot paints (J6).
        const booted = await bootDocument({
          store,
          hash: '',
          exampleSource: '',
          newId: () => 'unused',
          now: () => 3,
          defaultEngineId: 'sgl.grid',
          defaultThemeId: 'neutral-light',
          isKnownEngine: () => true,
          isKnownTheme: () => true,
        });
        expect(booted.record.themeId).toBe(id);
        expect(booted.record.lastGoodSvg).toBe(full);
        // Save ▾ SVG (the export).
        const saved = saveContent('svg', { title: 'diagram', source: DOC, model: h.pipeline.model.peek().model, modelDiagnostics: [], lastGoodSvg: h.pipeline.lastGood.peek()!.svg });
        expect(saved.ok && saved.file.text).toBe(full);
        // Share carries the source and the theme, not the SVG: the receiver renders it.
        const encoded = await encodeShareFragment({ source: h.pipeline.source.peek(), engineId: h.pipeline.effectiveEngineId.peek(), themeId: h.pipeline.effectiveThemeId.peek() });
        expect(await decodeShareFragment(encoded.ok ? encoded.fragment : '')).toEqual({ kind: 'ok', payload: { source: DOC, engineId: 'sgl.grid', themeId: id } });
      }
    } finally {
      session.dispose();
      autosave.dispose();
    }
  });
});
