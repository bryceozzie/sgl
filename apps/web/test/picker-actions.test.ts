import { computed, signal } from '@preact/signals';
import { parse, type Document as SglDocument, type StageResult } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { selectEngine, selectTheme, type PickerPipeline } from '../src/state/picker-actions.js';
import type { TextChange } from '../src/state/root-config-edit.js';

/** The slice of the pipeline the pickers touch, with `parsed` derived from
 *  `source`. (That the app itself never calls `parse` — DD-08 §4 — is
 *  enforced by lint: `eslint.config.js` restricts importing it anywhere in
 *  `apps/web/src` but `pipeline.ts`.) */
function pickerPipeline(text: string): PickerPipeline {
  const source = signal(text);
  const parsed = computed<StageResult<SglDocument>>(() => {
    const { ast, diagnostics } = parse(source.value);
    return { value: ast, diagnostics };
  });
  return {
    themeId: signal('neutral-light'),
    engineId: signal('sgl.grid'),
    engineOptions: signal<Readonly<Record<string, unknown>>>({ columns: 3, gap: 12 }),
    source,
    parsed,
  };
}

function apply(text: string, change: { from: number; to: number; insert: string }): string {
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}

describe('picker actions (DD-08 §10)', () => {
  it("selectEngine sets engineId, resets engineOptions to that engine's defaults (F11), and writes @layout.engine", () => {
    const text = '@layout: { engine: "sgl.grid" }\na: "A"\n';
    const pipeline = pickerPipeline(text);
    const change = selectEngine(pipeline, 'sgl.elk');

    expect(pipeline.engineId.value).toBe('sgl.elk');
    // elk's own defaults; the previous engine's { columns, gap } do not leak.
    expect(pipeline.engineOptions.value).toEqual({ direction: 'down', nodeSpacing: 40, rankSpacing: 70, edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF' });
    expect(apply(text, change)).toBe('@layout: { engine: "sgl.elk" }\na: "A"\n');
  });

  it('selectEngine resets engineOptions even when re-selecting the current engine', () => {
    const pipeline = pickerPipeline('a: "A"\n');
    selectEngine(pipeline, 'sgl.grid');
    expect(pipeline.engineOptions.value).toEqual({ columns: 'auto', gap: 24, align: 'center' });
  });

  it('selectTheme with no @theme in the document is a view preference: it sets themeId and leaves the source alone (P1)', () => {
    const text = 'a: "A"\n';
    const pipeline = pickerPipeline(text);
    const dispatched: TextChange[] = [];
    const change = selectTheme(pipeline, 'neutral-dark', (c) => dispatched.push(c));

    expect(pipeline.themeId.value).toBe('neutral-dark');
    expect(pipeline.engineOptions.value).toEqual({ columns: 3, gap: 12 });
    expect(change).toBeNull();
    expect(dispatched).toEqual([]);
    expect(pipeline.source.value).toBe(text);
  });

  it('selectTheme edits an existing @theme entry in place, and still sets themeId (P1)', () => {
    const text = 'a: "A"\n@theme: "neutral-light"\nb: "B"\n';
    const pipeline = pickerPipeline(text);
    const dispatched: TextChange[] = [];
    const change = selectTheme(pipeline, 'neutral-dark', (c) => dispatched.push(c));

    expect(pipeline.themeId.value).toBe('neutral-dark');
    expect(dispatched).toEqual([change]);
    expect(apply(text, change!)).toBe('a: "A"\n@theme: "neutral-dark"\nb: "B"\n');
  });

  it('selectTheme edits the last @theme entry, whatever its value, and never inserts a second one (P1)', () => {
    const text = '@theme: "neutral-light"\na: "A"\n@theme: 42\n';
    const pipeline = pickerPipeline(text);
    const change = selectTheme(pipeline, 'neutral-dark', () => undefined);
    expect(apply(text, change!)).toBe('@theme: "neutral-light"\na: "A"\n@theme: "neutral-dark"\n');
  });
});
