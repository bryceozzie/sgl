/**
 * @sgl/core/editor — the CodeMirror-facing half of the package: the Lezer
 * `LRLanguage`, highlight styles, folding and indentation.
 *
 * Split into its own entry point so the pipeline (Node, Worker, CLI) never pulls
 * CodeMirror into its bundle.
 *
 * Design: DD-01 §7, DD-08 §4.
 */

export {};
