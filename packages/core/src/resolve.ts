/**
 * The resolver (DD-02): fold the AST into the canonical `DocumentModel` — merge
 * redeclarations, expand shorthands, normalise dotted `@`-keys, collect and
 * validate classes, split edge chains into `EdgeModel`s with unresolved
 * endpoints. `toJson`/`fromJson` are the lossless canonical-JSON round trip
 * (DD-02 §6).
 *
 * Two deviations from the design documents, both because the strict-JSON corpus
 * fixture (`json-form.sgl.json`) and the worked example (02 §9) round-trip
 * `"@edges"` arrays that the grammar itself never produces — that construct is
 * a resolver-level convenience, not a parser one, so this file interprets it by
 * re-parsing each `from`/`to` string through the ordinary `Path` grammar (a
 * tiny synthetic edge statement) rather than hand-rolling a second path parser
 * that could drift from the real one. And DD-02 §6 rule 5 says a path segment
 * that needs quoting is "escaped as `\.`"; the `Identifier` token cannot
 * contain a backslash (see `sgl.grammar`), so a backslash-escaped bareword
 * would not survive `fromJson(toJson(m))`. `printPathStep` below prints such a
 * segment as a quoted JSON string instead, which the grammar already accepts
 * in path position (`PathSegment { Identifier | String }`) and which does
 * round-trip.
 */

import type {
  ArrayLit,
  Block,
  ConfigEntry,
  Document,
  EdgeStmt,
  Entry,
  NodeDecl,
  ObjectLit,
  PathExpr,
  PathStep,
  Property,
  StringLit,
  Value,
} from './ast.js';
import { configKeyOrder, validateConfigKey } from './config-registry.js';
import { diagnostic, type Diagnostic } from './diagnostics.js';
import type {
  ClassModel,
  ConfigBag,
  ConfigKeySpec,
  ContainerModel,
  DocumentModel,
  EdgeModel,
  SpanTable,
} from './model.js';
import { parse } from './parse.js';
import type { SourceSpan } from './span.js';

export interface ResolveResult {
  readonly model: DocumentModel;
  readonly diagnostics: readonly Diagnostic[];
}

type Scope = ConfigKeySpec['scope'][number];

/** A config bag under construction, plus the span each top-level key was last
 *  touched at — used only to anchor the registry diagnostics (DD-02 §7). */
interface Bag {
  readonly config: Record<string, unknown>;
  readonly configSpans: Map<string, SourceSpan>;
}

/** A container under construction. `children` is a `Map` so that a
 *  redeclaration (DD-02 §3.2) merges into the existing entry in place instead
 *  of moving it — `Map` keeps a key's *first* insertion position. */
interface Acc extends Bag {
  readonly children: Map<string, ChildAcc>;
  readonly edges: RawEdge[];
}

interface ChildAcc extends Acc {
  readonly declSpan: SourceSpan;
}

interface RawEdge {
  readonly from: PathExpr;
  readonly to: PathExpr;
  readonly fromPort?: string;
  readonly toPort?: string;
  readonly directed: EdgeModel['directed'];
  readonly ordinal: number;
  readonly config: ConfigBag;
  /** For the span table only; never serialised. */
  readonly stmtSpan: SourceSpan;
}

interface NameRef {
  readonly name: string;
  readonly span: SourceSpan;
}

// ---------------------------------------------------------------------------
// Dotted-key insertion (DD-02 §3.4)
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Insert `value` at `keyParts` inside `bag`, creating intermediate objects as
 * needed. If an intermediate segment already holds a scalar or array, it is
 * replaced by an object and `SGL2006` is emitted — the dotted-key merge rule
 * (DD-02 §3.4).
 */
