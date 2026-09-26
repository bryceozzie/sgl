/**
 * The table key, `hashRuns`, moved to `@sgl/text` (DD-11 T2, T29) so every consumer
 * of the table (`premeasure`, the app's label-size join, and from the render branch
 * on `render()`) computes it with one function. Re-exported here unchanged.
 */
export { canonicalRunKey, hashRuns, UNCONSTRAINED } from '@sgl/text';
