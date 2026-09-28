import type { ThemeDoc } from '../types.js';
import { highContrast } from './high-contrast.js';
import { neutralDark } from './neutral-dark.js';
import { neutralLight } from './neutral-light.js';
import { print } from './print.js';

export { neutralLight, neutralDark, highContrast, print };

/** The built-in themes (DD-04 §7). The MVP's two neutral ones, and C5's
 *  `high-contrast` and `print`; all four share `neutral-light`'s metrics, so
 *  switching between any two is paint only. No prototype (F31): an id is a
 *  built-in theme only if it is a key here, so `BUILT_IN['constructor']` is
 *  `undefined`, and a `@theme: "constructor"` draws in the default theme, as
 *  SGL5007 says, not an `Object` method resolved as a theme. */
export const BUILT_IN = {
  __proto__: null,
  [neutralLight.id]: neutralLight,
  [neutralDark.id]: neutralDark,
  [highContrast.id]: highContrast,
  [print.id]: print,
} as Readonly<Record<string, ThemeDoc>>;

export const DEFAULT_THEME_ID = neutralLight.id;
