import type { EditorView } from '@codemirror/view';
import { dispatchTextChange } from '../editor/editor-actions.js';
import type { Pipeline } from '../state/pipeline.js';
import { engineOptionsFor, type EngineDescriptor } from '../state/pickers.js';
import { selectEngine } from '../state/picker-actions.js';

export interface EnginePickerProps {
  readonly pipeline: Pipeline;
  readonly view: EditorView | null;
  /** The engines actually registered in the worker (`apps/web/src/layout.worker.ts`
   *  is the one source of truth for that list — only `grid` until Stage K). */
  readonly registered: readonly EngineDescriptor[];
}

/** DD-08 §10: minimal engine picker — lists registered engines with a
 *  `determinism` badge. The per-engine options form is F11 (Stage K), not
 *  built here. */
export function EnginePicker({ pipeline, view, registered }: EnginePickerProps) {
  const effective = pipeline.effectiveEngineId.value;
  const options = engineOptionsFor(registered, effective);
  const overridden = pipeline.documentEngineId.value !== undefined;

  // DD-08 §10; the logic (signal writes, the root-config edit built from the
  // pipeline's own parsed AST) lives in `state/picker-actions.ts`, Node-tested.
  function select(id: string): void {
    const change = selectEngine(pipeline, id);
    if (view !== null) dispatchTextChange(view, change);
  }

  return (
    <label class="picker engine-picker" title={overridden ? `Set by the document's own @layout.engine` : undefined}>
      <span class="picker-label">Engine{overridden ? ' (set by document)' : ''}</span>
      <select value={effective} onChange={(e) => select((e.target as HTMLSelectElement).value)}>
        {options.map((o) => (
          <option value={o.id} key={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <span class="determinism-badge" data-determinism={options.find((o) => o.selected)?.determinism}>
        {options.find((o) => o.selected)?.determinism}
      </span>
    </label>
  );
}
