import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Document, StringLit } from '../src/ast.js';
import { compile } from '../src/compile.js';
import { fromJson, toJson } from '../src/json.js';
import type { ContainerModel, DocumentModel } from '../src/model.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';
// The generated parser is committed (DD-10 §3), so this runs without the generator.
import { parser } from '../src/grammar/sgl.parser.js';

/**
 * A18 branch 1 (`feat/a18-grammar`): `"""` multi-line strings and the two
 * markdown escapes, DD-11 §4 (T15–T20) and T10/T11. Every table here is a
 * table in DD-11, and every row was run against the pre-A18 grammar first
 * (the "before" column in the comments is what that run gave).
 */

const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const corpus = (name: string): string => readFileSync(`${corpusDir}${name}`, 'utf8');

/** The leaf tokens that can hold a quoted string, in document order, as `Name:text`. */
function quoted(source: string): string[] {
  const out: string[] = [];
  const cursor = parser.parse(source).cursor();
  do {
    const name = cursor.type.isError ? '⚠' : cursor.type.name;
    if (name === 'String' || name === 'ConfigString' || name === 'MultilineString' || name === '⚠') {
      out.push(`${name}:${source.slice(cursor.from, cursor.to)}`);
    }
  } while (cursor.next());
  return out;
}

const codes = (source: string): string[] => parse(source).diagnostics.map((d) => d.code);

/** The decoded value of the root's `@label`, or of `@x`'s array items. */
function rootValue(source: string): unknown {
  const { ast } = parse(source);
  const entry = ast.entries[0];
  if (entry?.kind !== 'ConfigEntry') throw new Error('expected a config entry first');
  return plain(entry.value);
}

function plain(value: Document['entries'][number] | StringLit | { kind: string }): unknown {
  const v = value as { kind: string; value?: unknown; items?: { kind: string }[] };
  if (v.kind === 'String') return v.value;
  if (v.kind === 'Array') return (v.items ?? []).map(plain);
  return v.kind;
}

const label = (body: string): unknown => rootValue(`@label: ${body}\n`);

// ---------------------------------------------------------------------------
// T16: the precedence audit, one lexer test per row
// ---------------------------------------------------------------------------

describe('T16: the three tokens that start with `"`', () => {
  it.each([
    ['a space', '@x: "" \n', ['String:""']],
    ['a comma', '@x: "",\n', ['String:""']],
    ['a close brace', '@x: { k: ""}\n', ['String:""']],
    ['a close bracket', '@x: [""]\n', ['String:""']],
    ['a colon', '@x: { "": 1 }\n', ['String:""']],
  ])('`""` followed by %s is still an empty String', (_what, source, expected) => {
    expect(quoted(source)).toEqual(expected);
    expect(codes(source)).toEqual([]);
  });

  it('`"""a"""` in a value is one MultilineString (before: `""`, `"a"`, `""`)', () => {
    expect(quoted('@x: """a"""\n')).toEqual(['MultilineString:"""a"""']);
  });

  it('`""""""` in a value is one empty MultilineString (before: three empty Strings)', () => {
    expect(quoted('@x: """"""\n')).toEqual(['MultilineString:""""""']);
    expect(label('""""""')).toBe('');
    expect(codes('@x: """"""\n')).toEqual([]);
  });

  it('`"""@x"""` is a MultilineString, a label that starts with `@` (before: a syntax error)', () => {
    expect(quoted('@label: """@x"""\n')).toEqual(['MultilineString:"""@x"""']);
    expect(label('"""@x"""')).toBe('@x');
    expect(codes('@label: """@x"""\n')).toEqual([]);
  });

  it('`"@style.stroke"` is still a ConfigString', () => {
    expect(quoted('"@style.stroke": "red"\n')).toEqual(['ConfigString:"@style.stroke"', 'String:"red"']);
    expect(quoted('@x: "@accent"\n')).toEqual(['ConfigString:"@accent"']);
  });

  it('`""""` (four quotes) opens a MultilineString (before: two empty Strings)', () => {
    const source = '@x: [""""]\n';
    expect(quoted(source)[0]).toBe(`MultilineString:${source.slice(5)}`);
    expect(codes(source)).toEqual(['SGL1003']);
  });

  it.each([
    ['a line comment', '"""a // not a comment"""', 'a // not a comment'],
    ['a block comment', '"""a /* not a comment"""', 'a /* not a comment'],
    ['one quote', '"""say "hi" now"""', 'say "hi" now'],
    ['two quotes', '"""a "" b"""', 'a "" b'],
    ['escaped quotes', '"""a \\"\\"\\" b"""', 'a """ b'],
  ])('%s inside `"""…"""` is part of the string, and nothing is reported', (_what, body, value) => {
    const source = `@label: ${body}\n`;
    expect(quoted(source)).toEqual([`MultilineString:${body}`]);
    expect(label(body)).toBe(value);
    expect(codes(source)).toEqual([]);
  });
});

