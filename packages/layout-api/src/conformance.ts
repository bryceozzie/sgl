/**
 * `@sgl/layout-api/conformance` — the golden-file harness every engine is held to.
 *
 * An engine passes if it returns geometry that is schema-valid, non-overlapping
 * where it claims to be, deterministic across two runs, and finishes inside budget.
 * Determinism is checked by running twice and diffing.
 *
 * Design: Architecture §4.6, DD-06 §8. Grows to ~40 graphs (empty, single node,
 * deep nesting, self-loops, multi-edges, disconnected components, 1 000 nodes,
 * pathological aspect ratios); the MVP set is the `corpus/` documents.
 */

export {};
