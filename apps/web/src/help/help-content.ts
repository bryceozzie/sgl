/**
 * The lazy `help-content` chunk (DD-13 P13, P46): the compiled help content,
 * `virtual:sgl-help-content`, and nothing else. Only the `help` chunk imports
 * it, dynamically (`help.tsx`).
 */
export { default } from 'virtual:sgl-help-content';