describe('T15: `"""` is a value, never a key or a path', () => {
  it.each([
    ['a node value', 'a: """x"""\n'],
    ['an edge value', 'a -> b: """x"""\n'],
    ['a config value', '@label: """x"""\n'],
    ['a property value', '@x: { k: """x""" }\n'],
    ['an array item', '@x: ["""x"""]\n'],
  ])('is accepted as %s', (_where, source) => {
    expect(quoted(source)).toEqual(['MultilineString:"""x"""']);
    expect(codes(source)).toEqual([]);
  });

  // Lezer's lexer is not fully contextual: String and MultilineString share a
  // token group (they overlap, and @precedence ranks them), so `"""` lexes as
  // a MultilineString wherever a String could start, keys included. No key or
  // path production accepts one, so there it is a syntax error: the token sits
  // inside an error node, never inside a NodeKey, PathSegment or PropKey, and
  // never reaches the AST as a key.
  //
  // Before A18, rows 1, 2, 5 and 6 were valid documents: adjacent quoted keys
  // `""`, `"k"` and `""` (commas are optional), e.g. `"""k""": v` was three
  // nodes and `a -> """k""" -> b` an edge, a node and an edge. Rows 3 and 4
  // were already errors (SGL1001). No committed document holds any of them.
  it.each([
    ['a node key at the start of an entry', '"""k""": v\n'],
    ['a node key inside a block', 'a: { """k""": v }\n'],
    ['an object key', '@x: { """k""": 1 }\n'],
    ['a path segment after `.`', 'a."""k""" -> b\n'],
    ['an edge endpoint after an operator', 'a -> """k""" -> b\n'],
    ['an edge`s first endpoint', '"""k""" -> b\n'],
  ])('is a syntax error (SGL1002) as %s', (_where, source) => {
    const cursor = parser.parse(source).cursor();
    let seen = 0;
    do {
      if (cursor.type.name !== 'MultilineString') continue;
      seen += 1;
      expect(cursor.node.parent?.type.isError).toBe(true);
    } while (cursor.next());
    expect(seen).toBe(1);
    const { ast, diagnostics } = parse(source);
    const open = source.indexOf('"""');
    expect(diagnostics.find((d) => d.code === 'SGL1002')?.span).toEqual({ from: open, to: open + 7 });
    expect(JSON.stringify(ast)).not.toMatch(/"(key|value)":"k"/);
  });
});

