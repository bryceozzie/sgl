import { parseInline } from '@sgl/core/inline';
import { layoutWrapped } from '@sgl/text/wrap';
import type { RichText } from './types.js';

/**
 * The lazy `rich-text` chunk's entry (A18, DD-11 T53): the inline markdown parser
 * (`@sgl/core/inline`) and the word breaker (`@sgl/text/wrap`), loaded by the
 * pipeline the first time a document has markup in a label or a label to wrap,
 * and precached like every chunk.
 */
export const richText: RichText = { inline: parseInline, lineModel: layoutWrapped };
