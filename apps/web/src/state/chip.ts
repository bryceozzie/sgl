import type { Diagnostic } from '@sgl/core';

/** DD-08 §11's status chip states, plus §13's crash state and §6's "Fit" offer
 *  as an independent overlay (a document can be showing last-good-with-errors
 *  *and* have just grown past the 40% bounds threshold at once). */
export type ChipKind = 'idle' | 'laying-out' | 'last-good' | 'timeout' | 'crashed';

export interface ChipState {
  readonly kind: ChipKind;
  readonly message: string;
  readonly errorCount: number;
  /** DD-08 §6: bounds changed by more than 40% since the last fit. */
  readonly offerFit: boolean;
}

export interface ChipInputs {
  /** §13: a thrown error was caught at the effect boundary. */
  readonly crashed: boolean;
  /** Has been in flight for at least 300 ms (DD-08 §11). */
  readonly layingOutVisible: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly offerFit: boolean;
}

/** Priority order, highest first: a crash always wins (nothing else is safe to
 *  claim once the pipeline itself has thrown); a hard layout timeout is more
 *  specific than the generic error count; the generic error count beats
 *  "laying out…", since an in-flight *retry* after an error is still showing
 *  last-good-with-errors until it resolves; idle is the fallback DD-08 §11
 *  calls "hidden." */
export function deriveChipState(inputs: ChipInputs): ChipState {
  const { crashed, layingOutVisible, diagnostics, offerFit } = inputs;
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const hasTimeout = diagnostics.some((d) => d.code === 'SGL4001');

  if (crashed) {
    return { kind: 'crashed', message: 'Something went wrong rendering — your text is safe', errorCount, offerFit };
  }
  if (hasTimeout) {
    return { kind: 'timeout', message: 'Layout timed out — showing previous', errorCount, offerFit };
  }
  if (errorCount > 0) {
    const noun = errorCount === 1 ? 'error' : 'errors';
    return { kind: 'last-good', message: `Showing last good render · ${errorCount} ${noun}`, errorCount, offerFit };
  }
  if (layingOutVisible) {
    return { kind: 'laying-out', message: 'laying out…', errorCount, offerFit };
  }
  return { kind: 'idle', message: '', errorCount, offerFit };
}
