import type { EditorView } from '@codemirror/view';
import { dispatchTextChange } from '../editor/editor-actions.js';
import type { Pipeline } from '../state/pipeline.js';
import { themeOptions } from '../state/pickers.js';
import { selectTheme } from '../state/picker-actions.js';

export interface ThemePickerProps {
  readonly pipeline: Pipeline;
  readonly view: EditorView | null;
}

/** DD-08 §10: theme picker with a 24 px `bg/surface/ink/accent` swatch. */
export function ThemePicker({ pipeline, view }: ThemePickerProps) {
  const effective = pipeline.effectiveThemeId.value;
  const options = themeOptions(effective);
  const overridden = pipeline.documentThemeId.value !== undefined;
  const selected = options.find((o) => o.selected);

  // DD-08 §10; the logic (a view preference unless the document sets its own
  // `@theme`, P1) lives in `state/picker-actions.ts`, Node-tested.
  function select(id: string): void {
    selectTheme(pipeline, id, view === null ? null : (change) => dispatchTextChange(view, change));
  }

  return (
    <label class="picker theme-picker" title={overridden ? `Set by the document's own @theme` : undefined}>
      <span class="picker-label">Theme{overridden ? ' (set by document)' : ''}</span>
      <select value={effective} onChange={(e) => select((e.target as HTMLSelectElement).value)}>
        {options.map((o) => (
          <option value={o.id} key={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {selected !== undefined ? (
        <span class="swatch" aria-hidden="true">
          <i style={{ background: selected.swatch.bg }} />
          <i style={{ background: selected.swatch.surface }} />
          <i style={{ background: selected.swatch.ink }} />
          <i style={{ background: selected.swatch.accent }} />
        </span>
      ) : null}
    </label>
  );
}
