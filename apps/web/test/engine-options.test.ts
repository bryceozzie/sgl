import { elkDescriptor } from '@sgl/layout-elk/descriptor';
import { gridEngine } from '@sgl/layout-std';
import { describe, expect, it } from 'vitest';
import { defaultOptionsFor, engineForm, formValues, withOption } from '../src/state/engine-options.js';

/** F11 (DD-08 §10, Stage K decision K9): one hand-built form per engine,
 *  DOM-free. `toolbar/EngineOptions.tsx` only renders this. */
describe('engine options form (F11)', () => {
  it('elk: direction, node spacing, rank spacing, edge routing, node placement — with DD-06 §6 defaults', () => {
    const form = engineForm(elkDescriptor.id)!;
    expect(form.fields.map((f) => [f.key, f.label])).toEqual([
      ['direction', 'Direction'],
      ['nodeSpacing', 'Node spacing'],
      ['rankSpacing', 'Rank spacing'],
      ['edgeRouting', 'Edge routing'],
      ['nodePlacement', 'Node placement'],
    ]);
    expect(defaultOptionsFor(elkDescriptor.id)).toEqual({
      direction: 'down',
      nodeSpacing: 40,
      rankSpacing: 70,
      edgeRouting: 'ORTHOGONAL',
      nodePlacement: 'BRANDES_KOEPF',
    });
  });

  it('grid: columns, gap, align — with DD-06 §7 defaults', () => {
    const form = engineForm(gridEngine.id)!;
    expect(form.fields.map((f) => [f.key, f.label])).toEqual([
      ['columns', 'Columns'],
      ['gap', 'Gap'],
      ['align', 'Align'],
    ]);
    expect(defaultOptionsFor(gridEngine.id)).toEqual({ columns: 'auto', gap: 24, align: 'center' });
  });

  it("every select choice and default is one the engine's optionsSchema allows", () => {
    for (const engine of [elkDescriptor, gridEngine]) {
      const props = (engine.optionsSchema as { properties: Record<string, { enum?: readonly string[]; default?: unknown }> }).properties;
      const form = engineForm(engine.id)!;
      for (const field of form.fields) {
        const schema = props[field.key];
        expect(schema, `${engine.id}.${field.key}`).toBeDefined();
        expect(form.defaults[field.key]).toEqual(schema!.default);
        if (field.kind === 'select') expect(field.choices.map((c) => c.value).sort()).toEqual([...(schema!.enum ?? [])].sort());
      }
    }
  });

  it('normalises an untrusted bag: allowed values kept, anything else shown as the default', () => {
    expect(formValues('sgl.elk', { direction: 'left', nodeSpacing: 'x', columns: 3 })).toEqual({ ...defaultOptionsFor('sgl.elk'), direction: 'left' });
    expect(formValues('sgl.grid', { columns: 2.5, gap: -1, align: 'end', direction: 'up' })).toEqual(defaultOptionsFor('sgl.grid'));
    expect(formValues('sgl.grid', { columns: 3, gap: 0, align: 'start' })).toEqual({ columns: 3, gap: 0, align: 'start' });
  });

  it('withOption writes the whole normalised bag, and ignores an unusable value', () => {
    expect(withOption('sgl.elk', {}, 'direction', 'right')).toEqual({ ...defaultOptionsFor('sgl.elk'), direction: 'right' });
    expect(withOption('sgl.elk', { rankSpacing: 50 }, 'nodeSpacing', '12')).toMatchObject({ nodeSpacing: 12, rankSpacing: 50 });
    expect(withOption('sgl.elk', { nodeSpacing: 12 }, 'nodeSpacing', '')).toMatchObject({ nodeSpacing: 12 });
    expect(withOption('sgl.elk', { nodeSpacing: 12 }, 'nodeSpacing', '-3')).toMatchObject({ nodeSpacing: 12 });
    expect(withOption('sgl.elk', {}, 'edgeRouting', 'CURVY')).toMatchObject({ edgeRouting: 'ORTHOGONAL' });
    expect(withOption('sgl.grid', {}, 'columns', '4')).toEqual({ columns: 4, gap: 24, align: 'center' });
    expect(withOption('sgl.grid', { columns: 4 }, 'columns', '')).toMatchObject({ columns: 'auto' });
    expect(withOption('sgl.grid', { columns: 4 }, 'columns', '1.5')).toMatchObject({ columns: 4 });
  });

  it('an engine with no hand-built form gets none, and resets to an empty bag', () => {
    expect(engineForm('org.example.other')).toBeNull();
    expect(defaultOptionsFor('org.example.other')).toEqual({});
    expect(formValues('org.example.other', { a: 1 })).toEqual({});
  });
});
