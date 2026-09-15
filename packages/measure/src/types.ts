export interface TextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic';
  /** Multiplier. */
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

export interface StyledRun {
  readonly text: string;
  readonly style: TextStyle;
}

/** `undefined` = unconstrained, which is every MVP call (DD-05). */
export interface BoxConstraints {
  readonly maxWidth?: number;
}

export interface TextLayout {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly {
    /** Baseline offset from the top of the block. */
    readonly y: number;
    readonly width: number;
    readonly runs: readonly { readonly x: number; readonly text: string; readonly style: TextStyle }[];
  }[];
  /** Of the first line, for aligning the block. */
  readonly ascent: number;
}

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
