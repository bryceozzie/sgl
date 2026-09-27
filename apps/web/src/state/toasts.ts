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

/** At most this many toasts are on screen at once (F13). The newest show;
 *  older ones are held back, not dropped — an error toast still stays until
 *  it is closed — and come back as the shown ones close. The panel says how
 *  many are held and offers to close them all. */
export const VISIBLE_TOASTS = 3;

export interface Toasts {
  /** Every open toast, oldest first. */
  readonly items: ReadonlySignal<readonly Toast[]>;
  /** The newest `VISIBLE_TOASTS` of `items`, oldest first. */
  readonly visible: ReadonlySignal<readonly Toast[]>;
  /** How many open toasts `visible` leaves out. */
  readonly hidden: ReadonlySignal<number>;
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

  const visible = computed(() => items.value.slice(-VISIBLE_TOASTS));
  return {
    items,
    visible,
    hidden: computed(() => items.value.length - visible.value.length),
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
