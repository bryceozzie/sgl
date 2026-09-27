import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { Cancel, Schedule } from './types.js';

/** DD-08 §11: "Toasts for file and share outcomes only; never for
 *  diagnostics." DOM-free; `panels/Toasts.tsx` renders `items`. */

export type ToastKind = 'info' | 'error';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

/** How long an `info` toast stays. An `error` toast has no time to live: it
 *  stays until its × is clicked (fix round 1, item 10) — a failure the reader
 *  was not looking at when it appeared must still be there to read. */
export const TOAST_TTL_MS = 8000;

/** At most this many toasts are on screen at once (F13). Errors come first
 *  (round 1, item 5: a stream of info toasts never pushes an error out of
 *  view), then the newest info toasts. The rest are held back, not dropped
 *  — an error toast still stays until it is closed — and come forward as
 *  shown ones close. The panel says how many are held, and how many of
 *  those are errors, and offers to close them all. */
export const VISIBLE_TOASTS = 3;

export interface Toasts {
  /** Every open toast, oldest first. */
  readonly items: ReadonlySignal<readonly Toast[]>;
  /** What shows: the newest errors, then the newest info toasts, at most
   *  `VISIBLE_TOASTS`, in `items` order. */
  readonly visible: ReadonlySignal<readonly Toast[]>;
  /** How many open toasts `visible` leaves out. */
  readonly hidden: ReadonlySignal<number>;
  /** How many of the held ones are errors. */
  readonly heldErrors: ReadonlySignal<number>;
  push(message: string, kind?: ToastKind): number;
  dismiss(id: number): void;
  /** Closes every toast, shown or held. */
  dismissAll(): void;
}

export function createToasts(schedule: Schedule, ttlMs: number = TOAST_TTL_MS): Toasts {
  const items = signal<readonly Toast[]>([]);
  const timers = new Map<number, Cancel>();
  let nextId = 1;

  function dismiss(id: number): void {
    timers.get(id)?.();
    timers.delete(id);
    items.value = items.value.filter((t) => t.id !== id);
  }

  const visible = computed(() => {
    const all = items.value;
    const errors = all.filter((t) => t.kind === 'error').slice(-VISIBLE_TOASTS);
    const infos = all.filter((t) => t.kind === 'info');
    const shown = new Set([...errors, ...infos.slice(Math.max(0, infos.length - (VISIBLE_TOASTS - errors.length)))]);
    return all.filter((t) => shown.has(t));
  });
  return {
    items,
    visible,
    hidden: computed(() => items.value.length - visible.value.length),
    heldErrors: computed(() => items.value.filter((t) => t.kind === 'error' && !visible.value.includes(t)).length),
    push(message, kind = 'info') {
      const id = nextId;
      nextId += 1;
      items.value = [...items.value, { id, kind, message }];
      if (kind === 'info') timers.set(id, schedule(() => dismiss(id), ttlMs));
      return id;
    },
    dismiss,
    dismissAll() {
      for (const cancel of timers.values()) cancel();
      timers.clear();
      items.value = [];
    },
  };
}
