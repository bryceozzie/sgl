import type { Toasts as ToastStore } from '../state/toasts.js';

/** DD-08 §11's toasts — file and share outcomes only. A thin renderer of
 *  `state/toasts.ts`. */
export function Toasts({ toasts }: { readonly toasts: ToastStore }) {
  const items = toasts.items.value;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div class={`toast toast-${t.kind}`} key={t.id}>
          <span class="toast-message">{t.message}</span>
          <button type="button" class="toast-dismiss" aria-label="Dismiss" onClick={() => toasts.dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
