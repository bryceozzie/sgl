import type { SyntaxNode, Tree } from '@lezer/common';
import type {
  ArrayLit,
  Block,
  ConfigEntry,
  Document,
  EdgeOp,
  EdgeStmt,
  Endpoint,
  Entry,
  NodeDecl,
  ObjectLit,
  PathExpr,
  PathStep,
  Property,
  StringLit,
  Value,
  Variable,
  WildcardStep,
  Word,
} from './ast.js';
import { diagnostic, type Diagnostic, type StageResult } from './diagnostics.js';
import { span, type SourceSpan } from './span.js';

/**
 * Turn a Lezer CST into the typed AST of DD-01 §3.
 *
 * One pass, one object per CST node, no line/column anywhere — every node carries
 * UTF-16 offsets (DD-00 §3). Never throws: a partial tree yields the best AST it
 * can plus `SGL1xxx` diagnostics (FR-L12, DD-01 §4).
 *
 * Exported in its own right because the editor already has a parsed tree and must
 * not pay for a second parse (DD-01 §5, DD-08 §4).
 */
export function buildAst(tree: Tree, source: string): StageResult<Document> {
  const ctx: Ctx = { source, diagnostics: [] };

  // Lexical errors first: an unterminated string or comment defines a region that
  // the error nodes inside it are merely the debris of.
  const lexical = scanLexicalErrors(tree, source);
  ctx.diagnostics.push(...lexical);
  ctx.diagnostics.push(...errorNodeDiagnostics(tree, source, lexical));

  const ast = buildDocument(ctx, tree.topNode);

  return { value: ast, diagnostics: ctx.diagnostics };
}

interface Ctx {
  readonly source: string;
  readonly diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// CST navigation
// ---------------------------------------------------------------------------

/** Comments are named nodes in the tree even though they are skipped tokens. */
const COMMENTS: ReadonlySet<string> = new Set(['LineComment', 'BlockComment']);

const kids = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c !== null; c = c.nextSibling) out.push(c);
  return out;
};

const childNamed = (node: SyntaxNode, name: string): SyntaxNode | null => {
  for (let c = node.firstChild; c !== null; c = c.nextSibling) if (c.name === name) return c;
  return null;
};

const hasChild = (node: SyntaxNode, name: string): boolean => childNamed(node, name) !== null;

/** The first child that carries meaning: not a comment, not an error node. */
const firstMeaningful = (node: SyntaxNode): SyntaxNode | null => {
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (!COMMENTS.has(c.name) && !c.type.isError) return c;
  }
  return null;
};

const at = (node: SyntaxNode): SourceSpan => span(node.from, node.to);

const textOf = (ctx: Ctx, node: SyntaxNode): string => ctx.source.slice(node.from, node.to);

// ---------------------------------------------------------------------------
// Document, entries, blocks
// ---------------------------------------------------------------------------

/**
 * `@top Document { Block | Entry* }` — the root braces are optional, so the block
 * form is flattened and both shapes produce the same `Document` (DD-01 §2). The
 * span is the whole source rather than the top node's extent, so an empty or
 * trailing-whitespace-only document still reports where it lives.
 */
function buildDocument(ctx: Ctx, node: SyntaxNode): Document {
  const entries: Entry[] = [];
  for (const child of kids(node)) collectEntries(ctx, child, entries);
  return { kind: 'Document', entries, span: span(0, ctx.source.length) };
}

function collectEntries(ctx: Ctx, node: SyntaxNode, out: Entry[]): void {
  if (node.name === 'Entry') {
    const entry = buildEntry(ctx, node);
    if (entry !== undefined) out.push(entry);
    return;
  }
  // The anonymous root block, flattened. Recovery can leave more than one of
  // these at document level; merging them is the friendliest partial result.
  if (node.name === 'Block') {
    for (const child of kids(node)) collectEntries(ctx, child, out);
  }
}

function buildEntry(ctx: Ctx, node: SyntaxNode): Entry | undefined {
  const inner = firstMeaningful(node);
  if (inner === null) return undefined;
  switch (inner.name) {
    case 'ConfigEntry':
      return buildConfigEntry(ctx, inner);
    case 'NodeDecl':
      return buildNodeDecl(ctx, inner);
    case 'EdgeStmt':
      return buildEdgeStmt(ctx, inner);
    default:
      return undefined;
  }
}

