import { reportText } from '../state/pipeline-error.js';
import type { Pipeline } from '../state/pipeline.js';

export interface StatusChipProps {
  readonly pipeline: Pipeline;
  /** Fits the viewport now and tells the pipeline a fit happened
   *  (`pipeline.fitDone()`), clearing the offer. */
  readonly onFit: () => void;
}

/** DD-08 §11's status chip, plus §6's "Fit" offer and §13's crash message —
 *  all driven by the DOM-free `pipeline.chip` computed (`state/chip.ts`). */
export function StatusChip({ pipeline, onFit }: StatusChipProps) {
  const chip = pipeline.chip.value;
  if (chip.kind === 'idle' && !chip.offerFit) return null;

  function report(): void {
    const err = pipeline.pipelineError.peek();
    if (err === null) return;
    void navigator.clipboard?.writeText(reportText(err));
  }

  return (
    <div class={`chip chip-${chip.kind}`} role="status">
      {chip.message !== '' ? <span class="chip-message">{chip.message}</span> : null}
      {chip.kind === 'crashed' ? (
        <button type="button" class="chip-report" onClick={report}>
          Report
        </button>
      ) : null}
      {chip.offerFit ? (
        <button type="button" class="chip-fit" onClick={onFit}>
          Fit
        </button>
      ) : null}
    </div>
  );
}
