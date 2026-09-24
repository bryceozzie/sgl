import { elkDescriptor } from '@sgl/layout-elk/descriptor';
import { gridEngine } from '@sgl/layout-std';
import { describe, expect, it } from 'vitest';
import { editOption, engineForm, formValues, withOption } from '../src/state/engine-form.js';
import { defaultOptionsFor, optionsForEngine } from '../src/state/engine-options.js';

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

  it('bounds every number field and says why a value was refused, and which value is in use (fix round 1, item 22)', () => {
    const elkForm = engineForm('sgl.elk')!;
    const gridForm = engineForm('sgl.grid')!;
    const max = (form: typeof elkForm, key: string) => (form.fields.find((f) => f.key === key) as { max: number }).max;
    expect(max(elkForm, 'nodeSpacing')).toBe(500);
    expect(max(elkForm, 'rankSpacing')).toBe(500);
    expect(max(gridForm, 'gap')).toBe(200);
    expect(max(gridForm, 'columns')).toBe(50);

    expect(editOption('sgl.elk', {}, 'nodeSpacing', '500')).toEqual({ bag: { ...defaultOptionsFor('sgl.elk'), nodeSpacing: 500 }, rejected: null });
    const tooWide = editOption('sgl.elk', { nodeSpacing: 60 }, 'nodeSpacing', '501');
    expect(tooWide.bag).toMatchObject({ nodeSpacing: 60 });
    expect(tooWide.rejected).toBe('Node spacing must be a number from 0 to 500. Using 60.');
    expect(editOption('sgl.elk', {}, 'rankSpacing', '-1').rejected).toBe('Rank spacing must be a number from 0 to 500. Using 70.');
    expect(editOption('sgl.grid', {}, 'columns', '51').rejected).toBe('Columns must be a whole number from 1 to 50, or empty for automatic. Using auto.');
    expect(editOption('sgl.grid', {}, 'gap', '201').rejected).toBe('Gap must be a number from 0 to 200. Using 24.');

    // A stored value beyond the form's range is shown, and sent (item 3), as the default.
    expect(formValues('sgl.elk', { nodeSpacing: 9000 })).toMatchObject({ nodeSpacing: 40 });
    expect(formValues('sgl.grid', { columns: 80, gap: 999 })).toMatchObject({ columns: 'auto', gap: 24 });
    expect(optionsForEngine('sgl.grid', { columns: 'x' })).toEqual({ columns: 'auto', gap: 24, align: 'center' });
  });

  it('an engine with no hand-built form gets none, and resets to an empty bag', () => {
    expect(engineForm('org.example.other')).toBeNull();
    expect(defaultOptionsFor('org.example.other')).toEqual({});
    expect(formValues('org.example.other', { a: 1 })).toEqual({});
  });
});
