import { diagnostic, type Diagnostic, type Document, type DocumentModel } from '@sgl/core';
import { BUILT_IN } from './themes/index.js';

/**
 * SGL5007 (F31; human decision 2026-09-27): the document's `@theme` names no
 * built-in theme. The caller still draws in the default theme, as before;
 * this only says so, at the `@theme` key. The name is the resolved one (a
 * `$variable` substituted); a non-string `@theme` is the resolver's `SGL2011`
 * and is not checked here. The last root `@theme` entry is the one in force,
 * so its key carries the warning. A name that is only an `Object` property
 * (`constructor`) is not a theme.
 *
 * Used by the app's pipeline and by `render-svg`'s pipeline harness, so the
 * two agree.
 */
export function unknownThemeDiagnostics(ast: Document, model: DocumentModel): readonly Diagnostic[] {
  const name = model.root.config['theme'];
  if (typeof name !== 'string' || Object.hasOwn(BUILT_IN, name)) return [];
  let span = ast.span;
  for (const e of ast.entries) if (e.kind === 'ConfigEntry' && e.key.length === 1 && e.key[0] === 'theme') span = e.keySpan;
  return [diagnostic('SGL5007', span, { name })];
}