describe('T16: the pre-A18 inputs that change (three or more quotes in a row)', () => {
  // Before A18 each of these was adjacent strings with nothing between them.
  it.each([
    ['@x: ["""a"""]\n', ['', 'a', ''], ['a']],
    ['@x: [""""""]\n', ['', '', ''], ['']],
    ['@x: ["""""", ""]\n', ['', '', '', ''], ['', '']],
    ['@x: ["""a""" "b"]\n', ['', 'a', '', 'b'], ['a', 'b']],
  ])('%s: now one string per `"""…"""`', (source, _before, after) => {
    expect(rootValue(source)).toEqual(after);
    expect(codes(source)).toEqual([]);
  });

  it('`a: """a"""` is one node with a label (before: nodes `a`, `"a"` and `""`)', () => {
    const { ast, diagnostics } = parse('a: """a"""\n');
    expect(diagnostics).toEqual([]);
    expect(ast.entries).toHaveLength(1);
    const a = ast.entries[0];
    expect(a?.kind === 'NodeDecl' && a.value?.kind === 'String' ? a.value.value : undefined).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// T17: dedent
// ---------------------------------------------------------------------------

describe('T17: dedent', () => {
  it.each([
    ['DD-11 T17 example', '"""\n    **Payments API**\n    handles `POST /pay`\n    """', '**Payments API**\nhandles `POST /pay`'],
    ['one line', '"""one line"""', 'one line'],
    ['empty', '""""""', ''],
    ['only whitespace', '"""   """', ''],
    ['only a newline', '"""\n"""', ''],
    ['a first line of only whitespace is dropped', '"""   \t\n  a\n  """', 'a'],
    ['a first line with text is kept as written, and not in the indent', '"""first\n    second\n    third\n    """', 'first\nsecond\nthird'],
    ['the closing delimiter sets the indent', '"""\n      a\n        b\n    """', '  a\n    b'],
    ['a closing delimiter further right than the text does not', '"""\n  a\n  b\n      """', 'a\nb'],
    ['the closing `"""` on the last text line', '"""\n  a\n  b"""', 'a\nb'],
    ['tabs never match spaces', '"""\n\ta\n  b\n"""', '\ta\n  b'],
    ['tabs match tabs', '"""\n\t\ta\n\tb\n\t"""', '\ta\nb'],
    // The closing delimiter offers two spaces, but the tab line agrees with
    // no space, so the common indent is empty (fix round 1, mutant M4: a
    // comparison that let a tab match a space would cut one character).
    ['tabs never match spaces, even with the closing `"""` indented', '"""\n\ta\n  b\n  """', '\ta\n  b'],
    ['a mixed prefix matches only as far as it agrees', '"""\n \ta\n \t b\n  c\n """', '\ta\n\t b\n c'],
    ['trailing spaces and tabs are removed', '"""\n  a   \n  b\t \n  """', 'a\nb'],
    ['blank lines are kept, empty, and do not set the indent', '"""\n    a\n\n  \n    b\n    """', 'a\n\n\nb'],
    ['CRLF becomes LF', '"""\r\n  a\r\n  b\r\n  """', 'a\nb'],
    ['a lone CR becomes LF', '"""\r  a\r  b\r  """', 'a\nb'],
    ['escapes are decoded after dedent: \\t and \\u0020 put whitespace back', '"""\n  a\\t\n  \\u0020b\n  """', 'a\t\n b'],
    ['an escaped newline is text, not a line', '"""\n  a\\nb\n  """', 'a\nb'],
    ['`\\n` beside a real line break', '"""\n  one\\ntwo\n  three\n  """', 'one\ntwo\nthree'],
    ['non-ASCII whitespace is text, not indent', '"""\n  \u00a0a\n  """', '\u00a0a'],
  ])('%s', (_name, body, expected) => {
    const source = `@label: ${body}\n`;
    expect(parse(source).diagnostics).toEqual([]);
    expect(label(body)).toBe(expected);
  });

  it('dedents inside a block, where the indent is the block`s', () => {
    const source = 'api: {\n  @label: """\n    **Payments API**\n    handles `POST /pay`\n    """\n}\n';
    const { ast, diagnostics } = parse(source);
    expect(diagnostics).toEqual([]);
    const api = ast.entries[0];
    const block = api?.kind === 'NodeDecl' && api.value?.kind === 'Block' ? api.value : undefined;
    const entry = block?.entries[0];
    expect(entry?.kind === 'ConfigEntry' ? plain(entry.value) : undefined).toBe('**Payments API**\nhandles `POST /pay`');
  });

  it('SGL1004 points at the escape`s source offset, not at the dedented text', () => {
    const source = '@label: """\n      x\\q\n      """\n';
    const { diagnostics } = parse(source);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL1004']);
    const at = source.indexOf('\\q');
    expect(diagnostics[0]?.span).toEqual({ from: at, to: at + 2 });
    expect(label('"""\n      x\\q\n      """')).toBe('x\\q');
  });

  it('SGL1004 offsets survive CRLF normalisation', () => {
    const source = '@label: """\r\n  a\r\n  x\\q\r\n  """\n';
    const { diagnostics } = parse(source);
    const at = source.indexOf('\\q');
    expect(diagnostics.map((d) => [d.code, d.span.from, d.span.to])).toEqual([['SGL1004', at, at + 2]]);
  });

  it('T18: a `\\` at the end of a line is SGL1004 and kept as written', () => {
    const source = '@label: """\n  a\\\n  b\n  """\n';
    const { diagnostics } = parse(source);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL1004']);
    const at = source.indexOf('\\');
    expect(diagnostics[0]?.span).toEqual({ from: at, to: at + 2 });
    expect(label('"""\n  a\\\n  b\n  """')).toBe('a\\\nb');
  });

  it('the AST span is the whole token, quotes included', () => {
    const source = '@label: """\n  a\n  """\n';
    const { ast } = parse(source);
    const entry = ast.entries[0];
    expect(entry?.kind === 'ConfigEntry' ? entry.value.span : undefined).toEqual({ from: 8, to: source.length - 1 });
  });
});

// ---------------------------------------------------------------------------
// T19: an unterminated `"""`
// ---------------------------------------------------------------------------

describe('T19: an unterminated `"""` is exactly one SGL1003, to the end of the input', () => {
  it.each([
    ['at the top level', '@label: """never closed\nb: 1\n'],
    ['inside a block', 'a: {\n  @label: """never closed\n  b: 1\n}\nc -> d\n'],
    ['with a quote and comments after it', 'a: { @label: """x\n" // /* c\nb -> "c"\n'],
    ['as an edge label', 'a -> b: """x\ny\n'],
    ['as an array item', '@x: ["a", """b]\nc\n'],
    ['with one quote before the end', '@label: """abc"'],
    ['with two quotes before the end', '@label: """abc""'],
    ['with nothing after it', '@label: """'],
    ['ending in a backslash', '@label: """abc\\'],
  ])('%s', (_where, source) => {
    const { diagnostics } = parse(source);
    const open = source.indexOf('"""');
    expect(diagnostics.map((d) => [d.code, d.span.from, d.span.to])).toEqual([['SGL1003', open, source.length]]);
  });

  it('keeps the entries before it (FR-E4)', () => {
    const { ast } = parse('a\nb: { @label: """x\n');
    expect(ast.entries.map((e) => (e.kind === 'NodeDecl' ? e.key : e.kind))).toEqual(['a', 'b']);
  });

  // Fix round 1, item 1: an unclosed `/*` that is not a comment (an edge to
  // every root child, `x -> /*`) must not hide a later unterminated `"""`.
  it.each([
    ['at the top level', 'x -> /*\na: """ hi'],
    ['inside a block', 'x -> /*\ny: { a: """ hi\n}'],
  ])('after an edge to `/*`, %s, is still exactly one SGL1003', (_where, source) => {
    const { diagnostics } = parse(source);
    const open = source.indexOf('"""');
    expect(diagnostics.map((d) => [d.code, d.span.from, d.span.to])).toEqual([['SGL1003', open, source.length]]);
  });

  it('an unterminated block comment with no `"""` after it is still SGL1005', () => {
    const source = 'a\n/* never ends\nb: "x"\n';
    expect(parse(source).diagnostics.map((d) => [d.code, d.span.from, d.span.to])).toEqual([['SGL1005', 2, source.length]]);
  });

  // Fix round 1, item 3 (mutant M13): the body's end honours escapes, so an
  // escaped quote followed by two more does not close the string.
  it('`\\"` followed by `""` does not close the string', () => {
    const source = 'a: """say \\""" ok"""\n';
    const { ast, diagnostics } = parse(source);
    expect(diagnostics).toEqual([]);
    const a = ast.entries[0];
    expect(a?.kind === 'NodeDecl' && a.value?.kind === 'String' ? a.value.value : undefined).toBe('say """ ok');
  });

  it('a closed `"""` hides a `"`, `//` and `/*` from scanLexicalErrors', () => {
    expect(codes('@label: """ " // /* """\nb\n')).toEqual([]);
  });

  it('an ordinary unterminated String is unchanged: SGL1003 to the end of its line, then the missing `}`', () => {
    const source = 'a: { @label: "never closed\nb\n';
    const { diagnostics } = parse(source);
    expect(diagnostics.map((d) => [d.code, d.span.from, d.span.to])).toEqual([
      ['SGL1003', 13, 26],
      ['SGL1001', 29, 29],
    ]);
  });
});

// ---------------------------------------------------------------------------
// T20: interpolation
// ---------------------------------------------------------------------------

function child(model: DocumentModel, key: string): ContainerModel {
  const found = model.root.children.find((c) => c.key === key);
  if (found === undefined) throw new Error(`no child ${key}`);
  return found;
}

describe('T20: A8 variables inside `"""`', () => {
  it('interpolates `${name}` in the dedented text', () => {
    const src = '@vars: { tier: "prod" }\napi: {\n  @label: """\n    API\n    (${tier})\n    """\n}\n';
    const { model, diagnostics } = resolve(parse(src).ast);
    expect(diagnostics).toEqual([]);
    expect(child(model, 'api').config.label).toBe('API\n(prod)');
  });

  it('inserts a value`s own newlines as they are, not re-indented', () => {
    const src = '@vars: { v: "x\\ny" }\napi: {\n  @label: """\n    a ${v}\n    b\n    """\n}\n';
    const { model, diagnostics } = resolve(parse(src).ast);
    expect(diagnostics).toEqual([]);
    expect(child(model, 'api').config.label).toBe('a x\ny\nb');
  });

  it('a whole `"""$name"""` is a whole-value reference, and keeps its type', () => {
    const src = '@vars: { n: 3 }\napi: { @order: """$n""" }\n';
    const { model, diagnostics } = resolve(parse(src).ast);
    expect(diagnostics).toEqual([]);
    expect(child(model, 'api').config.order).toBe(3);
  });

  it('works in the edge and node label shorthands', () => {
    const src = '@vars: { t: "prod" }\na: """\n  A ${t}\n  """\nb\na -> b: """via\n  ${t}"""\n';
    const { model, diagnostics } = resolve(parse(src).ast);
    expect(diagnostics).toEqual([]);
    expect(child(model, 'a').config.label).toBe('A prod');
    expect(model.root.edges[0]?.config.label).toBe('via\nprod');
  });

  it('an unknown name inside `"""` is SGL2013 at the string`s span', () => {
    const src = 'api: { @label: """\n  ${nope}\n  """ }\n';
    const { diagnostics } = resolve(parse(src).ast);
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2013']);
  });
});

// ---------------------------------------------------------------------------
// T10/T11: `\*` and `` \` ``
// ---------------------------------------------------------------------------

describe('T11: `\\*` and `` \\` `` decode to themselves, with no SGL1004', () => {
  const src = 'a: { @label: "\\*not\\* \\`code\\`", @tooltip: "C:\\\\temp\\*.log" }\nb: """\n  \\*x\\*\n  """\n';

  it('parses with no diagnostic, keeping each backslash', () => {
    const { ast, diagnostics } = parse(src);
    expect(diagnostics).toEqual([]);
    const a = ast.entries[0];
    const block = a?.kind === 'NodeDecl' && a.value?.kind === 'Block' ? a.value : undefined;
    const values = block?.entries.map((e) => (e.kind === 'ConfigEntry' ? plain(e.value) : undefined));
    expect(values).toEqual(['\\*not\\* \\`code\\`', 'C:\\temp\\*.log']);
  });

  it('`"\\\\*"` decodes to the same two characters as `"\\*"`', () => {
    expect(label('"\\\\*"')).toBe(label('"\\*"'));
    expect(label('"\\*"')).toBe('\\*');
  });

  it('decodes the same way in a ConfigString and a quoted key', () => {
    const { ast, diagnostics } = parse('"k\\*": { "@label": "@\\`x" }\n');
    expect(diagnostics).toEqual([]);
    const k = ast.entries[0];
    expect(k?.kind === 'NodeDecl' ? k.key : undefined).toBe('k\\*');
  });

  it('keeps them verbatim through resolve, toJson and fromJson (a round trip)', () => {
    const first = resolve(parse(src).ast);
    expect(first.diagnostics).toEqual([]);
    expect(child(first.model, 'a').config.label).toBe('\\*not\\* \\`code\\`');
    expect(child(first.model, 'a').config.tooltip).toBe('C:\\temp\\*.log');
    expect(child(first.model, 'b').config.label).toBe('\\*x\\*');

    const json = toJson(first.model);
    expect(json).toContain('"@label": "\\\\*not\\\\* \\\\`code\\\\`"');
    const again = fromJson(json);
    expect(again.diagnostics).toEqual([]);
    expect(toJson(again.model)).toBe(json);
    expect(child(again.model, 'a').config.label).toBe('\\*not\\* \\`code\\`');
    expect(child(again.model, 'b').config.label).toBe('\\*x\\*');
  });

  it('this branch still draws them literally: compile`s runs keep the backslash', () => {
    const { graph } = compile(resolve(parse(src).ast).model);
    const texts = Object.values(graph.labels).flatMap((l) => l.runs.map((r) => r.text));
    expect(texts).toContain('\\*not\\* \\`code\\`');
  });

  it('every other unknown escape is still SGL1004', () => {
    expect(codes('@label: "\\q \\$ \\_"\n')).toEqual(['SGL1004', 'SGL1004', 'SGL1004']);
  });
});

// ---------------------------------------------------------------------------
// The corpus documents, and determinism
// ---------------------------------------------------------------------------

describe('corpus/multiline.sgl', () => {
  it('parses and resolves with zero diagnostics, and its labels are dedented', () => {
    const { ast, diagnostics } = parse(corpus('multiline.sgl'));
    expect(diagnostics).toEqual([]);
    const { model, diagnostics: resolved } = resolve(ast);
    expect(resolved).toEqual([]);
    expect(child(model, 'api').config.label).toBe('**Payments API**\nhandles `POST /pay`');
  });

  it.each(['multiline.sgl', 'malformed/unterminated-triple-string.sgl'])('%s: two runs give byte-identical output (determinism)', (name) => {
    const source = corpus(name);
    const run = () => {
      const parsed = parse(source);
      const resolved = resolve(parsed.ast);
      const compiled = compile(resolved.model);
      return JSON.stringify([parsed, resolved.diagnostics, toJson(resolved.model), compiled.graph, compiled.diagnostics]);
    };
    expect(run()).toBe(run());
  });

  it('malformed/unterminated-triple-string.sgl is one SGL1003 and nothing else', () => {
    const source = corpus('malformed/unterminated-triple-string.sgl');
    const { diagnostics } = parse(source);
    expect(diagnostics.map((d) => [d.code, d.span.to])).toEqual([['SGL1003', source.length]]);
  });
});
