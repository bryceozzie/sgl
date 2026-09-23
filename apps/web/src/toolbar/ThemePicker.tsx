import type { EditorView } from '@codemirror/view';
import { parse } from '@sgl/core';
import { dispatchTextChange } from '../editor/editor-actions.js';
import type { Pipeline } from '../state/pipeline.js';
import { themeOptions } from '../state/pickers.js';
import { setRootConfigString } from '../state/root-config-edit.js';

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

  function select(id: string): void {
    pipeline.themeId.value = id;
    if (view === null) return;
    const { ast } = parse(pipeline.source.value);
    dispatchTextChange(view, setRootConfigString(ast, ['theme'], id));
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