function buildBlock(ctx: Ctx, node: SyntaxNode): Block {
  const entries: Entry[] = [];
  for (const child of kids(node)) {
    if (child.name !== 'Entry') continue;
    const entry = buildEntry(ctx, child);
    if (entry !== undefined) entries.push(entry);
  }
  return { kind: 'Block', entries, span: at(node) };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `@style.stroke: …` and `"@style.stroke": …` build the identical node: the `@`
 * is dropped and the dotted key is split. The second spelling is what makes any
 * JSON object a valid SGL document (FR-L1, FR-L6).
 *
 * An entry whose value never arrived is dropped rather than given a synthetic
 * one — see the note in `buildProperty`.
 */
function buildConfigEntry(ctx: Ctx, node: SyntaxNode): ConfigEntry | undefined {
  const keyNode = childNamed(node, 'ConfigKey') ?? childNamed(node, 'ConfigString');
  const valueNode = childNamed(node, 'Value');
  if (keyNode === null || valueNode === null) return undefined;

  const value = buildValue(ctx, valueNode);
  if (value === undefined) return undefined;

  return {
    kind: 'ConfigEntry',
    key: splitConfigKey(configKeyText(ctx, keyNode)),
    value,
    keySpan: at(keyNode),
    span: at(node),
  };
}

/** The key text with its quotes, if any, removed — `@style.stroke` either way. */
const configKeyText = (ctx: Ctx, node: SyntaxNode): string =>
  node.name === 'ConfigString' ? ctx.source.slice(node.from + 1, node.to - 1) : textOf(ctx, node);

/** `@style.stroke` → `['style','stroke']`. The `@` is dropped (DD-01 §3). */
const splitConfigKey = (text: string): string[] => text.replace(/^@/, '').split('.');

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function buildNodeDecl(ctx: Ctx, node: SyntaxNode): NodeDecl | undefined {
  const keyNode = childNamed(node, 'NodeKey');
  if (keyNode === null) return undefined;
  const keyToken = firstMeaningful(keyNode);
  if (keyToken === null) return undefined;

  const key = keyToken.name === 'Identifier' ? textOf(ctx, keyToken) : decodeString(ctx, keyToken);
  const value = buildNodeValue(ctx, node);

  return value === undefined
    ? { kind: 'NodeDecl', key, keySpan: at(keyNode), span: at(node) }
    : { kind: 'NodeDecl', key, keySpan: at(keyNode), value, span: at(node) };
}

/** `NodeValue { Block | String | ConfigString | ClassRef }`; a `ClassRef` becomes
 *  a `Word`, because a bareword under a node key is a class, not a label. */
function buildNodeValue(ctx: Ctx, node: SyntaxNode): Block | StringLit | Word | undefined {
  const valueNode = childNamed(node, 'NodeValue');
  if (valueNode === null) return undefined;
  const inner = firstMeaningful(valueNode);
  if (inner === null) return undefined;
  switch (inner.name) {
    case 'Block':
      return buildBlock(ctx, inner);
    case 'String':
    case 'ConfigString':
      return { kind: 'String', value: decodeString(ctx, inner), span: at(inner) };
    case 'ClassRef':
      return { kind: 'Word', value: qualifiedName(ctx, inner), span: at(inner) };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

const EDGE_OPS: ReadonlySet<string> = new Set(['->', '<-', '<->', '--']);

function buildEdgeStmt(ctx: Ctx, node: SyntaxNode): EdgeStmt | undefined {
  const endpoints: Endpoint[] = [];
  const ops: EdgeOp[] = [];
  let value: StringLit | Block | undefined;

  for (const child of kids(node)) {
    switch (child.name) {
      case 'Endpoint': {
        const endpoint = buildEndpoint(ctx, child);
        if (endpoint !== undefined) endpoints.push(endpoint);
        break;
      }
      case 'EdgeOp': {
        const text = textOf(ctx, child);
        if (EDGE_OPS.has(text)) ops.push(text as EdgeOp);
        break;
      }
      case 'EdgeValue': {
        value = buildEdgeValue(ctx, child);
        break;
      }
      default:
        break;
    }
  }

  if (endpoints.length === 0) return undefined;
  // `ops.length === endpoints.length - 1` is part of the type. Recovery can leave
  // a trailing operator with nothing after it (`a -> `); drop it rather than ship
  // an AST that lies about its own shape.
  while (ops.length > endpoints.length - 1) ops.pop();

  return value === undefined
    ? { kind: 'EdgeStmt', endpoints, ops, span: at(node) }
    : { kind: 'EdgeStmt', endpoints, ops, value, span: at(node) };
}

function buildEdgeValue(ctx: Ctx, node: SyntaxNode): StringLit | Block | undefined {
  const inner = firstMeaningful(node);
  if (inner === null) return undefined;
  switch (inner.name) {
    case 'Block':
      return buildBlock(ctx, inner);
    case 'String':
    case 'ConfigString':
      return { kind: 'String', value: decodeString(ctx, inner), span: at(inner) };
    default:
      return undefined;
  }
}

function buildEndpoint(ctx: Ctx, node: SyntaxNode): Endpoint | undefined {
  const pathNode = childNamed(node, 'Path');
  if (pathNode === null) return undefined;
  const path = buildPath(ctx, pathNode);

  const portNode = childNamed(node, 'Port');
  const portName = portNode === null ? null : childNamed(portNode, 'Identifier');
  if (portName === null) return { kind: 'Endpoint', path, span: at(node) };

  return {
    kind: 'Endpoint',
    path,
    port: textOf(ctx, portName),
    portSpan: at(portName),
    span: at(node),
  };
}

function buildPath(ctx: Ctx, node: SyntaxNode): PathExpr {
  let parents = 0;
  const segments: PathStep[] = [];
  for (const child of kids(node)) {
    if (child.name === 'Parent') parents += 1;
    else if (child.name === 'PathStep') {
      const step = buildPathStep(ctx, child);
      if (step !== undefined) segments.push(step);
    }
  }
  return {
    kind: 'PathExpr',
    root: hasChild(node, 'Root'),
    parents,
    segments,
    span: at(node),
  };
}

function buildPathStep(ctx: Ctx, node: SyntaxNode): PathStep | undefined {
  const inner = firstMeaningful(node);
  if (inner === null) return undefined;
  if (inner.name === 'Wildcard') return buildWildcardStep(textOf(ctx, inner), at(node));
  if (inner.name !== 'PathSegment') return undefined;

  const token = firstMeaningful(inner);
  if (token === null) return undefined;
  const value = token.name === 'Identifier' ? textOf(ctx, token) : decodeString(ctx, token);
  return { kind: 'Name', value, span: at(node) };
}

/**
 * Split the `Wildcard` token around its single star (DD-01 §3).
 *
 * `**` is the only form that crosses levels, and by construction it never carries
 * a glob, so everything else is `'children'` with the text either side of the
 * star — which is exactly what `matchesWildcard` consumes.
 */
function buildWildcardStep(text: string, sp: SourceSpan): WildcardStep {
  if (text === '**') return { kind: 'Wildcard', depth: 'descendants', prefix: '', suffix: '', span: sp };
  const star = text.indexOf('*');
  return {
    kind: 'Wildcard',
    depth: 'children',
    prefix: star < 0 ? text : text.slice(0, star),
    suffix: star < 0 ? '' : text.slice(star + 1),
    span: sp,
  };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function buildValue(ctx: Ctx, node: SyntaxNode): Value | undefined {
  const inner = firstMeaningful(node);
  if (inner === null) return undefined;
  const sp = at(inner);
  switch (inner.name) {
    case 'String':
    case 'ConfigString':
      return { kind: 'String', value: decodeString(ctx, inner), span: sp };
    case 'Number':
      return { kind: 'Number', value: Number(textOf(ctx, inner)), span: sp };
    case 'Bool':
      return { kind: 'Bool', value: textOf(ctx, inner) === 'true', span: sp };
    case 'Null':
      return { kind: 'Null', span: sp };
    case 'Word':
      return { kind: 'Word', value: qualifiedName(ctx, inner), span: sp };
    case 'Variable':
      return buildVariable(ctx, inner);
    case 'Array':
      return buildArray(ctx, inner);
    case 'Object':
      return buildObject(ctx, inner);
    default:
      return undefined;
  }
}

/** A `Word` or `ClassRef`: `Identifier ("." Identifier)*` (A9, I16), its
 *  parts joined by `.` — the grammar skips space and comments between them,
 *  and the name must not keep them. One part is just its text. */
function qualifiedName(ctx: Ctx, node: SyntaxNode): string {
  return node
    .getChildren('Identifier')
    .map((c) => textOf(ctx, c))
    .join('.');
}

/** `$name` or `$ns.name` — the `$` is dropped, matching how `@` is dropped off
 *  a config key. One token, so there is nothing between its parts. */
function buildVariable(ctx: Ctx, node: SyntaxNode): Variable {
  return { kind: 'Variable', name: textOf(ctx, node).slice(1), span: at(node) };
}

function buildArray(ctx: Ctx, node: SyntaxNode): ArrayLit {
  const items: Value[] = [];
  for (const child of kids(node)) {
    if (child.name !== 'Value') continue;
    const item = buildValue(ctx, child);
    if (item !== undefined) items.push(item);
  }
  return { kind: 'Array', items, span: at(node) };
}

function buildObject(ctx: Ctx, node: SyntaxNode): ObjectLit {
  const props: Property[] = [];
  for (const child of kids(node)) {
    if (child.name !== 'Property') continue;
    const prop = buildProperty(ctx, child);
    if (prop !== undefined) props.push(prop);
  }
  return { kind: 'Object', props, span: at(node) };
}

/**
 * A property whose value never arrived is dropped, not given a synthetic `null`.
 * `Property.value` and `ConfigEntry.value` are non-optional in the normative AST,
 * and half-typed `@label:` must not reach the resolver as `@label: null` — that
 * would blank a label mid-keystroke, which is the opposite of FR-E4. The key is
 * not lost to the author: Lezer's error node at the same offset is already an
 * `SGL1001`.
 */
function buildProperty(ctx: Ctx, node: SyntaxNode): Property | undefined {
  const keyNode = childNamed(node, 'PropKey');
  const valueNode = childNamed(node, 'Value');
  if (keyNode === null || valueNode === null) return undefined;
  const keyToken = firstMeaningful(keyNode);
  if (keyToken === null) return undefined;

  const value = buildValue(ctx, valueNode);
  if (value === undefined) return undefined;

  const isConfig = keyToken.name === 'ConfigKey' || keyToken.name === 'ConfigString';
  const key = isConfig
    ? configKeyText(ctx, keyToken).replace(/^@/, '')
    : keyToken.name === 'Identifier'
      ? textOf(ctx, keyToken)
      : decodeString(ctx, keyToken);

  return { kind: 'Property', key, isConfig, keySpan: at(keyNode), value, span: at(node) };
}

// ---------------------------------------------------------------------------
// String decoding
// ---------------------------------------------------------------------------

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a `String` or `ConfigString` token, quotes included, into its text.
 *
 * `\n \t \" \\ \/` and `\uXXXX` are the whole escape set (DD-01 §3). Anything else
 * is `SGL1004` and the backslash survives verbatim, so the author sees what they
 * typed rather than a silent repair.
 */
function decodeString(ctx: Ctx, node: SyntaxNode): string {
  const { source } = ctx;
  const start = node.from + 1;
  // A well-formed token ends in `"`. Recovery can hand us one that does not.
  const end = source[node.to - 1] === '"' && node.to - 1 > node.from ? node.to - 1 : node.to;

  let out = '';
  let i = start;
  while (i < end) {
    const ch = source[i] as string;
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    if (i + 1 >= end) {
      // A lone trailing backslash: nothing to decode, keep it as written.
      out += '\\';
      i += 1;
      continue;
    }

    const c = source[i + 1] as string;
    const simple = SIMPLE_ESCAPES[c];
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    if (c === 'u') {
      const hex = source.slice(i + 2, i + 6);
      if (i + 6 <= end && HEX4.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
    }
    ctx.diagnostics.push(diagnostic('SGL1004', span(i, i + 2), { c }));
    out += '\\' + c;
    i += 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Syntax diagnostics (DD-01 §4)
// ---------------------------------------------------------------------------

/** Nodes that own a closing delimiter, for naming the token an `SGL1001` wants. */
const CLOSERS: Readonly<Record<string, string>> = {
  Block: '}',
  Object: '}',
  Array: ']',
  Port: ']',
};

/**
 * Unterminated strings and block comments, which Lezer reports only as the debris
 * they leave behind: the `"` or `/*` simply fails to lex and the rest of the line
 * — or the file — tokenises as something else entirely.
 *
 * The scan mirrors the `String`, `LineComment` and `BlockComment` tokens exactly,
 * and every finding is cross-checked against a real error node in the tree. That
 * check is what keeps `x -> /*` (an edge to every root child, which is legal and
 * parses) from being reported as an unterminated comment.
 */
function scanLexicalErrors(tree: Tree, source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const errors = errorOffsets(tree);
  const confirmed = (from: number, to: number): boolean =>
    errors.some((offset) => offset >= from && offset <= to);

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed && confirmed(start, source.length)) {
        out.push(diagnostic('SGL1005', span(start, source.length)));
        return out;
      }
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\n') break;
        // `"\\" _` in the token: a backslash escapes whatever follows it.
        if (c === '\\') {
          i += 2;
          continue;
        }
        i += 1;
        if (c === '"') {
          closed = true;
          break;
        }
      }
      const stop = Math.min(i, source.length);
      if (!closed && confirmed(start, stop)) out.push(diagnostic('SGL1003', span(start, stop)));
      continue;
    }
    i += 1;
  }
  return out;
}

function errorOffsets(tree: Tree): number[] {
  const out: number[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) out.push(cursor.from);
  } while (cursor.next());
  return out;
}

/**
 * One `SGL1001`/`SGL1002` per contiguous error region (DD-01 §4): a zero-length
 * error node is a missing token, a non-empty one is input Lezer skipped. Regions
 * already explained by an `SGL1003`/`SGL1005` are dropped — a missing quote must
 * not also bill the author for every word that lexed oddly after it.
 */
function errorNodeDiagnostics(tree: Tree, source: string, lexical: readonly Diagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<number>();
  let coveredTo = -1;

  const cursor = tree.cursor();
  do {
    if (!cursor.type.isError) continue;
    const from = cursor.from;
    const to = cursor.to;
    if (seen.has(from)) continue;
    if (from < coveredTo) continue;
    if (lexical.some((d) => from >= d.span.from && from < d.span.to)) continue;

    seen.add(from);
    if (from === to) {
      out.push(diagnostic('SGL1001', span(from, to), { token: expectedToken(cursor.node) }));
    } else {
      coveredTo = to;
      out.push(diagnostic('SGL1002', span(from, to), { text: excerpt(source.slice(from, to)) }));
    }
  } while (cursor.next());

  return out;
}

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
};

/**
 * Lezer does not report what it wanted, so name the token from the shape of the
 * tree: the innermost unclosed delimiter if there is one, otherwise whatever the
 * enclosing rule is still missing.
 */
function expectedToken(node: SyntaxNode): string {
  for (let n = node.parent; n !== null; n = n.parent) {
    const closer = CLOSERS[n.name];
    if (closer !== undefined && !hasChild(n, closer)) return closer;
  }
  const parent = node.parent;
  if (parent === null) return 'an entry';
  switch (parent.name) {
    case 'ConfigEntry':
    case 'Property':
    case 'NodeDecl':
      return hasChild(parent, ':') ? 'a value' : ':';
    case 'EdgeStmt':
      return 'an endpoint';
    case 'Endpoint':
    case 'Path':
    case 'PathStep':
      return 'a path';
    case 'Document':
    case 'Entry':
    case 'Block':
      return 'an entry';
    default:
      return 'a value';
  }
}
