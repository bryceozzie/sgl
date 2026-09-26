import { closeBrackets, insertBracket } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { sgl } from '@sgl/core/editor';
import { describe, expect, it } from 'vitest';

/**
 * A18 (DD-01 §6, DD-11 T60): the SGL language data lists `"""` among its
 * `closeBrackets` tokens, so the third quote typed after `""` closes the
 * string. DOM-free: an `EditorState` with the app's language and
 * `closeBrackets()`, and `insertBracket`, the function the extension runs for
 * a typed character. `e2e/multiline.spec.ts` covers the same through real
 * key presses.
 */

/** Type `quote` at the end of `doc` (cursor there) and return the new text and cursor. */
function type(doc: string, quote: string): { text: string; cursor: number } {
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [sgl(), closeBrackets()] });
  const tr = insertBracket(state, quote);
  if (tr === null) return { text: doc, cursor: doc.length };
  return { text: tr.state.doc.toString(), cursor: tr.state.selection.main.head };
}

describe('closeBrackets and `"""`', () => {
  it('the third quote after `""` inserts the closing `"""`', () => {
    const doc = '@label: ""';
    expect(type(doc, '"')).toEqual({ text: '@label: """"""', cursor: doc.length + 1 });
  });

  it('a first quote still pairs as `""`', () => {
    expect(type('@label: ', '"')).toEqual({ text: '@label: ""', cursor: 9 });
  });
});
