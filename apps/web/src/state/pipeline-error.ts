import { fnv1a64 } from '@sgl/core';

/** DD-08 §13: a thrown error anywhere in the pipeline, caught at the effect
 *  boundary. `sourceHash` is the *hash* of the current source, never the
 *  source itself — the "Report" link copies `message` and `sourceHash` to the
 *  clipboard, so a report can be correlated with a document without ever
 *  transmitting its (possibly sensitive) text. */
export interface PipelineError {
  readonly message: string;
  readonly sourceHash: string;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function makePipelineError(err: unknown, source: string): PipelineError {
  return { message: describeError(err), sourceHash: fnv1a64(source) };
}

/** What the "Report" link copies to the clipboard (DD-08 §13). */
export function reportText(error: PipelineError): string {
  return `SGL rendering error\nmessage: ${error.message}\nsourceHash: ${error.sourceHash}`;
}
