import { NotImplemented } from '@sgl/core';
import type { BoxConstraints, Measurer, StyledRun, TextLayout } from './types.js';

/**
 * The MVP `Measurer`. The one place below `apps/web` that touches a DOM API, kept
 * behind the `Measurer` interface so DD-00 §2 rule 4 still holds.
 *
 * Design: DD-05 §2.
 */
export class CanvasMeasurer implements Measurer {
  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout {
    void runs;
    void box;
    throw new NotImplemented('CanvasMeasurer.layoutRuns()', 'DD-05 §2');
  }

  layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout> {
    return Promise.resolve(this.layoutRuns(runs, box));
  }

  has(runs: readonly StyledRun[], box: BoxConstraints): boolean {
    void runs;
    void box;
    throw new NotImplemented('CanvasMeasurer.has()', 'DD-05 §2');
  }
}
