import type { PaintPlan } from '@sgl/render-svg';
import type { LastGood } from '../state/types.js';

/**
 * Puts `lastGood` on screen in the canvas's wrapper `<g>` (DD-08 §6), and
 * says how: `true` for a swap, `false` for a replacement.
 *
 * - `swap` — the paint-only path (F9 P3): the wrapper already shows the
 *   element tree `lastGood` is drawn as (`onScreen`, the plan of what was last
 *   put there, is `lastGood.paintPlan`), and two renders with one plan differ
 *   only in their `<style>` text (DD-07 §6, §11). So that text alone is
 *   replaced in place: no parse, no new elements, and `lastGood.svg` is never
 *   read (it may not even exist yet, P4). Setting a text node to the
 *   unescaped text gives the very DOM the parser builds from `render()`'s
 *   escaped text (`test/paint-swap.browser.test.ts` checks the serialisation
 *   against a full render's, for the whole corpus).
 * - `replace` — anything else: the wrapper's `innerHTML` is replaced whole
 *   (the full path; also what shows a render whose tree is not on screen).
 *
 * Plain DOM, no Preact, so it runs as is in the browser test project.
 */
export function showLastGood(wrapper: Element, lastGood: LastGood, onScreen: PaintPlan | null): boolean {
  if (onScreen !== null && onScreen === lastGood.paintPlan) {
    // The render's one `<style>`: nothing before it can hold an element.
    const style = wrapper.querySelector('style');
    if (style !== null) {
      style.textContent = lastGood.styleBlock;
      return true;
    }
  }
  wrapper.innerHTML = lastGood.svg;
  return false;
}
