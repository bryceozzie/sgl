import { foldNodeProp, indentNodeProp } from '@codemirror/language';
import { getStyleTags, tags as t } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { sgl, sglLanguage } from '../src/editor.js';

/** Walks the tree and returns the first node of `typeName`, or `undefined`. */
function findNode(source: string, typeName: string) {
  const tree = sglLanguage.parser.parse(source);
  const cursor = tree.cursor();
  do {
    if (cursor.type.name === typeName) return cursor.node;
  } while (cursor.next());
  return undefined;
}

describe('@sgl/core/editor', () => {
  it('exposes an LRLanguage built on the shared grammar', () => {
    const tree = sglLanguage.parser.parse('a -> b');
    expect(tree.topNode.name).toBe('Document');
  });

  it('sgl() returns a LanguageSupport wrapping sglLanguage', () => {
    const support = sgl();
    expect(support.language).toBe(sglLanguage);
  });

  it('tags DD-01 §6\'s six named productions as specified', () => {
    const cases: [string, string, unknown][] = [
      ['@title: "x"', 'ConfigKey', t.propertyName],
      ['a -> b', 'EdgeOp', t.operator],
      ['a: "hi"', 'String', t.string],
      ['@size: 3', 'Number', t.number],
      ['@shape: hexagon', 'Word', t.atom],
      ['// hi\na', 'LineComment', t.comment],
    ];
    for (const [source, typeName, tag] of cases) {
      const node = findNode(source, typeName);
      expect(node, `expected a ${typeName} node in ${JSON.stringify(source)}`).toBeTruthy();
      const styleTags = getStyleTags(node!);
      expect(styleTags?.tags, `tags for ${typeName}`).toContain(tag);
    }
  });

  it('tags NodeKey and PathSegment as variableName', () => {
    const nodeKey = findNode('web: "Web"', 'NodeKey');
    expect(getStyleTags(nodeKey!)?.tags).toContain(t.variableName);
    const pathSegment = findNode('a.b -> c', 'PathSegment');
    expect(getStyleTags(pathSegment!)?.tags).toContain(t.variableName);
  });

  it('tags Port as attributeName', () => {
    const port = findNode('a[out] -> b', 'Port');
    expect(getStyleTags(port!)?.tags).toContain(t.attributeName);
  });

  it('carries fold configuration on Block, Object and Array (DD-01 §6)', () => {
    for (const name of ['Block', 'Object', 'Array']) {
      const type = sglLanguage.parser.nodeSet.types.find((ty) => ty.name === name);
      expect(type, `node type ${name}`).toBeTruthy();
      expect(type!.prop(foldNodeProp), `foldNodeProp on ${name}`).toBeDefined();
    }
  });

  it('carries indent configuration on Block, Object and Array (DD-01 §6)', () => {
    for (const name of ['Block', 'Object', 'Array']) {
      const type = sglLanguage.parser.nodeSet.types.find((ty) => ty.name === name);
      expect(type!.prop(indentNodeProp), `indentNodeProp on ${name}`).toBeDefined();
    }
  });

  it('bracket-matching metadata from @detectDelim survives parser.configure', () => {
    const openBrace = sglLanguage.parser.nodeSet.types.find((ty) => ty.name === '{');
    const closeBrace = sglLanguage.parser.nodeSet.types.find((ty) => ty.name === '}');
    expect(openBrace).toBeTruthy();
    expect(closeBrace).toBeTruthy();
  });

  it('parses a well-formed document with no error nodes', () => {
    const source = 'checkout: {\n  web: "Web App"\n  api: "API"\n  web -> api\n}';
    const tree = sglLanguage.parser.parse(source);
    let hasError = false;
    const cursor = tree.cursor();
    do {
      if (cursor.type.isError) hasError = true;
    } while (cursor.next());
    expect(hasError).toBe(false);
  });

  // A18, DD-11 T19: a `"""` string is highlighted as a string, and folds.
  it('tags MultilineString as a string', () => {
    const node = findNode('@label: """\n  a\n  """', 'MultilineString');
    expect(node).toBeTruthy();
    expect(getStyleTags(node!)?.tags).toContain(t.string);
  });

  it('folds a `"""` string between its delimiters, and an unterminated one to the end', () => {
    const fold = (source: string) => {
      const node = findNode(source, 'MultilineString');
      const fn = node?.type.prop(foldNodeProp);
      expect(fn, 'foldNodeProp on MultilineString').toBeDefined();
      const state = { doc: { sliceString: (a: number, b: number) => source.slice(a, b) } };
      return fn!(node!, state as never);
    };
    const closed = '@label: """\n  a\n  b\n  """\n';
    expect(fold(closed)).toEqual({ from: closed.indexOf('"""') + 3, to: closed.lastIndexOf('"""') });
    const open = '@label: """\n  a\n  b\n';
    expect(fold(open)).toEqual({ from: open.indexOf('"""') + 3, to: open.length });
  });

  it('parsing the same source twice is deterministic (DD-00 §3)', () => {
    const source = 'a -> b -> c';
    const t1 = sglLanguage.parser.parse(source);
    const t2 = sglLanguage.parser.parse(source);
    expect(t1.toString()).toBe(t2.toString());
  });
});
