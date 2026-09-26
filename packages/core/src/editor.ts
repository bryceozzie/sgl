/**
 * @sgl/core/editor — the CodeMirror-facing half of the package: the Lezer
 * `LRLanguage`, highlight tags, folding and indentation.
 *
 * Split into its own entry point so the pipeline (Node, Worker, CLI) never pulls
 * CodeMirror into its bundle. `tsdown.config.ts` builds this as a second, separate
 * entry (`src/editor.ts` alongside `src/index.ts`), and `package.json`'s `exports`
 * map keeps `@sgl/core` and `@sgl/core/editor` as two subpaths — `index.ts` never
 * imports this file, and this file only ever imports the grammar output, never
 * `index.ts` — so a consumer of the plain `@sgl/core` entry point pulls in none of
 * this.
 *
 * Design: DD-01 §6, §7; DD-08 §4.
 */

import { delimitedIndent, foldInside, foldNodeProp, indentNodeProp, LanguageSupport, LRLanguage } from '@codemirror/language';
import { styleTags, tags as t } from '@lezer/highlight';
import { parser } from './grammar/sgl.parser.js';

/**
 * The grammar (`sgl.grammar`) carries `@detectDelim`, which bakes matching-bracket
 * metadata for `{ } [ ]` into the generated parser itself — CodeMirror's
 * `bracketMatching()` extension reads that directly, so there is nothing to add
 * here for it (DD-01 §6's "Bracket matching: from `@detectDelim`").
 *
 * The tag mapping below is DD-01 §6's table verbatim for the six named
 * productions, filled out for four more the table did not name but the grammar
 * implies: `ConfigString` (`"@style.stroke"`, the quoted spelling of a
 * `ConfigKey`/`String`, tagged the same as whichever the surrounding table names
 * — `buildAst` already treats the two identically as values, and highlighting
 * ConfigString differently everywhere it is used as a value would be visibly
 * wrong), `Bool`/`Null` (literal tags CodeMirror already has themes for), and
 * `Variable` (the `$name` token — DD-01 §6 groups `NodeKey`/`PathSegment` as
 * `variableName` for the same reason: it names something rather than being a
 * literal). `MultilineString` (`"""`, A18, DD-11 T19) is a string like `String`.
 */
const sglTags = styleTags({
  ConfigKey: t.propertyName,
  ConfigString: t.propertyName,
  'NodeKey PathSegment': t.variableName,
  Variable: t.variableName,
  EdgeOp: t.operator,
  'String MultilineString': t.string,
  Number: t.number,
  Bool: t.bool,
  Null: t.null,
  Word: t.atom,
  'LineComment BlockComment': t.comment,
  Port: t.attributeName,
});

const sglParser = parser.configure({
  props: [
    sglTags,
    // DD-01 §6: "one level inside Block/Object/Array." `delimitedIndent` adds one
    // indent unit inside the node and aligns the closing delimiter with the line
    // the node opened on.
    indentNodeProp.add({
      Block: delimitedIndent({ closing: '}' }),
      Object: delimitedIndent({ closing: '}' }),
      Array: delimitedIndent({ closing: ']' }),
    }),
    // DD-01 §6: "foldNodeProp on Block, Object, Array."
    foldNodeProp.add({
      Block: foldInside,
      Object: foldInside,
      Array: foldInside,
      // A18, DD-11 T19: between the delimiters; an unterminated one to the end.
      // Closed means an unescaped `"""` ends the token, found as the token
      // finds it: `"""a\"""` at the end of the input ends in `"""` but is not
      // closed (A18 fix round 1).
      MultilineString: (node, state) => {
        const text = state.doc.sliceString(node.from, node.to);
        let i = 3;
        while (i < text.length && !text.startsWith('"""', i)) i += text[i] === '\\' ? 2 : 1;
        return { from: node.from + 3, to: node.from + Math.min(i, text.length) };
      },
    }),
  ],
});

/** The `LRLanguage` DD-08 §4's `EditorState` is built from. */
export const sglLanguage: LRLanguage = LRLanguage.define({
  parser: sglParser,
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    // `"""` lets closeBrackets finish a triple quote: the third `"` typed after
    // `""` inserts the closing `"""` too (A18, DD-11 T60), so a `"""` being
    // typed does not turn the rest of the document into one string.
    closeBrackets: { brackets: ['{', '[', '"', '"""'] },
  },
});

/** `LanguageSupport` wrapper, the unit `EditorState.create({ extensions })` takes. */
export function sgl(): LanguageSupport {
  return new LanguageSupport(sglLanguage);
}
