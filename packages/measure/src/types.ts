import type { BoxConstraints, StyledRun, TextLayout } from '@sgl/text';

/**
 * The run and layout types moved to `@sgl/text` (DD-11 T2, T23), so that the table
 * key and the renderer can share them; they are re-exported here unchanged, and
 * `Measurer`, `MeasureMiss` and `MeasureTable` stay.
 */
export type { BoxConstraints, LaidRun, LineModel, MeasureRun, RunMarks, RunMetrics, StyledRun, TextLayout, TextLine, TextStyle } from '@sgl/text';

/**
 * The measurement boundary. Run-based from day one, so A18 (markdown labels) is an
 * addition rather than a rewrite (06 §3).
 *
 * MVP implementation is `CanvasMeasurer`; `FontMetricsMeasurer` becomes the default
 * when the Worker render API ships and cross-environment parity can be exercised
 * (ADR-0003 amendment, 06 §4 pitfall 2).
 */
export interface Measurer {
  /** Synchronous; throws `MeasureMiss` if the run is not in the table. */
  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout;
  layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout>;
  has(runs: readonly StyledRun[], box: BoxConstraints): boolean;
}

/** Thrown by `Measurer.layoutRuns` on a table miss. In the layout worker this
 *  becomes a `measure` RPC back to the host (DD-06 §3). */
export class MeasureMiss extends Error {
  constructor(readonly runKey: string) {
    super(`No measurement for run key ${runKey}.`);
    this.name = 'MeasureMiss';
  }
}

/** runKey → layout. Built on the main thread and shipped into the worker whole,
 *  so the common path has zero RPCs (DD-05 §4). */
export type MeasureTable = Readonly<Record<string, TextLayout>>;
