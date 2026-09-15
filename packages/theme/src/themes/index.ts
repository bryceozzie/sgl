import type { ThemeDoc } from '../types.js';
import { neutralDark } from './neutral-dark.js';
import { neutralLight } from './neutral-light.js';

export { neutralLight, neutralDark };

/** The MVP ships two themes — enough to prove the system; more is content.
 *  ⟶ v1.0 (C5): `high-contrast`, `print`, both tokens-only. */
export const BUILT_IN: Readonly<Record<string, ThemeDoc>> = {
  [neutralLight.id]: neutralLight,
  [neutralDark.id]: neutralDark,
};

export const DEFAULT_THEME_ID = neutralLight.id;
