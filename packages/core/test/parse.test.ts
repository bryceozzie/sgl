import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Ast, Document } from '../src/ast.js';
import type { DiagnosticCode } from '../src/diagnostics.js';
import { parse } from '../src/parse.js';
import type { SourceSpan } from '../src/span.js';

const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));
const corpus = (name: string): string => readFileSync(`${corpusDir}${name}`, 'utf8');

const CLEAN_DOCS = [
  'empty.sgl',
  'single.sgl',
  'json-form.sgl.json',
  'checkout.sgl',
  'nesting-3.sgl',
  'chains.sgl',
  'parallel-selfloop.sgl',
  'ports.sgl',
  'classes.sgl',
  'containers-edges.sgl',
  'wildcards.sgl',
  'wildcard-globs.sgl',
  'wildcard-paths.sgl',
  'shapes.sgl',
  'unicode.sgl',
  'hidden.sgl',
  'variables.sgl',
];

describe('parse() over the corpus', () => {
  it.each(CLEAN_DOCS)('parses %s with zero diagnostics', (name) => {
    const { diagnostics } = parse(corpus(name));
    expect(diagnostics).toEqual([]);
  });

  it.each(CLEAN_DOCS)('parses %s twice to byte-identical output (determinism)', (name) => {
    const source = corpus(name);
    const first = parse(source);
    const second = parse(source);
    expect(JSON.stringify(second.ast)).toBe(JSON.stringify(first.ast));
    expect(JSON.stringify(second.diagnostics)).toBe(JSON.stringify(first.diagnostics));
  });

  it.each(CLEAN_DOCS)('covers %s with valid, in-bounds spans on every AST node', (name) => {
    const source = corpus(name);
    const { ast } = parse(source);
    for (const sp of collectSpans(ast)) assertValidSpan(sp, source.length);
  });
});

describe('parse() over corpus/malformed', () => {
  const dir = `${corpusDir}malformed/`;
  const files = readdirSync(dir).filter((f) => f.endsWith('.sgl'));

  it('has at least one fixture', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s yields a diagnostic plus a non-empty partial AST', (name) => {
    const source = readFileSync(`${dir}${name}`, 'utf8');
    const expected = /\/\/ expects: (SGL\d{4})/.exec(source)?.[1] as DiagnosticCode | undefined;
    expect(expected, `${name} is missing a "// expects: SGLnnnn" header`).toBeDefined();

    const { ast, diagnostics } = parse(source);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.code === expected)).toBe(true);
    expect(ast.entries.length).toBeGreaterThan(0);

    for (const d of diagnostics) assertValidSpan(d.span, source.length);
    for (const sp of collectSpans(ast)) assertValidSpan(sp, source.length);
  });

  it.each(files)('parses %s twice to byte-identical diagnostics and AST', (name) => {
    const source = readFileSync(`${dir}${name}`, 'utf8');
    const first = parse(source);
    const second = parse(source);
    expect(JSON.stringify(second.ast)).toBe(JSON.stringify(first.ast));
    expect(JSON.stringify(second.diagnostics)).toBe(JSON.stringify(first.diagnostics));
  });
});

function assertValidSpan(sp: SourceSpan, sourceLength: number): void {
  expect(sp.from).toBeLessThanOrEqual(sp.to);
  expect(sp.from).toBeGreaterThanOrEqual(0);
  expect(sp.to).toBeLessThanOrEqual(sourceLength);
}

/** Every span reachable from the document: node spans plus key/port spans. */
function collectSpans(doc: Document): SourceSpan[] {
  const out: SourceSpan[] = [];
  walk(doc, out);
  return out;
}

function walk(node: Ast, out: SourceSpan[]): void {
  out.push(node.span);
  switch (node.kind) {
    case 'Document':
    case 'Block':
      for (const entry of node.entries) walk(entry, out);
      return;
    case 'ConfigEntry':
      out.push(node.keySpan);
      walk(node.value, out);
      return;
    case 'NodeDecl':
      out.push(node.keySpan);
      if (node.value !== undefined) walk(node.value, out);
      return;
    case 'EdgeStmt':
      for (const endpoint of node.endpoints) walk(endpoint, out);
      if (node.value !== undefined) walk(node.value, out);
      return;
    case 'Endpoint':
      walk(node.path, out);
      if (node.portSpan !== undefined) out.push(node.portSpan);
      return;
    case 'PathExpr':
      for (const step of node.segments) walk(step, out);
      return;
    case 'Array':
      for (const item of node.items) walk(item, out);
      return;
    case 'Object':
      for (const prop of node.props) walk(prop, out);
      return;
    case 'Property':
      out.push(node.keySpan);
      walk(node.value, out);
      return;
    case 'String':
    case 'Number':
    case 'Bool':
    case 'Null':
    case 'Word':
    case 'Variable':
    case 'Name':
    case 'Wildcard':
      return;
  }
}

describe('qualified names in the AST (A9, I16)', () => {
  it('a qualified class shorthand is one Word, dots and all', () => {
    const { ast, diagnostics } = parse('lambda: aws.Lambda');
    expect(diagnostics).toEqual([]);
    const decl = ast.entries[0];
    expect(decl?.kind === 'NodeDecl' && decl.value).toMatchObject({ kind: 'Word', value: 'aws.Lambda', span: { from: 8, to: 18 } });
  });

  it('a qualified Word ignores whitespace and comments between its parts', () => {
    const { ast, diagnostics } = parse('@type: aws /* c */ . Lambda');
    expect(diagnostics).toEqual([]);
    const entry = ast.entries[0];
    expect(entry?.kind === 'ConfigEntry' && entry.value).toMatchObject({ kind: 'Word', value: 'aws.Lambda' });
  });

  it('a qualified variable keeps its whole name, the `$` dropped', () => {
    const { ast, diagnostics } = parse('@x: $aws.brand');
    expect(diagnostics).toEqual([]);
    const entry = ast.entries[0];
    expect(entry?.kind === 'ConfigEntry' && entry.value).toMatchObject({ kind: 'Variable', name: 'aws.brand' });
  });
});
