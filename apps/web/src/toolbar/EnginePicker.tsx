import type { EditorView } from '@codemirror/view';
import { dispatchTextChange } from '../editor/editor-actions.js';
import type { Pipeline } from '../state/pipeline.js';
import { engineOptionsFor, type EngineDescriptor } from '../state/pickers.js';
import { setRootConfigString } from '../state/root-config-edit.js';

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

  function select(id: string): void {
    pipeline.engineId.value = id;
    // DD-08 §10: "selecting an engine resets `engineOptions` to that engine's
    // defaults." No engine has a real options schema wired up yet (F11,
    // Stage K), so the only defaults available today are the empty bag —
    // still a real reset, not a no-op: it clears whatever the *previous*
    // engine's options happened to be, rather than leaking them across a
    // switch.
    pipeline.engineOptions.value = {};
    if (view === null) return;
    // DD-08 §4: "the app never calls `parse` on its own" — reuse the
    // pipeline's own already-parsed AST rather than re-parsing `source` here.
    dispatchTextChange(view, setRootConfigString(pipeline.parsed.value.value, ['layout', 'engine'], id));
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
