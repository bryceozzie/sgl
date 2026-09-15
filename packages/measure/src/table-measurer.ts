import { hashRuns } from './run-key.js';
import {
  MeasureMiss,
  type BoxConstraints,
  type Measurer,
  type MeasureTable,
  type StyledRun,
  type TextLayout,
} from './types.js';

/**
 * Wraps a `MeasureTable` (DD-05 §4). This is the measurer the layout worker sees.
 *
 * `layoutRuns` is a lookup, and a miss throws `MeasureMiss` — that is the design,
 * not a defect: the worker has no canvas, so a miss is genuinely unanswerable
 * synchronously and must become an RPC back to the host (DD-06 §3).
 *
 * The RPC itself is injected rather than built in, because the transport belongs to
 * DD-06 and this package may not know about it.
 */
export type MeasureRequest = (
  runs: readonly StyledRun[],
  box: BoxConstraints,
) => Promise<TextLayout>;

export class TableMeasurer implements Measurer {
  readonly #table: Record<string, TextLayout>;
  readonly #request: MeasureRequest | undefined;

  constructor(table: MeasureTable, request?: MeasureRequest) {
    this.#table = { ...table };
    this.#request = request;
  }

  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout {
    const key = hashRuns(runs, box);
    const hit = this.#table[key];
    if (hit === undefined) throw new MeasureMiss(key);
    return hit;
  }

  /** A miss goes to the host and the reply is inserted, so the next synchronous
   *  call for the same runs hits (DD-05 §4). */
  async layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout> {
    const key = hashRuns(runs, box);
    const hit = this.#table[key];
    if (hit !== undefined) return hit;
    if (this.#request === undefined) throw new MeasureMiss(key);

    const layout = await this.#request(runs, box);
    this.#table[key] = layout;
    return layout;
  }

  has(runs: readonly StyledRun[], box: BoxConstraints): boolean {
    return this.#table[hashRuns(runs, box)] !== undefined;
  }

  /** The table including anything an RPC filled in. Keys in sorted order, so the
   *  snapshot serialises identically to the one `premeasure` produced (DD-00 §3). */
  get table(): MeasureTable {
    const out: Record<string, TextLayout> = {};
    for (const key of Object.keys(this.#table).sort()) {
      const layout = this.#table[key];
      if (layout !== undefined) out[key] = layout;
    }
    return out;
  }
}
