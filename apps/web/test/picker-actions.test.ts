import { computed, signal } from '@preact/signals';
import { parse, type Document as SglDocument, type StageResult } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { selectEngine, selectTheme, type PickerPipeline } from '../src/state/picker-actions.js';

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

  it('selectTheme sets themeId, leaves engineOptions alone, and writes @theme', () => {
    const text = 'a: "A"\n';
    const pipeline = pickerPipeline(text);
    const change = selectTheme(pipeline, 'neutral-dark');

    expect(pipeline.themeId.value).toBe('neutral-dark');
    expect(pipeline.engineOptions.value).toEqual({ columns: 3, gap: 12 });
    expect(apply(text, change)).toBe('@theme: "neutral-dark"\na: "A"\n');
  });
});
