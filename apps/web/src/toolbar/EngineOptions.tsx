import { useRef, useState } from 'preact/hooks';
import { engineOptionRules } from '../state/engine-options.js';
import type { Pipeline } from '../state/pipeline.js';
import { useDisclosure } from './disclosure.js';

export interface EngineOptionsProps {
  readonly pipeline: Pipeline;
}

type FormModule = typeof import('./engine-options-form.js');
let formModule: Promise<FormModule> | undefined;

/** The lazy `engine-options-form` chunk (the form, `state/engine-form.ts`),
 *  imported once, the first time Options ▾ is opened. Off the first paint;
 *  precached like every chunk, so it works offline (`e2e/offline.spec.ts`). */
function loadForm(): Promise<FormModule> {
  formModule ??= import('./engine-options-form.js');
  return formModule;
}

/**
 * F11 (DD-08 §10): Options ▾, beside Engine ▾ (K9). A plain disclosure, the
 * pattern Stage J settled for Save ▾ (`disclosure.ts`): no menu roles, Escape
 * and an outside pointer-down close it, and every input has a `<label>`.
 *
 * This is the part the first paint needs: the disclosure itself, shown only
 * for an engine with a hand-built form. The form inside is a lazy chunk
 * (`engine-options-form.tsx`), loaded when Options ▾ is first opened and kept
 * mounted from then on, as the form always was.
 */
export function EngineOptions({ pipeline }: EngineOptionsProps) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const [Form, setForm] = useState<FormModule['EngineOptionsForm'] | null>(null);
  const disclosure = useDisclosure(ref, () => {
    if (Form === null) void loadForm().then((m) => setForm(() => m.EngineOptionsForm));
  });
  if (engineOptionRules(pipeline.effectiveEngineId.value) === null) return null;

  return (
    <details class="engine-options" ref={ref} onToggle={disclosure.onToggle}>
      <summary class="toolbar-button">
        Options <span aria-hidden="true">▾</span>
      </summary>
      {Form !== null ? <Form pipeline={pipeline} /> : null}
    </details>
  );
}
