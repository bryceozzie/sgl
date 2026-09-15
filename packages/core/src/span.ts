/** UTF-16 offsets into the source string (DD-00 §3).
 *  Line and column are derived on demand by the editor; they are never stored. */
export interface SourceSpan {
  readonly from: number;
  readonly to: number;
}

export const span = (from: number, to: number): SourceSpan => ({ from, to });

/** The span of a document with no meaningful position — used for synthesised nodes. */
export const NO_SPAN: SourceSpan = { from: 0, to: 0 };
