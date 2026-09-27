import type { Toast, Toasts as ToastStore } from '../state/toasts.js';

/** DD-08 §11's toasts — file and share outcomes only. A thin renderer of
 *  `state/toasts.ts`. Two live regions, both always in the DOM so a screen
 *  reader is already watching them when a toast arrives: `info` toasts in a
 *  polite `status` region (they time out), `error` toasts in an `alert`
 *  region (announced at once, and they stay until their × is clicked).
 *
 *  At most `VISIBLE_TOASTS` show (F13): errors first, then the newest info
 *  toasts. The rest are held, not dropped, behind a "N more" line in the
 *  polite region — announced once, without re-announcing the errors — that
 *  says how many held ones are errors (round 1, item 5). Its button closes
 *  them all, and its label says so when that includes unread errors. */
export function Toasts({ toasts }: { readonly toasts: ToastStore }) {
  const items = toasts.visible.value;
  const hidden = toasts.hidden.value;
  const errors = toasts.heldErrors.value;
  const render = (t: Toast) => (
    <div class={`toast toast-${t.kind}`} key={t.id}>
      <span class="toast-message">{t.message}</span>
      <button type="button" class="toast-dismiss" aria-label="Dismiss" onClick={() => toasts.dismiss(t.id)}>
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
  return (
    <div class="toasts">
      <div class="toast-region toast-region-error" role="alert">
        {items.filter((t) => t.kind === 'error').map(render)}
      </div>
      <div class="toast-region toast-region-info" role="status" aria-live="polite">
        {items.filter((t) => t.kind === 'info').map(render)}
        {hidden > 0 ? (
          <div class="toast toast-more">
            <span class="toast-message">
              {hidden} more{errors > 0 ? `, ${errors} of them ${errors === 1 ? 'an error' : 'errors'}` : ''}
            </span>
            <button type="button" class="toast-dismiss-all" onClick={toasts.dismissAll}>
              {errors > 0 ? `Dismiss all, including ${errors} unread ${errors === 1 ? 'error' : 'errors'}` : 'Dismiss all'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
