import { BUILT_IN, resolveTheme, type ThemeDoc } from '@sgl/theme';

/** DOM-free option lists for the theme and engine pickers (DD-08 §10). The
 *  "(set by document)" badge is a property of the *picker*, not of any one
 *  option — driven directly off `Pipeline.documentThemeId`/`documentEngineId`
 *  by the component — so it is not modelled here. */

export interface ThemeSwatch {
  readonly bg: string;
  readonly surface: string;
  readonly ink: string;
  readonly accent: string;
}

export interface ThemeOption {
  readonly id: string;
  readonly name: string;
  readonly swatch: ThemeSwatch;
  readonly selected: boolean;
}

const FALLBACK_SWATCH_COLOR = '#000000';

function swatchOf(doc: ThemeDoc): ThemeSwatch {
  const { value: resolved } = resolveTheme(doc, (id) => BUILT_IN[id]);
  const token = (name: string): string => {
    const v = resolved.tokens[name];
    return typeof v === 'string' ? v : FALLBACK_SWATCH_COLOR;
  };
  return { bg: token('bg'), surface: token('surface'), ink: token('ink'), accent: token('accent') };
}

/** Every built-in theme (DD-08 §10: "24 px swatch of bg/surface/ink/accent"),
 *  sorted by id for a deterministic picker order (DD-00 §3's spirit). */
export function themeOptions(effectiveThemeId: string): readonly ThemeOption[] {
  return Object.values(BUILT_IN)
    .map((doc) => ({ id: doc.id, name: doc.name, swatch: swatchOf(doc), selected: doc.id === effectiveThemeId }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface EngineDescriptor {
  readonly id: string;
  readonly name: string;
  readonly determinism: 'bitwise' | 'quantized' | 'best-effort';
}

export interface EngineOption extends EngineDescriptor {
  readonly selected: boolean;
}

/** DD-08 §10: "lists *registered* engines with name and `determinism` badge."
 *  `registered` is supplied by the caller (only `gridEngine` today,
 *  `apps/web/src/layout.worker.ts`'s own registration list) rather than read
 *  from a shared registry object, since the worker's `EngineRegistry` lives
 *  inside the worker and the main thread has no synchronous view into it. */
export function engineOptionsFor(registered: readonly EngineDescriptor[], effectiveEngineId: string): readonly EngineOption[] {
  return [...registered]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({ ...e, selected: e.id === effectiveEngineId }));
}
