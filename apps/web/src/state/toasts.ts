import { signal, type ReadonlySignal } from '@preact/signals';
import type { Cancel, Schedule } from './types.js';

/** DD-08 §11: "Toasts for file and share outcomes only; never for
 *  diagnostics." DOM-free; `panels/Toasts.tsx` renders `items`. */

export type ToastKind = 'info' | 'error';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

export const TOAST_TTL_MS = 8000;

export interface Toasts {
  readonly items: ReadonlySignal<readonly Toast[]>;
  push(message: string, kind?: ToastKind): number;
  dismiss(id: number): void;
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

  return {
    items,
    push(message, kind = 'info') {
      const id = nextId;
      nextId += 1;
      items.value = [...items.value, { id, kind, message }];
      timers.set(
        id,
        schedule(() => dismiss(id), ttlMs),
      );
      return id;
    },
    dismiss,
  };
}
