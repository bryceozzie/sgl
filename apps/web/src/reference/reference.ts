/**
 * The lazy `reference` chunk (DD-13 P4, P46): the reference builder, a chunk
 * of its own so that E6 (autocomplete) can load it later without the help
 * UI or its prose (P47). The `help` chunk imports it dynamically.
 */
export { buildReference } from './build.js';
