import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { buildAst, parse } from '@sgl/core';
import { sgl } from '@sgl/core/editor';
import { describe, expect, it } from 'vitest';
import { scaleDocument } from '../../../bench/scale-document.js';
import { completeSyntaxTree } from '../src/editor/complete-tree.js';

/**
 * F19: the tree the editor hands the pipeline spans the whole document, even
 * where CodeMirror's own incremental parse has stopped short. DOM-free — an
 * `EditorState` with the app's language, no view — so it runs under Node.
 */

const N2000 = scaleDocument(2000);
const N3000 = scaleDocument(3000);

const stateOf = (doc: string): EditorState => EditorState.create({ doc, extensions: [sgl()] });

/** `buildAst` over `tree` gives exactly what a fresh parse of `text` does. */
function expectSameDocument(tree: ReturnType<typeof completeSyntaxTree>, text: string): void {
  const fromTree = buildAst(tree, text);
  const fresh = parse(text);
  expect(fromTree.diagnostics).toEqual(fresh.diagnostics);
  expect(JSON.stringify(fromTree.value)).toBe(JSON.stringify(fresh.ast));
}

describe('completeSyntaxTree (F19)', () => {
  it("covers the whole of a large document the editor's own parse has not reached", () => {
    const state = stateOf(N2000);
    // A new state parses only its first screen (CodeMirror's 3 000 characters).
    expect(syntaxTree(state).length).toBeLessThan(N2000.length);
    const tree = completeSyntaxTree(state);
    expect(tree.length).toBe(N2000.length);
    expectSameDocument(tree, N2000);
  });

  it('covers the whole of a document replaced wholesale, as `loadDocument` does', () => {
    const before = stateOf('a: "A"\n');
    completeSyntaxTree(before);
    const after = before.update({ changes: { from: 0, to: before.doc.length, insert: N3000 } }).state;
    expect(syntaxTree(after).length).toBeLessThan(N3000.length);
    const tree = completeSyntaxTree(after);
    expect(tree.length).toBe(N3000.length);
    expectSameDocument(tree, N3000);
  });

  it('covers the whole of a large document after an edit near its start', () => {
    const state = stateOf(N3000);
    const edit = state.update({ changes: { from: N3000.indexOf('"Scale 3000"') + 11, insert: '!' } }).state;
    const text = edit.doc.toString();
    const tree = completeSyntaxTree(edit);
    expect(tree.length).toBe(text.length);
    expectSameDocument(tree, text);
  });

  it('returns the tree the editor already has when it is whole, without parsing again', () => {
    const state = stateOf('a: "A"\nb: "B"\na -> b\n');
    expect(syntaxTree(state).length).toBe(state.doc.length);
    expect(completeSyntaxTree(state)).toBe(syntaxTree(state));
    expect(completeSyntaxTree(state)).toBe(completeSyntaxTree(state));
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '  \n\n\t\n'],
    ['trailing blank lines', 'a: "A"\n\n\n'],
    ['a comment last', 'a: "A"\n// the end'],
    ['unterminated', 'a: {\n  b: "B'],
  ])('spans the text exactly, %s', (_name, text) => {
    const tree = completeSyntaxTree(stateOf(text));
    expect(tree.length).toBe(text.length);
    expect(parse(text).tree.length).toBe(text.length);
    expectSameDocument(tree, text);
  });
});
