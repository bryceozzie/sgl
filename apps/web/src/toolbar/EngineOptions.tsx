import { useRef } from 'preact/hooks';
import { engineForm, formValues, withOption, type OptionField, type OptionValue } from '../state/engine-options.js';
import type { Pipeline } from '../state/pipeline.js';
import { useDisclosure } from './disclosure.js';

export interface EngineOptionsProps {
  readonly pipeline: Pipeline;
}

/**
 * F11 (DD-08 §10): the per-engine options form, beside Engine ▾ (K9). A plain
 * disclosure, the pattern Stage J settled for Save ▾ (`disclosure.ts`): no
 * menu roles, Escape and an outside pointer-down close it, and every input
 * has a `<label>`. The form is the effective engine's own hand-built one
 * (`state/engine-options.ts`, Node-tested); every change writes the whole,
 * normalised bag through the pipeline's `engineOptions` signal, which the
 * document record persists (Stage J).
 */
export function EngineOptions({ pipeline }: EngineOptionsProps) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const disclosure = useDisclosure(ref);
  const engineId = pipeline.effectiveEngineId.value;
  const form = engineForm(engineId);
  if (form === null) return null;
  const values = formValues(engineId, pipeline.engineOptions.value);

  function change(key: string, raw: string): void {
    pipeline.engineOptions.value = withOption(engineId, pipeline.engineOptions.peek(), key, raw);
  }

  return (
    <details class="engine-options" ref={ref} onToggle={disclosure.onToggle}>
      <summary class="toolbar-button">
        Options <span aria-hidden="true">▾</span>
      </summary>
      <form class="options-form" aria-label={form.title} onSubmit={(e) => e.preventDefault()}>
        {form.fields.map((field) => (
          <Field key={`${engineId}:${field.key}`} engineId={engineId} field={field} value={values[field.key]} onChange={change} />
        ))}
      </form>
    </details>
  );
}

function Field({
  engineId,
  field,
  value,
  onChange,
}: {
  readonly engineId: string;
  readonly field: OptionField;
  readonly value: OptionValue | undefined;
  readonly onChange: (key: string, raw: string) => void;
}) {
  const id = `opt-${engineId.replace(/\W/g, '-')}-${field.key}`;
  const read = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).value;
  let control;
  switch (field.kind) {
    case 'select':
      control = (
        <select id={id} name={field.key} value={String(value)} onChange={(e) => onChange(field.key, read(e))}>
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
        <input id={id} name={field.key} type="number" min={field.min} step={field.step} value={String(value)} onChange={(e) => onChange(field.key, read(e))} />
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
          step={1}
          placeholder="auto"
          value={value === 'auto' ? '' : String(value)}
          onChange={(e) => onChange(field.key, read(e))}
        />
      );
      break;
  }
  return (
    <div class="options-field">
      <label for={id}>{field.label}</label>
      {control}
    </div>
  );
}
