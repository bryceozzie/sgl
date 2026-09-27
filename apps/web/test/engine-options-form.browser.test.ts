import { signal } from '@preact/signals';
import { h, render as mount } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pipeline } from '../src/state/pipeline.js';
import { EngineOptionsForm } from '../src/toolbar/engine-options-form.js';

/**
 * DD-12 H6, DD-08 §10: the options form in a real DOM when the document's
 * root `@layout` sets an option. The field shows the document's value, is
 * disabled, and its label says it is set by the document, as Engine ▾'s does.
 */

afterEach(() => {
  mount(null, document.body);
  document.body.replaceChildren();
});

function mountForm(documentOptions: Readonly<Record<string, unknown>>) {
  const pipeline = {
    effectiveEngineId: signal('sgl.elk'),
    engineOptions: signal<Readonly<Record<string, unknown>>>({ direction: 'down', nodeSpacing: 12 }),
    documentOptions: signal(documentOptions),
  };
  mount(h(EngineOptionsForm, { pipeline: pipeline as unknown as Pipeline }), document.body);
  const field = (key: string) => {
    const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${key}"]`)!;
    return { value: control.value, disabled: control.disabled, label: document.querySelector(`label[for="${control.id}"]`)!.textContent };
  };
  return { pipeline, field };
}

describe('the options form: a field the document sets (DD-12 H6)', () => {
  it('shows the effective value, disabled, labelled "set by document"; the others stay editable', async () => {
    const { pipeline, field } = mountForm({ direction: 'right', rankSpacing: 20 });
    expect(field('direction')).toEqual({ value: 'right', disabled: true, label: 'Direction (set by document)' });
    expect(field('rankSpacing')).toEqual({ value: '20', disabled: true, label: 'Rank spacing (set by document)' });
    expect(field('nodeSpacing')).toEqual({ value: '12', disabled: false, label: 'Node spacing' });

    // The document stops setting it: the stored bag's value, editable again.
    pipeline.documentOptions.value = {};
    await expect.poll(() => field('direction')).toEqual({ value: 'down', disabled: false, label: 'Direction' });
  });
});
