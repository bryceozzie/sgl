import { useState } from 'preact/hooks';
import { editOption, engineForm, formValues, type OptionField } from '../state/engine-form.js';
import type { OptionValue } from '../state/engine-options.js';
import type { Pipeline } from '../state/pipeline.js';

export interface EngineOptionsFormProps {
  readonly pipeline: Pipeline;
}

/**
 * F11 (DD-08 §10): the options form inside Options ▾ — the effective engine's
 * own hand-built one (`state/engine-form.ts`, Node-tested); every change
 * writes the whole, normalised bag through the pipeline's `engineOptions`
 * signal, which the document record persists (Stage J). A lazy chunk
 * (`engine-options-form-*.js`, with `state/engine-form.ts`): `EngineOptions.tsx`
 * imports it the first time Options ▾ is opened.
 *
 * A refused value (fix round 1, item 22) — out of range, not a number — is
 * not written: the field is marked `aria-invalid`, a message beside it says
 * why and which value is in use, and the box goes back to showing that value,
 * so it never shows one the engine is not using.
 *
 * A field the document's root `@layout` sets (DD-12 H6) shows the document's
 * value, is disabled, and says "(set by document)" in its label, as Engine ▾
 * does: the document is the source of truth, so it is edited there.
 */
export function EngineOptionsForm({ pipeline }: EngineOptionsFormProps) {
  const [rejected, setRejected] = useState<Readonly<Record<string, string>>>({});
  const engineId = pipeline.effectiveEngineId.value;
  const form = engineForm(engineId);
  if (form === null) return null;
  const fromDocument = pipeline.documentOptions.value;
  const values = formValues(engineId, pipeline.engineOptions.value, fromDocument);

  function change(key: string, raw: string, control: HTMLInputElement | HTMLSelectElement): void {
    const edit = editOption(engineId, pipeline.engineOptions.peek(), key, raw);
    pipeline.engineOptions.value = edit.bag;
    const { [key]: _previous, ...others } = rejected;
    void _previous;
    setRejected(edit.rejected === null ? others : { ...others, [key]: edit.rejected });
    // The box shows what is in use, even when that did not change (a refused
    // value leaves the signal as it was, so nothing else would re-render it).
    const shown = edit.bag[key];
    control.value = shown === 'auto' ? '' : String(shown);
  }

  return (
    <form class="options-form" aria-label={form.title} onSubmit={(e) => e.preventDefault()}>
      {form.fields.map((field) => (
        <Field
          key={`${engineId}:${field.key}`}
          engineId={engineId}
          field={field}
          value={values[field.key]}
          setByDocument={field.key in fromDocument}
          error={rejected[field.key] ?? null}
          onChange={change}
        />
      ))}
    </form>
  );
}

function Field({
  engineId,
  field,
  value,
  error,
  setByDocument,
  onChange,
}: {
  readonly engineId: string;
  readonly field: OptionField;
  readonly value: OptionValue | undefined;
  readonly error: string | null;
  readonly setByDocument: boolean;
  readonly onChange: (key: string, raw: string, control: HTMLInputElement | HTMLSelectElement) => void;
}) {
  const id = `opt-${engineId.replace(/\W/g, '-')}-${field.key}`;
  const errorId = `${id}-error`;
  const invalid = { disabled: setByDocument, ...(error !== null && { 'aria-invalid': 'true' as const, 'aria-describedby': errorId }) };
  const handle = (e: Event) => {
    const control = e.currentTarget as HTMLInputElement | HTMLSelectElement;
    onChange(field.key, control.value, control);
  };
  let control;
  switch (field.kind) {
    case 'select':
      control = (
        <select id={id} name={field.key} value={String(value)} onChange={handle} {...invalid}>
          {field.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'number':
      control = (
        <input id={id} name={field.key} type="number" min={field.min} max={field.max} step={field.step} value={String(value)} onChange={handle} {...invalid} />
      );
      break;
    case 'columns':
      // `auto`, or a whole number of columns: an empty box means automatic.
      control = (
        <input
          id={id}
          name={field.key}
          type="number"
          min={1}
          max={field.max}
          step={1}
          placeholder="auto"
          value={value === 'auto' ? '' : String(value)}
          onChange={handle}
          {...invalid}
        />
      );
      break;
  }
  return (
    <div class="options-field">
      <label for={id}>
        {field.label}
        {setByDocument ? ' (set by document)' : ''}
      </label>
      {control}
      {error !== null ? (
        <p class="options-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
