import type { ThemeDoc } from '../types.js';
import { highContrast } from './high-contrast.js';
import { neutralDark } from './neutral-dark.js';
import { neutralLight } from './neutral-light.js';
import { print } from './print.js';

export { neutralLight, neutralDark, highContrast, print };

/** The built-in themes (DD-04 §7). The MVP's two neutral ones, and C5's
 *  `high-contrast` and `print`; all four share `neutral-light`'s metrics, so
 *  switching between any two is paint only. */
export const BUILT_IN: Readonly<Record<string, ThemeDoc>> = {
  [neutralLight.id]: neutralLight,
  [neutralDark.id]: neutralDark,
  [highContrast.id]: highContrast,
  [print.id]: print,
};

export const DEFAULT_THEME_ID = neutralLight.id;
