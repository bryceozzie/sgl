/**
 * DD-08 §7's Open, when it arrives before the editor exists (fix round 1,
 * item 13). The launch queue (§12) can deliver a file during the first
 * render, before CodeMirror's view is up; dropping it would lose the very
 * file the app was launched to open. So an Open with no editor to apply to is
 * held — the latest one, since each replaces the whole document — and applied
 * as soon as the editor arrives. DOM-free.
 */
export interface OpenQueue<T> {
  /** An Open has been read: apply it now, or hold it until there is a target. */
  deliver(item: T): void;
  /** The editor arrived (`apply`) or went away (`null`). A held Open is
   *  applied at once, and only once. */
  setTarget(apply: ((item: T) => void) | null): void;
}

export function createOpenQueue<T>(): OpenQueue<T> {
  let target: ((item: T) => void) | null = null;
  let held: { readonly item: T } | null = null;
  return {
    deliver(item) {
      if (target !== null) target(item);
      else held = { item };
    },
    setTarget(apply) {
      target = apply;
      if (apply === null || held === null) return;
      const { item } = held;
      held = null;
      apply(item);
    },
  };
}
