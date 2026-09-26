import { parseInline } from '@sgl/core/inline';
import { layoutWrapped } from '@sgl/text/wrap';
import { registerRunFaces } from '../io/run-faces.js';
import type { RichText } from './types.js';

/**
 * The lazy `rich-text` chunk's entry (A18, DD-11 T53): the inline markdown parser
 * (`@sgl/core/inline`) and the word breaker (`@sgl/text/wrap`), loaded by the
 * pipeline the first time a document has markup in a label or a label to wrap,
 * and precached like every chunk.
 *
 * Loading it also registers A18's seven run faces (`io/run-faces.ts`): the
 * pipeline measures nothing of such a document until this chunk has loaded,
 * so `measurer.ready()` finds the faces declared and waits for exactly those
 * the document uses (DD-11 T28), and a document without markup never
 * declares or fetches them.
 */
registerRunFaces();

export const richText: RichText = { inline: parseInline, lineModel: layoutWrapped };