function insertConfigValue(
  bag: Bag,
  keyParts: readonly string[],
  value: unknown,
  span: SourceSpan,
  diags: Diagnostic[],
): void {
  bag.configSpans.set(keyParts[0] as string, span);
  let cur: Record<string, unknown> = bag.config;
  const seen: string[] = [];
  for (let i = 0; i < keyParts.length - 1; i += 1) {
    const seg = keyParts[i] as string;
    seen.push(seg);
    const existing = cur[seg];
    if (existing === undefined) {
      cur[seg] = {};
    } else if (!isPlainObject(existing)) {
      diags.push(
        diagnostic('SGL2006', span, {
          key: seen.join('.'),
          sub: keyParts[i + 1] as string,
          scalar: JSON.stringify(existing),
        }),
      );
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[keyParts[keyParts.length - 1] as string] = value;
}

// ---------------------------------------------------------------------------
// Value coercion (DD-02 §3.5)
// ---------------------------------------------------------------------------

/** `Word` becomes its string; `Variable` is not substituted in this version
 *  (Stage B task 5) — its literal `$name` text is kept and `SGL2009` notes why. */
function coerceValue(value: Value, diags: Diagnostic[]): unknown {
  switch (value.kind) {
    case 'String':
      return value.value;
    case 'Number':
      return value.value;
    case 'Bool':
      return value.value;
    case 'Null':
      return null;
    case 'Word':
      return value.value;
    case 'Variable':
      diags.push(diagnostic('SGL2009', value.span, { name: value.name }));
      return `$${value.name}`;
    case 'Array':
      return value.items.map((item) => coerceValue(item, diags));
    case 'Object':
      return coerceObject(value, diags);
  }
}

/** A generic object value (`@layout: {...}`, `@style: {...}`, …): `@`-prefixed
 *  property keys drop the `@` and may be dotted; unprefixed keys are kept as
 *  written (DD-02 §3.5). Not used for class bodies — see `buildClassBody`. */
function coerceObject(obj: ObjectLit, diags: Diagnostic[]): Record<string, unknown> {
  const bag: Bag = { config: {}, configSpans: new Map() };
  for (const prop of obj.props) {
    const keyParts = prop.isConfig ? prop.key.split('.') : [prop.key];
    insertConfigValue(bag, keyParts, coerceValue(prop.value, diags), prop.keySpan, diags);
  }
  return bag.config;
}

/** `@type` is always an array of class names in the model (DD-02 §6 rule 4),
 *  whether written as one bareword, one string, or a list of either. */
function extractNameRefs(value: Value): NameRef[] {
  if (value.kind === 'Word' || value.kind === 'String') return [{ name: value.value, span: value.span }];
  if (value.kind === 'Array') return value.items.flatMap(extractNameRefs);
  return [];
}

/** Drop a name that names no declared class, emitting `SGL2002` — the
 *  reference is dropped, the node (or class) is kept (DD-02 §4). */
function filterKnownRefs(refs: readonly NameRef[], known: ReadonlySet<string>, diags: Diagnostic[]): NameRef[] {
  const out: NameRef[] = [];
  for (const ref of refs) {
    if (known.has(ref.name)) out.push(ref);
    else diags.push(diagnostic('SGL2002', ref.span, { name: ref.name }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config entries, edge blocks (DD-02 §3, §5)
// ---------------------------------------------------------------------------

/** `@type` is validated against the declared classes as it is inserted (the
 *  only config key resolve() cross-checks); everything else is generic. */
function applyConfigEntry(entry: ConfigEntry, bag: Bag, classNames: ReadonlySet<string>, diags: Diagnostic[]): void {
  if (entry.key.length === 1 && entry.key[0] === 'type') {
    const refs = filterKnownRefs(extractNameRefs(entry.value), classNames, diags);
    insertConfigValue(bag, entry.key, refs.map((r) => r.name), entry.keySpan, diags);
    return;
  }
  insertConfigValue(bag, entry.key, coerceValue(entry.value, diags), entry.keySpan, diags);
}

/** A `Block` on an edge holds only `ConfigEntry`s; a `NodeDecl` or nested
 *  `EdgeStmt` is `SGL2008` and ignored (DD-02 §5). */
function buildEdgeConfigBag(value: StringLit | Block | undefined, classNames: ReadonlySet<string>, diags: Diagnostic[]): Bag {
  const bag: Bag = { config: {}, configSpans: new Map() };
  if (value === undefined) return bag;
  if (value.kind === 'String') {
    insertConfigValue(bag, ['label'], value.value, value.span, diags);
    return bag;
  }
  for (const entry of value.entries) {
    if (entry.kind !== 'ConfigEntry') {
      diags.push(
        diagnostic('SGL2008', entry.span, { thing: entry.kind === 'NodeDecl' ? entry.key : 'a nested edge' }),
      );
      continue;
    }
    applyConfigEntry(entry, bag, classNames, diags);
  }
  return bag;
}

// ---------------------------------------------------------------------------
// `"@edges"` arrays — the canonical-JSON form of an edge (DD-02 §6)
// ---------------------------------------------------------------------------

/** Re-parse a `from`/`to` string as a tiny synthetic edge statement so path
 *  syntax — quoting, `../`, `/`, wildcards — is interpreted by the one real
 *  `Path` grammar rather than a second, hand-rolled parser. See file header. */
function parsePathText(text: string, fallback: SourceSpan): PathExpr {
  const { ast } = parse(`${text} -> __sgl_edges_placeholder__`);
  for (const entry of ast.entries) {
    if (entry.kind === 'EdgeStmt' && entry.endpoints.length > 0) {
      return (entry.endpoints[0] as { path: PathExpr }).path;
    }
  }
  return { kind: 'PathExpr', root: false, parents: 0, segments: [], span: fallback };
}

const DIRECTIONS: ReadonlySet<string> = new Set(['forward', 'both', 'none']);

function applyEdgesArray(entry: ConfigEntry, acc: Acc, classNames: ReadonlySet<string>, diags: Diagnostic[]): void {
  if (entry.value.kind !== 'Array') return;
  for (const item of (entry.value as ArrayLit).items) {
    if (item.kind !== 'Object') continue;
    let from: PathExpr | undefined;
    let to: PathExpr | undefined;
    let fromPort: string | undefined;
    let toPort: string | undefined;
    let directed: EdgeModel['directed'] = 'forward';
    let ordinal = 0;
    const bag: Bag = { config: {}, configSpans: new Map() };

    for (const prop of (item as ObjectLit).props) {
      if (prop.isConfig) {
        applyConfigEntry(
          { kind: 'ConfigEntry', key: prop.key.split('.'), value: prop.value, keySpan: prop.keySpan, span: prop.span },
          bag,
          classNames,
          diags,
        );
        continue;
      }
      switch (prop.key) {
        case 'from':
          if (prop.value.kind === 'String') from = parsePathText(prop.value.value, prop.value.span);
          break;
        case 'to':
          if (prop.value.kind === 'String') to = parsePathText(prop.value.value, prop.value.span);
          break;
        case 'fromPort':
          if (prop.value.kind === 'String') fromPort = prop.value.value;
          break;
        case 'toPort':
          if (prop.value.kind === 'String') toPort = prop.value.value;
          break;
        case 'directed':
          if (prop.value.kind === 'String' && DIRECTIONS.has(prop.value.value)) {
            directed = prop.value.value as EdgeModel['directed'];
          }
          break;
        case 'ordinal':
          if (prop.value.kind === 'Number') ordinal = prop.value.value;
          break;
        default:
          break;
      }
    }
    if (from === undefined || to === undefined) continue;

    acc.edges.push({
      from,
      to,
      directed,
      ordinal,
      config: finalizeConfig(bag, 'edge', diags),
      stmtSpan: entry.span,
      ...(fromPort !== undefined ? { fromPort } : {}),
      ...(toPort !== undefined ? { toPort } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Nodes and edges (DD-02 §3.2, §3.3, §5)
// ---------------------------------------------------------------------------

function applyNodeDecl(decl: NodeDecl, acc: Acc, classNames: ReadonlySet<string>, diags: Diagnostic[]): void {
  let child = acc.children.get(decl.key);
  if (child === undefined) {
    child = { config: {}, configSpans: new Map(), children: new Map(), edges: [], declSpan: decl.span };
    acc.children.set(decl.key, child);
  } else {
    diags.push(diagnostic('SGL2005', decl.span, { key: decl.key }));
  }

  const value = decl.value;
  if (value === undefined) return;
  if (value.kind === 'String') {
    insertConfigValue(child, ['label'], value.value, value.span, diags);
  } else if (value.kind === 'Word') {
    const refs = filterKnownRefs([{ name: value.value, span: value.span }], classNames, diags);
    insertConfigValue(child, ['type'], refs.map((r) => r.name), value.span, diags);
  } else {
    buildEntries(value.entries, child, classNames, diags);
  }
}

const OP_DIRECTED: Readonly<Record<string, EdgeModel['directed']>> = {
  '->': 'forward',
  '<-': 'forward',
  '<->': 'both',
  '--': 'none',
};

function applyEdgeStmt(stmt: EdgeStmt, acc: Acc, classNames: ReadonlySet<string>, diags: Diagnostic[]): void {
  const config = finalizeConfig(buildEdgeConfigBag(stmt.value, classNames, diags), 'edge', diags);
  for (let i = 0; i < stmt.ops.length; i += 1) {
    const op = stmt.ops[i] as string;
    const a = stmt.endpoints[i] as EdgeStmt['endpoints'][number];
    const b = stmt.endpoints[i + 1] as EdgeStmt['endpoints'][number];
    const swapped = op === '<-';
    const from = swapped ? b : a;
    const to = swapped ? a : b;
    acc.edges.push({
      from: from.path,
      to: to.path,
      directed: OP_DIRECTED[op] ?? 'forward',
      ordinal: i,
      config,
      stmtSpan: stmt.span,
      ...(from.port !== undefined ? { fromPort: from.port } : {}),
      ...(to.port !== undefined ? { toPort: to.port } : {}),
    });
  }
}

function buildEntries(entries: readonly Entry[], acc: Acc, classNames: ReadonlySet<string>, diags: Diagnostic[]): void {
  for (const entry of entries) {
    switch (entry.kind) {
      case 'ConfigEntry':
        if (entry.key.length === 1 && entry.key[0] === 'edges') applyEdgesArray(entry, acc, classNames, diags);
        else applyConfigEntry(entry, acc, classNames, diags);
        break;
      case 'NodeDecl':
        applyNodeDecl(entry, acc, classNames, diags);
        break;
      case 'EdgeStmt':
        applyEdgeStmt(entry, acc, classNames, diags);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Classes (DD-02 §4)
// ---------------------------------------------------------------------------

/** A class body holds configuration only; a non-`@` key is `SGL2007` and
 *  dropped (DD-02 §4) — unlike a generic object value, where unprefixed keys
 *  are ordinary data (see `coerceObject`). `@extends` is pulled out rather
 *  than folded into `config`, matching `ClassModel`'s separate field. */
function buildClassBody(props: readonly Property[], diags: Diagnostic[]): { bag: Bag; extendRefs: NameRef[] } {
  const bag: Bag = { config: {}, configSpans: new Map() };
  const extendRefs: NameRef[] = [];
  for (const prop of props) {
    if (!prop.isConfig) {
      diags.push(diagnostic('SGL2007', prop.span, { key: prop.key }));
      continue;
    }
    const keyParts = prop.key.split('.');
    if (keyParts.length === 1 && keyParts[0] === 'extends') {
      extendRefs.push(...extractNameRefs(prop.value));
      continue;
    }
    insertConfigValue(bag, keyParts, coerceValue(prop.value, diags), prop.keySpan, diags);
  }
  return { bag, extendRefs };
}

function buildClasses(
  classesEntries: readonly ConfigEntry[],
  diags: Diagnostic[],
): { classes: Record<string, ClassModel>; classNames: ReadonlySet<string>; classSpans: readonly (readonly [string, SourceSpan])[] } {
  const raw = new Map<string, { props: Property[]; span: SourceSpan }>();
  for (const entry of classesEntries) {
    if (entry.value.kind !== 'Object') {
      diags.push(diagnostic('SGL2011', entry.value.span, { key: 'classes', type: 'object' }));
      continue;
    }
    for (const prop of entry.value.props) {
      const bodyProps = prop.value.kind === 'Object' ? prop.value.props : [];
      const existing = raw.get(prop.key);
      if (existing) existing.props.push(...bodyProps);
      else raw.set(prop.key, { props: [...bodyProps], span: prop.span });
    }
  }

  const classNames: ReadonlySet<string> = new Set(raw.keys());
  const configs = new Map<string, ConfigBag>();
  const rawExtends = new Map<string, NameRef[]>();
  const classSpans: (readonly [string, SourceSpan])[] = [];

  for (const [name, { props, span }] of raw) {
    classSpans.push([`c:${name}`, span] as const);
    const { bag, extendRefs } = buildClassBody(props, diags);
    configs.set(name, finalizeConfig(bag, 'class', diags));
    rawExtends.set(name, filterKnownRefs(extendRefs, classNames, diags));
  }

  // Cycle detection over `@extends`, breaking each cycle at its back-edge
  // (DD-02 §4): a class already on the current DFS path is a cycle.
  const color = new Map<string, 'gray' | 'black'>();
  const visit = (name: string, stack: string[]): void => {
    color.set(name, 'gray');
    const list = rawExtends.get(name) as NameRef[];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const target = list[i] as NameRef;
      if (color.get(target.name) === 'gray') {
        const cycleStart = stack.indexOf(target.name);
        const cycle = [...stack.slice(cycleStart), target.name].join(' -> ');
        diags.push(diagnostic('SGL2004', target.span, { a: name, cycle }));
        list.splice(i, 1);
        continue;
      }
      if (!color.has(target.name)) {
        stack.push(target.name);
        visit(target.name, stack);
        stack.pop();
      }
    }
    color.set(name, 'black');
  };
  for (const name of classNames) if (!color.has(name)) visit(name, [name]);

  const classes: Record<string, ClassModel> = {};
  for (const name of classNames) {
    classes[name] = {
      name,
      extends: (rawExtends.get(name) as NameRef[]).map((r) => r.name),
      config: configs.get(name) as ConfigBag,
    };
  }
  return { classes, classNames, classSpans };
}

// ---------------------------------------------------------------------------
// Registry-driven validation and sugar (DD-02 §7)
// ---------------------------------------------------------------------------

/** `@direction` is sugar for `@layout.direction` (language spec §4); an
 *  explicit `@layout.direction` already present wins. */
function foldDirectionSugar(bag: Record<string, unknown>): void {
  if (typeof bag.direction !== 'string') return;
  const dir = bag.direction;
  delete bag.direction;
  const layout = isPlainObject(bag.layout) ? { ...bag.layout } : {};
  if (!('direction' in layout)) layout.direction = dir;
  bag.layout = layout;
}

/** Unknown key → `SGL2010`, kept. Wrong scope → `SGL2012`, dropped. Wrong
 *  type → `SGL2011`, dropped (DD-02 §7). */
function finalizeConfig(bag: Bag, scope: Scope, diags: Diagnostic[]): ConfigBag {
  if (scope === 'node') foldDirectionSugar(bag.config);
  for (const key of Object.keys(bag.config)) {
    const span = bag.configSpans.get(key) as SourceSpan;
    const result = validateConfigKey(key, bag.config[key], scope);
    if (result.outcome === 'bad-scope') {
      diags.push(diagnostic('SGL2012', span, { key, scope }));
      delete bag.config[key];
    } else if (result.outcome === 'bad-type') {
      diags.push(diagnostic('SGL2011', span, { key, type: result.expected }));
      delete bag.config[key];
    } else if (result.outcome === 'unknown') {
      diags.push(diagnostic('SGL2010', span, { key }));
    }
  }
  return bag.config as ConfigBag;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const pathKey = (path: readonly string[]): string => path.map((seg) => seg.replace(/\./g, '\\.')).join('.');

function finalizeContainer(
  key: string,
  path: readonly string[],
  acc: Acc,
  scope: 'root' | 'node',
  declSpan: SourceSpan,
  spans: Map<string, SourceSpan>,
  diags: Diagnostic[],
): ContainerModel {
  spans.set(`n:${pathKey(path)}`, declSpan);
  const config = finalizeConfig(acc, scope, diags);

  const children: ContainerModel[] = [];
  for (const [childKey, childAcc] of acc.children) {
    children.push(finalizeContainer(childKey, [...path, childKey], childAcc, 'node', childAcc.declSpan, spans, diags));
  }

  const edges: EdgeModel[] = acc.edges.map((raw, i) => {
    spans.set(`e:${pathKey(path)}#${i}`, raw.stmtSpan);
    return {
      from: raw.from,
      to: raw.to,
      directed: raw.directed,
      config: raw.config,
      ordinal: raw.ordinal,
      ...(raw.fromPort !== undefined ? { fromPort: raw.fromPort } : {}),
      ...(raw.toPort !== undefined ? { toPort: raw.toPort } : {}),
    };
  });

  return { key, path, config, children, edges };
}

/**
 * Fold the AST into the canonical document model: merge redeclarations, expand
 * shorthands, normalise dotted `@`-keys, linearise classes.
 *
 * Design: DD-02.
 */
export function resolve(ast: Document): ResolveResult {
  const diags: Diagnostic[] = [];

  // `@sgl` is discarded — `DocumentModel.sgl` is the fixed literal `'1.0'`,
  // never round-tripped through generic config folding. `@classes` is routed
  // to class construction and never appears in `root.config` (DD-02 §4).
  const classesEntries: ConfigEntry[] = [];
  const rootEntries: Entry[] = [];
  for (const entry of ast.entries) {
    if (entry.kind === 'ConfigEntry' && entry.key.length === 1 && entry.key[0] === 'sgl') continue;
    if (entry.kind === 'ConfigEntry' && entry.key.length === 1 && entry.key[0] === 'classes') {
      classesEntries.push(entry);
      continue;
    }
    rootEntries.push(entry);
  }

  const { classes, classNames, classSpans } = buildClasses(classesEntries, diags);

  const rootAcc: Acc = { config: {}, configSpans: new Map(), children: new Map(), edges: [] };
  buildEntries(rootEntries, rootAcc, classNames, diags);

  const spans = new Map<string, SourceSpan>(classSpans);
  const root = finalizeContainer('', [], rootAcc, 'root', ast.span, spans, diags);

  return { model: { sgl: '1.0', root, classes, spans: spans as SpanTable }, diagnostics: diags };
}

// ---------------------------------------------------------------------------
// Canonical JSON (DD-02 §6)
// ---------------------------------------------------------------------------

const BAREWORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function printPathStep(step: PathStep): string {
  if (step.kind === 'Wildcard') {
    return step.depth === 'descendants' ? '**' : `${step.prefix}*${step.suffix}`;
  }
  return BAREWORD.test(step.value) ? step.value : JSON.stringify(step.value);
}

function printPath(path: PathExpr): string {
  const prefix = (path.root ? '/' : '') + '../'.repeat(path.parents);
  return prefix + path.segments.map(printPathStep).join('.');
}

/** `toJson`'s per-object key order: registry order first (DD-02 §7), then any
 *  key the registry does not know about, in the order it first appeared. */
function orderedKeys(config: ConfigBag): string[] {
  const keys = Object.keys(config);
  const original = new Map(keys.map((k, i) => [k, i] as const));
  return [...keys].sort((a, b) => {
    const oa = configKeyOrder(a);
    const ob = configKeyOrder(b);
    return oa !== ob ? oa - ob : (original.get(a) as number) - (original.get(b) as number);
  });
}

function writeConfig(target: Record<string, unknown>, config: ConfigBag): void {
  for (const key of orderedKeys(config)) target[`@${key}`] = config[key];
}

function writeClasses(classes: Readonly<Record<string, ClassModel>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, cls] of Object.entries(classes)) {
    const body: Record<string, unknown> = {};
    if (cls.extends.length > 0) body['@extends'] = [...cls.extends];
    writeConfig(body, cls.config);
    out[name] = body;
  }
  return out;
}

/**
 * `ordinal` is not in DD-02's worked example, but it must be printed: it is
 * "index within the declaring chain, for stable IDs" (model.ts), and the
 * canonical `"@edges"` array has no other way to represent a chain's shape,
 * so omitting it would silently renumber every edge after the first on
 * `fromJson(toJson(m))` — breaking the round-trip invariant DD-09 tests for.
 * A hand-written `.sgl.json` may still omit it; it then defaults to `0`.
 */
function writeEdge(edge: EdgeModel): Record<string, unknown> {
  const out: Record<string, unknown> = { from: printPath(edge.from), to: printPath(edge.to) };
  if (edge.fromPort !== undefined) out.fromPort = edge.fromPort;
  if (edge.toPort !== undefined) out.toPort = edge.toPort;
  out.directed = edge.directed;
  out.ordinal = edge.ordinal;
  writeConfig(out, edge.config);
  return out;
}

function writeContainer(container: ContainerModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  writeConfig(out, container.config);
  for (const child of container.children) out[child.key] = writeContainer(child);
  if (container.edges.length > 0) out['@edges'] = container.edges.map(writeEdge);
  return out;
}

/** Serialise the canonical `.sgl.json` form. Lossless but for comments and formatting. */
export function toJson(model: DocumentModel): string {
  const out: Record<string, unknown> = { '@sgl': model.sgl };
  writeConfig(out, model.root.config);
  if (Object.keys(model.classes).length > 0) out['@classes'] = writeClasses(model.classes);
  for (const child of model.root.children) out[child.key] = writeContainer(child);
  if (model.root.edges.length > 0) out['@edges'] = model.root.edges.map(writeEdge);
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** `fromJson(text) === resolve(parse(text))` — the grammar accepts JSON as-is. */
export function fromJson(text: string): ResolveResult {
  const { ast, diagnostics: parseDiags } = parse(text);
  const { model, diagnostics: resolveDiags } = resolve(ast);
  return { model, diagnostics: [...parseDiags, ...resolveDiags] };
}
