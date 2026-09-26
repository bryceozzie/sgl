import { layoutWrapped } from '@sgl/text/wrap';
import type { RichText } from './types.js';

/**
 * The lazy `rich-text` chunk's entry (A18, DD-11 T53): the word breaker
 * (`@sgl/text/wrap`), loaded by the pipeline the first time a document has a
 * label to wrap, and precached like every chunk.
 */
export const richText: RichText = { lineModel: layoutWrapped };
