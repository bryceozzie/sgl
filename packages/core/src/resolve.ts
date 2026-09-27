/**
 * The resolver (DD-02): fold the AST into the canonical `DocumentModel` — merge
 * redeclarations, expand shorthands, normalise dotted `@`-keys, collect and
 * validate classes, split edge chains into `EdgeModel`s with unresolved
 * endpoints, substitute `@vars` (A8, DD-02 §3.5). `toJson`/`fromJson`, the
 * lossless canonical-JSON round trip (DD-02 §6), are `json.ts`, exported as
 * `@sgl/core/json`.
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
import { breakExtendsCycles } from './class-graph.js';
import { SIZE_KEYS, validateConfigKey } from './config-registry.js';
import { diagnostic, type Diagnostic } from './diagnostics.js';
import { nodeIdFromPath } from './ids.js';
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
import { NO_SPAN, type SourceSpan } from './span.js';

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
  readonly fromText?: string;
  readonly toText?: string;
  readonly directed: EdgeModel['directed'];
  readonly ordinal: number;
  /** Still as written (variable references unsubstituted): finalised with the
   *  declaring container, once its `@vars` are known. Shared by every edge of
   *  one chain, and finalised once for all of them. */
  readonly bag: Bag;
  /** For the span table only; never serialised. */
  readonly stmtSpan: SourceSpan;
}

interface NameRef {
  readonly name: string;
  readonly span: SourceSpan;
}

// ---------------------------------------------------------------------------
// Variable references (language spec §5, DD-02 §3.5)
// ---------------------------------------------------------------------------

/** The grammar's `Identifier` token (`sgl.grammar`): what may follow `$`. */
export const IDENT = '[A-Za-z_](?:[A-Za-z0-9_]|-[A-Za-z0-9_])*';
export const IDENTIFIER = new RegExp(`^${IDENT}$`);
/**
 * `whole`: a string that is exactly `$name` — the canonical-JSON spelling of a
 * `Variable` (language spec §9: `"stroke": "$hot"`); `interp`: `${name}` in a
 * string. `@sgl/core/imports` swaps in patterns that also take `ns.name` for
 * the length of one resolve of a document with import namespaces (A9, DD-02
 * I16): anywhere else `"$user.name"` stays the literal text it always was.
 */
export const REF_PATTERNS = { whole: new RegExp(`^\\$(${IDENT})$`), interp: new RegExp(`\\$\\{(${IDENT})\\}`, 'g') };

type RefPart = string | { readonly name: string };

/**
 * A value as written that refers to variables: `$name` (`whole`, one part) or
 * a string holding `${name}` placeholders. Config bags carry these until the
 * element they belong to is finalised, because only then is its scope known:
 * a container's `@vars` may come after a use, or in a later redeclaration.
 * Merging (redeclaration, dotted keys) therefore works on the written form.
 * `toJSON` is the text as written — what `SGL2006` quotes and what the
 * `authored` copy holds.
 */
class Ref {
  readonly text: string;
  readonly parts: readonly RefPart[];
  readonly whole: boolean;
  readonly span: SourceSpan;
  constructor(text: string, parts: readonly RefPart[], whole: boolean, span: SourceSpan) {
    this.text = text;
    this.parts = parts;
    this.whole = whole;
    this.span = span;
  }
  toJSON(): string {
    return this.text;
  }
}

/** A string value: a `Ref` if it is exactly `$name` or holds a `${name}`,
 *  otherwise itself. A `$` anywhere else is literal text. */
function stringValue(text: string, span: SourceSpan): string | Ref {
  const whole = REF_PATTERNS.whole.exec(text);
  if (whole !== null) return new Ref(text, [{ name: whole[1] as string }], true, span);
  if (!text.includes('${')) return text;
  const parts: RefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_PATTERNS.interp)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ name: m[1] as string });
    last = m.index + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return new Ref(text, parts, false, span);
}

// ---------------------------------------------------------------------------
// Dotted-key insertion (DD-02 §3.4)
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Ref);

/** Recurse only while both sides are plain objects; a scalar or array leaf on
 *  either side is "later wins" (DD-02 §3.2), not merged. The counterpart to
 *  the dotted-path walk in `insertConfigValue` below: that walk merges
 *  `@style.fill` then `@style.stroke` into one object one segment at a time,
 *  this merges `@style: { fill }` then `@style: { stroke }` the same way in
 *  one step, so the two spellings — dotted or literal-object — really are
 *  "indistinguishable" the way DD-02 §2 says they are. */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const prior = out[key];
    out[key] = isPlainObject(prior) && isPlainObject(value) ? mergeInto(prior, value) : value;
  }
  return out;
}

/**
 * Insert `value` at `keyParts` inside `bag`, creating intermediate objects as
 * needed. If an intermediate segment already holds a scalar or array, it is
 * replaced by an object and `SGL2006` is emitted — the dotted-key merge rule
 * (DD-02 §3.4). The final segment merges into whatever plain object was
 * already there (DD-02 §3.2); a scalar or array simply replaces it, and
 * replacing one is never itself an `SGL2006` — that code is specifically
 * about a dotted path displacing a scalar, not a whole-value redeclaration.
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
  const last = keyParts[keyParts.length - 1] as string;
  const prior = cur[last];
  cur[last] = isPlainObject(prior) && isPlainObject(value) ? mergeInto(prior, value) : value;
}

// ---------------------------------------------------------------------------
// Value coercion (DD-02 §3.5)
// ---------------------------------------------------------------------------

/** `Word` becomes its string. A `Variable`, or a string that refers to one,
 *  becomes a `Ref`, substituted when its element is finalised. */
function coerceValue(value: Value, diags: Diagnostic[]): unknown {
  switch (value.kind) {
    case 'String':
      return stringValue(value.value, value.span);
    case 'Number':
      return value.value;
    case 'Bool':
      return value.value;
    case 'Null':
      return null;
    case 'Word':
      return value.value;
    case 'Variable':
      return new Ref(`$${value.name}`, [{ name: value.name }], true, value.span);
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
 *  whether written as one bareword, one string, or a list of either. A
 *  variable reference stays a `Ref` until its element's scope is known
 *  (`resolveClassRefs`). */
function extractNameRefs(value: Value): (NameRef | Ref)[] {
  if (value.kind === 'Word') return [{ name: value.value, span: value.span }];
  if (value.kind === 'String') {
    const v = stringValue(value.value, value.span);
    return [typeof v === 'string' ? { name: v, span: value.span } : v];
  }
  if (value.kind === 'Variable') return [new Ref(`$${value.name}`, [{ name: value.name }], true, value.span)];
  if (value.kind === 'Array') return value.items.flatMap(extractNameRefs);
  return [];
}

/** Drop a name that names no declared class, emitting `SGL2002` — the
 *  reference is dropped, the node (or class) is kept (DD-02 §4). A `Ref` is
 *  kept, and checked once it is substituted. */
function filterKnownRefs<T extends NameRef | Ref>(refs: readonly T[], known: ReadonlySet<string>, diags: Diagnostic[]): T[] {
  const out: T[] = [];
  for (const ref of refs) {
    if (ref instanceof Ref || known.has(ref.name)) out.push(ref);
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
    insertConfigValue(bag, entry.key, refs.map((r) => (r instanceof Ref ? r : r.name)), entry.keySpan, diags);
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
    insertConfigValue(bag, ['label'], stringValue(value.value, value.span), value.span, diags);
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

/** The path returned by re-parsing `text` (see `parsePathText`) carries spans
 *  measured against that throwaway synthetic source, not the real document —
 *  offsets that would otherwise anchor a later `SGL2001`/`SGL3003`/`SGL3004`
 *  (Stage C) or an editor underline (Stage I) at arbitrary, unrelated text.
 *  Collapse every span in the tree to the real `from`/`to` string literal's
 *  own span instead: less precise than a per-character remap, but always
 *  inside the actual source, which is what downstream consumers need. */
function remapPathSpans(path: PathExpr, span: SourceSpan): PathExpr {
  return { ...path, span, segments: path.segments.map((step) => ({ ...step, span }) as PathStep) };
}

/** Re-parse a `from`/`to` string as a tiny synthetic edge statement so path
 *  syntax — quoting, `../`, `/`, wildcards — is interpreted by the one real
 *  `Path` grammar rather than a second, hand-rolled parser. See file header. */
function parsePathText(text: string, realSpan: SourceSpan): { path: PathExpr; invalid?: string } {
  const { ast, diagnostics } = parse(`${text} -> __sgl_edges_placeholder__`);
  const [entry] = ast.entries;
  if (diagnostics.length === 0 && ast.entries.length === 1 && entry?.kind === 'EdgeStmt' && entry.endpoints.length === 2) {
    return { path: remapPathSpans((entry.endpoints[0] as { path: PathExpr }).path, realSpan) };
  }
  // Not a path (`"$a"`, `"a b"`): kept as written, so compile() can name it
  // in its SGL2001 and toJson() can print it back unchanged.
  return { path: { kind: 'PathExpr', root: false, parents: 0, segments: [], span: realSpan }, invalid: text };
}

const DIRECTIONS: ReadonlySet<string> = new Set(['forward', 'both', 'none']);

function applyEdgesArray(entry: ConfigEntry, acc: Acc, classNames: ReadonlySet<string>, diags: Diagnostic[]): void {
  if (entry.value.kind !== 'Array') return;
  for (const item of (entry.value as ArrayLit).items) {
    if (item.kind !== 'Object') continue;
    let from: PathExpr | undefined;
    let to: PathExpr | undefined;
    let fromText: string | undefined;
    let toText: string | undefined;
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
          if (prop.value.kind === 'String') ({ path: from, invalid: fromText } = parsePathText(prop.value.value, prop.value.span));
          break;
        case 'to':
          if (prop.value.kind === 'String') ({ path: to, invalid: toText } = parsePathText(prop.value.value, prop.value.span));
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
      bag,
      stmtSpan: entry.span,
      ...(fromPort !== undefined ? { fromPort } : {}),
      ...(fromText !== undefined ? { fromText } : {}),
      ...(toText !== undefined ? { toText } : {}),
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
    insertConfigValue(child, ['label'], stringValue(value.value, value.span), value.span, diags);
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
  const bag = buildEdgeConfigBag(stmt.value, classNames, diags);
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
      bag,
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
// Variables: scopes and substitution (language spec §5, DD-02 §3.5)
// ---------------------------------------------------------------------------

/**
 * The expansion budget (DD-09 §1.1, "exponential variable expansion"), in
 * units: one per value substituted (a scalar, an array, an object) plus one
 * per character of a string, counted as values are copied in by `$name` and
 * as characters are produced by `${name}`. 2 Mi units: the most a document
 * inside DD-09's 2 MB cap could spell out literally (every value and every
 * character takes at least one byte of source), so no legitimate document
 * needs more, and `v1: [$v0, $v0]`, `v2: [$v1, $v1]`, … stops within it
 * instead of doubling for as long as the chain is.
 */
export const MAX_VARIABLE_EXPANSION = 2 * 1024 * 1024;

/** Units spent, and how many substitutions were refused (only a
 *  document's first is reported). One per root resolve: an import closure shares it (A9, DD-02
 *  I21). */
export interface Budget {
  used: number;
  refused: number;
}

/** One declared variable. Its value is computed the first time it is used
 *  (`materialise`) and then shared by every use; `refs` says, for each name
 *  its value mentions, which variable that is — resolved once, at the
 *  declaration, in the declaring scope — or `DROP` for a name already
 *  reported there (unknown, or not declared before it). */
export interface VarEntry {
  readonly raw: unknown;
  readonly refs: Map<string, VarEntry | typeof DROP>;
  readonly budget: Budget;
  /** 0 not yet computed · 1 computing (its dependencies first) · 2 done. */
  state: 0 | 1 | 2;
  value: unknown;
  /** An imported variable's (A9): where the problems of computing it go, to
   *  be counted in its import's `SGL2021` (DD-02 I17). */
  readonly sink?: Diagnostic[];
}

/** A container's own `@vars` and a pointer to its parent's: a lookup walks
 *  the chain, so a scope costs its own entries, not a copy of every
 *  enclosing one. */
export interface VarScope {
  readonly parent: VarScope | undefined;
  readonly entries: ReadonlyMap<string, VarEntry>;
  readonly budget: Budget;
}

const FAILED = Symbol('failed');
/** A substitution that dropped its value: the key is treated as absent. */
export const DROP = Symbol('drop');

type Lookup = (name: string, ref: Ref) => unknown;

const newScope = (): VarScope => ({ parent: undefined, entries: new Map(), budget: { used: 0, refused: 0 } });

function findVar(scope: VarScope | undefined, name: string): VarEntry | undefined {
  for (let s = scope; s !== undefined; s = s.parent) {
    const e = s.entries.get(name);
    if (e !== undefined) return e;
  }
  return undefined;
}

/** Plain JSON copied, so no two elements of the model share an object
 *  (variable values are shared while they are computed). It is also how a bag
 *  as written is taken: `Ref.toJSON` is its text. */
const copyJson = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;

/** Sizes of the arrays and objects substitution builds, so a value shared by
 *  many uses is measured once. */
const SIZE = new WeakMap<object, number>();

function sizeOf(v: unknown): number {
  if (typeof v === 'string') return 1 + v.length;
  if (typeof v !== 'object' || v === null) return 1;
  let n = SIZE.get(v);
  if (n === undefined) {
    n = 1;
    for (const item of Array.isArray(v) ? v : Object.values(v)) n += sizeOf(item);
    SIZE.set(v, n);
  }
  return n;
}

/** The diagnostics lists that already have their `SGL2016`: one per
 *  document, whoever spent the budget it shares (A9 fix round 1, I21). */
const REFUSED = new WeakSet<Diagnostic[]>();

/** Spend `cost` units, or report the one `SGL2016` a document gets and
 *  refuse. */
function charge(budget: Budget, cost: number, ref: Ref, diags: Diagnostic[]): boolean {
  if (budget.used + cost <= MAX_VARIABLE_EXPANSION) {
    budget.used += cost;
    return true;
  }
  budget.refused += 1;
  if (!REFUSED.has(diags)) {
    REFUSED.add(diags);
    diags.push(diagnostic('SGL2016', ref.span, { text: ref.text, limit: MAX_VARIABLE_EXPANSION }));
  }
  return false;
}

/** Every `Ref` in `raw`, in written order, without recursion. */
function refsIn(raw: unknown): Ref[] {
  const out: Ref[] = [];
  const stack: unknown[] = [raw];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v instanceof Ref) out.push(v);
    else if (Array.isArray(v) || isPlainObject(v)) {
      const items = Array.isArray(v) ? v : Object.values(v);
      for (let i = items.length - 1; i >= 0; i -= 1) stack.push(items[i]);
    }
  }
  return out;
}

/** Replace every `Ref` in `raw`. `$name` takes the variable's value whatever
 *  its type; `${name}` interpolates a string, number or bool as `String(v)`,
 *  and an object, array or null is `SGL2015`. A dropped reference (`lookup`
 *  returned `DROP`, an `SGL2015`, or the budget spent) drops the value that
 *  holds it: an array item, an object property, or at the top the key
 *  itself. The result may share arrays and objects with variable values;
 *  a use copies it (`finalizeConfig`). */
function substitute(raw: unknown, lookup: Lookup, diags: Diagnostic[], budget: Budget): unknown {
  if (raw instanceof Ref) {
    if (raw.whole) {
      const v = lookup((raw.parts[0] as { name: string }).name, raw);
      return v === DROP || !charge(budget, sizeOf(v), raw, diags) ? DROP : v;
    }
    const texts: string[] = [];
    for (const part of raw.parts) {
      if (typeof part === 'string') {
        texts.push(part);
        continue;
      }
      const v = lookup(part.name, raw);
      if (v === DROP) return DROP;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        diags.push(diagnostic('SGL2015', raw.span, { name: part.name, kind: Array.isArray(v) ? 'an array' : v === null ? 'null' : 'an object' }));
        return DROP;
      }
      texts.push(String(v));
    }
    let length = 0;
    for (const t of texts) length += t.length;
    return charge(budget, length, raw, diags) ? texts.join('') : DROP;
  }
  if (Array.isArray(raw)) {
    const out: unknown[] = [];
    let n = 1;
    for (const item of raw) {
      const v = substitute(item, lookup, diags, budget);
      if (v === DROP) continue;
      out.push(v);
      n += sizeOf(v);
    }
    SIZE.set(out, n);
    return out;
  }
  if (isPlainObject(raw)) {
    const out: Record<string, unknown> = {};
    let n = 1;
    for (const [k, item] of Object.entries(raw)) {
      const v = substitute(item, lookup, diags, budget);
      if (v === DROP) continue;
      out[k] = v;
      n += sizeOf(v);
    }
    SIZE.set(out, n);
    return out;
  }
  return raw;
}

/** Compute a variable's value, and first every variable it depends on,
 *  with an explicit stack: dependencies only ever point to earlier entries
 *  or enclosing scopes, so the graph is acyclic, and a chain of any length
 *  is safe. Each value is computed once and shared. */
function materialise(entry: VarEntry, diags: Diagnostic[]): void {
  const stack = [entry];
  while (stack.length > 0) {
    const e = stack[stack.length - 1] as VarEntry;
    if (e.state === 2) {
      stack.pop();
    } else if (e.state === 0) {
      e.state = 1;
      for (const d of e.refs.values()) if (d !== DROP && d.state === 0) stack.push(d);
    } else {
      const v = substitute(
        e.raw,
        (name) => {
          const d = e.refs.get(name);
          return d === undefined || d === DROP || d.value === FAILED ? DROP : d.value;
        },
        e.sink ?? diags,
        e.budget,
      );
      e.value = v === DROP ? FAILED : v;
      e.state = 2;
      stack.pop();
    }
  }
}

/** Look a name up through `scope` and its parents: the variable's value, or
 *  `DROP` silently for one whose own declaration failed, or `SGL2013` and
 *  `DROP` for a name no enclosing `@vars` declares. */
const scopeLookup =
  (scope: VarScope, diags: Diagnostic[]): Lookup =>
  (name, ref) => {
    const e = findVar(scope, name);
    if (e === undefined) {
      diags.push(diagnostic('SGL2013', ref.span, { name }));
      return DROP;
    }
    materialise(e, diags);
    return e.value === FAILED ? DROP : e.value;
  };

/**
 * Declare one `@vars` block on top of its enclosing scope, in declaration
 * order. An entry sees the enclosing scopes and the entries declared before
 * it. A reference to an entry of the same block declared at or after it
 * (itself, a later one, and so every cycle) is `SGL2014`, even when an
 * enclosing scope has the name: the block's own declaration shadows it for
 * the whole block. Names are checked here, once; values are computed on first
 * use (`materialise`), so a variable nobody uses costs nothing.
 *
 * Names must be identifiers: only an identifier can be referenced (`$name` is
 * `"$" Identifier`), so any other name is `SGL2011`. That rule is also what
 * keeps declaration order intact through canonical JSON: an object moves
 * integer-like keys first (execution plan §1), which would change the order
 * this pass depends on after a round trip.
 *
 * Returns `undefined` when `raw` is not an object (`SGL2011`, block ignored).
 */
function declareVars(raw: unknown, span: SourceSpan, parent: VarScope, diags: Diagnostic[]): VarScope | undefined {
  if (!isPlainObject(raw)) {
    diags.push(diagnostic('SGL2011', span, { key: 'vars', type: 'object' }));
    return undefined;
  }
  const entries = new Map<string, VarEntry>();
  const position = new Map<string, number>();
  for (const name of Object.keys(raw)) {
    if (IDENTIFIER.test(name)) position.set(name, position.size);
    else diags.push(diagnostic('SGL2011', span, { key: `vars.${name}`, type: 'an identifier as its name' }));
  }
  for (const [name, i] of position) {
    const refs = new Map<string, VarEntry | typeof DROP>();
    for (const ref of refsIn(raw[name])) {
      for (const part of ref.parts) {
        if (typeof part === 'string') continue;
        const j = position.get(part.name);
        const target = j === undefined ? findVar(parent, part.name) : j < i ? entries.get(part.name) : undefined;
        if (target !== undefined) refs.set(part.name, target);
        else {
          diags.push(
            j === undefined
              ? diagnostic('SGL2013', ref.span, { name: part.name })
              : diagnostic('SGL2014', ref.span, { name: part.name, user: name }),
          );
          refs.set(part.name, DROP);
        }
      }
    }
    entries.set(name, { raw: raw[name], refs, budget: parent.budget, state: 0, value: undefined });
  }
  return { parent, entries, budget: parent.budget };
}

// ---------------------------------------------------------------------------
// Classes (DD-02 §4)
// ---------------------------------------------------------------------------

/** A class body holds configuration only; a non-`@` key is `SGL2007` and
 *  dropped (DD-02 §4) — unlike a generic object value, where unprefixed keys
 *  are ordinary data (see `coerceObject`). `@extends` is pulled out rather
 *  than folded into `config`, matching `ClassModel`'s separate field. */
function buildClassBody(props: readonly Property[], diags: Diagnostic[]): { bag: Bag; extendRefs: (NameRef | Ref)[] } {
  const bag: Bag = { config: {}, configSpans: new Map() };
  const extendRefs: (NameRef | Ref)[] = [];
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

/** A class-name list (`@type`, `@extends`) with its variable references
 *  substituted: a reference may give one name or a list of them, each checked
 *  against `@classes` (`SGL2002`); anything but a name is `SGL2011`. Literal
 *  names were checked when inserted and pass through as they are. */
function resolveClassRefs(
  items: readonly (NameRef | Ref)[],
  key: string,
  lookup: Lookup,
  classNames: ReadonlySet<string>,
  diags: Diagnostic[],
  budget: Budget,
): NameRef[] {
  const out: NameRef[] = [];
  for (const item of items) {
    if (!(item instanceof Ref)) {
      out.push(item);
      continue;
    }
    const v = substitute(item, lookup, diags, budget);
    for (const name of v === DROP ? [] : [v].flat()) {
      if (typeof name !== 'string') diags.push(diagnostic('SGL2011', item.span, { key, type: 'a class name' }));
      else if (!classNames.has(name)) diags.push(diagnostic('SGL2002', item.span, { name }));
      else out.push({ name, span: item.span });
    }
  }
  return out;
}

/** Pass 1: class names and raw bodies. Names must be known before the tree is
 *  built (`@type` is checked as it is inserted); bodies are finalised in
 *  `buildClasses`, once the root's `@vars` are resolved. */
function collectClasses(
  classesEntries: readonly ConfigEntry[],
  diags: Diagnostic[],
  imported: readonly string[] = [],
): { raw: Map<string, { props: Property[]; span: SourceSpan }>; classNames: ReadonlySet<string> } {
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
  return { raw, classNames: new Set([...imported, ...raw.keys()]) };
}

function buildClasses(
  raw: ReadonlyMap<string, { props: Property[]; span: SourceSpan }>,
  classNames: ReadonlySet<string>,
  rootVars: VarScope,
  diags: Diagnostic[],
): { classes: Record<string, ClassModel>; classSpans: readonly (readonly [string, SourceSpan])[] } {
  const configs = new Map<string, { config: ConfigBag; authored?: ConfigBag }>();
  const rawExtends = new Map<string, NameRef[]>();
  const writtenExtends = new Map<string, (NameRef | Ref)[]>();
  const classSpans: (readonly [string, SourceSpan])[] = [];
  const lookup = scopeLookup(rootVars, diags);

  for (const [name, { props, span }] of raw) {
    classSpans.push([`c:${name}`, span] as const);
    const { bag, extendRefs } = buildClassBody(props, diags);
    configs.set(name, finalizeConfig(bag, 'class', rootVars, classNames, diags));
    const known = filterKnownRefs(extendRefs, classNames, diags);
    writtenExtends.set(name, known);
    rawExtends.set(name, resolveClassRefs(known, 'extends', lookup, classNames, diags, rootVars.budget));
  }

  // `@extends` cycles, broken the canonical way `compile()` also uses
  // (`class-graph.ts`): the back-edge into each cycle's smallest member is
  // spliced out and reported at the reference that wrote it.
  const { breaks } = breakExtendsCycles(new Map([...rawExtends].map(([n, refs]) => [n, refs.map((r) => r.name)] as const)));
  for (const { member, from, cycle } of breaks) {
    const list = rawExtends.get(from) as NameRef[];
    const at = list.find((r) => r.name === member) as NameRef;
    diags.push(diagnostic('SGL2004', at.span, { a: member, cycle }));
    rawExtends.set(from, list.filter((r) => r.name !== member));
  }

  const classes: Record<string, ClassModel> = {};
  for (const name of raw.keys()) {
    const list = rawExtends.get(name) as NameRef[];
    const { config, authored } = configs.get(name) as { config: ConfigBag; authored?: ConfigBag };
    const written = writtenExtends.get(name) as (NameRef | Ref)[];
    classes[name] = { name, extends: list.map((r) => r.name), config };
    if (authored === undefined && !written.some((r) => r instanceof Ref)) continue;
    // `@extends` as written: every reference as its text, and each literal
    // name that survived the unknown-class and cycle checks.
    const ext = written.filter((r) => r instanceof Ref || list.includes(r)).map((r) => (r instanceof Ref ? r.text : r.name));
    classes[name] = { name, extends: list.map((r) => r.name), config, authored: { ...(ext.length > 0 ? { extends: ext } : {}), ...(authored ?? config) } };
  }
  return { classes, classSpans };
}

// ---------------------------------------------------------------------------
// Registry-driven validation and sugar (DD-02 §7)
// ---------------------------------------------------------------------------

/** `@direction` is sugar for `@layout.direction` (language spec §4); an
 *  explicit `@layout.direction` already present wins. Valid wherever
 *  `@layout` itself is — a node's own, or root's document-level block. */
function foldDirectionSugar(bag: Record<string, unknown>): void {
  if (typeof bag.direction !== 'string') return;
  const dir = bag.direction;
  delete bag.direction;
  const layout = isPlainObject(bag.layout) ? { ...bag.layout } : {};
  if (!('direction' in layout)) layout.direction = dir;
  bag.layout = layout;
}

/**
 * Substitute variables, then validate against the registry: unknown key →
 * `SGL2010`, kept; wrong scope → `SGL2012`, dropped; wrong type → `SGL2011`,
 * dropped (DD-02 §7). Validation sees the substituted value, so `@order: $n`
 * is checked as the number it is.
 *
 * `authored` is the same bag as written, for `toJson` (DD-02 §6): references kept,
 * a container's `@vars` included, and the same keys dropped by validation. It
 * is returned only when it differs from `config`.
 */
function finalizeConfig(
  bag: Bag,
  scope: Scope,
  vars: VarScope,
  classNames: ReadonlySet<string>,
  diags: Diagnostic[],
  declaredVars?: unknown,
): { config: ConfigBag; authored?: ConfigBag } {
  const raw = bag.config;
  // `@vars` on a class or an edge: rejected before its contents are
  // substituted, so a bad block reports once, not once per reference in it.
  if ('vars' in raw) {
    diags.push(diagnostic('SGL2012', bag.configSpans.get('vars') as SourceSpan, { key: 'vars', scope }));
    delete raw.vars;
  }
  // `used` records whether any value referred to a variable: only then (or
  // when the container declares `@vars`) does the bag as written differ.
  let used = declaredVars !== undefined;
  const inScope = scopeLookup(vars, diags);
  const lookup: Lookup = (name, ref) => {
    used = true;
    return inScope(name, ref);
  };
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (key === 'type' && Array.isArray(value) && value.some((v) => v instanceof Ref)) {
      const items = value.map((v) => (v instanceof Ref ? v : { name: v as string, span: NO_SPAN }));
      config[key] = resolveClassRefs(items, 'type', lookup, classNames, diags, vars.budget).map((r) => r.name);
      used = true;
      continue;
    }
    const v = substitute(value, lookup, diags, vars.budget);
    if (v !== DROP) config[key] = v;
  }
  // A substituted value may share arrays and objects with a variable's value
  // (and so with every other use of it): each use gets its own copy. The
  // budget has already bounded how much there is to copy.
  if (used) for (const key of Object.keys(config)) config[key] = copyJson(config[key]);
  const authored = used ? (copyJson(raw) as Record<string, unknown>) : undefined;
  if (authored !== undefined && declaredVars !== undefined) authored.vars = copyJson(declaredVars);

  if (scope === 'root' || scope === 'node') {
    foldDirectionSugar(config);
    if (authored !== undefined) foldDirectionSugar(authored);
  }
  const drop = (key: string): void => {
    delete config[key];
    if (authored !== undefined) delete authored[key];
  };
  for (const key of Object.keys(config)) {
    const span = bag.configSpans.get(key) as SourceSpan;
    const result = validateConfigKey(key, config[key], scope);
    if (result.outcome === 'bad-scope') {
      diags.push(diagnostic('SGL2012', span, { key, scope }));
      drop(key);
    } else if (result.outcome === 'bad-type') {
      diags.push(diagnostic('SGL2011', span, { key, type: result.expected }));
      drop(key);
    } else if (result.outcome === 'unknown') {
      diags.push(diagnostic('SGL2010', span, { key }));
    } else if (key === 'size' && isPlainObject(config[key])) {
      // Spec §4: an unknown key within a known namespace is a warning. Kept,
      // like any unknown key; DD-04 §4 step 6 ignores it.
      for (const sub of Object.keys(config[key] as Record<string, unknown>).sort()) {
        if (!SIZE_KEYS.has(sub)) diags.push(diagnostic('SGL2010', span, { key: `size.${sub}` }));
      }
    }
  }
  return authored === undefined
    ? { config: config as ConfigBag }
    : { config: config as ConfigBag, authored: authored as ConfigBag };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function finalizeContainer(
  key: string,
  path: readonly string[],
  acc: Acc,
  scope: 'root' | 'node',
  declSpan: SourceSpan,
  spans: Map<string, SourceSpan>,
  classNames: ReadonlySet<string>,
  diags: Diagnostic[],
  vars: VarScope,
  declared?: unknown,
): ContainerModel {
  spans.set(`n:${nodeIdFromPath(path)}`, declSpan);

  // A container's own `@vars` scope everything in it: its own config, its
  // edges and its children (language spec §5). Root's arrive resolved
  // (`vars`, with the block as written in `declared`), because the class
  // bodies needed them first.
  if ('vars' in acc.config) {
    const scoped = declareVars(acc.config.vars, acc.configSpans.get('vars') as SourceSpan, vars, diags);
    if (scoped !== undefined) {
      vars = scoped;
      declared = acc.config.vars;
    }
    delete acc.config.vars;
  }
  const { config, authored } = finalizeConfig(acc, scope, vars, classNames, diags, declared);
  // `@size` is a node's (DD-04's size rows apply to nodes only): on a container,
  // one with children from any of its declarations, it is the wrong scope
  // (fix round 1, item 10; the cascade used to drop it silently).
  if (acc.children.size > 0 && 'size' in config) {
    diags.push(diagnostic('SGL2012', acc.configSpans.get('size') as SourceSpan, { key: 'size', scope: 'container' }));
    delete (config as Record<string, unknown>).size;
    if (authored !== undefined) delete (authored as Record<string, unknown>).size;
  }

  const children: ContainerModel[] = [];
  for (const [childKey, childAcc] of acc.children) {
    children.push(
      finalizeContainer(childKey, [...path, childKey], childAcc, 'node', childAcc.declSpan, spans, classNames, diags, vars),
    );
  }

  // One chain shares one bag, finalised once for all of its edges.
  const finalized = new Map<Bag, { config: ConfigBag; authored?: ConfigBag }>();
  const edges: EdgeModel[] = acc.edges.map((raw, i) => {
    spans.set(`e:${nodeIdFromPath(path)}#${i}`, raw.stmtSpan);
    let done = finalized.get(raw.bag);
    if (done === undefined) {
      done = finalizeConfig(raw.bag, 'edge', vars, classNames, diags);
      finalized.set(raw.bag, done);
    }
    return {
      from: raw.from,
      to: raw.to,
      directed: raw.directed,
      config: done.config,
      ordinal: raw.ordinal,
      ...(raw.fromPort !== undefined ? { fromPort: raw.fromPort } : {}),
      ...(raw.fromText !== undefined ? { fromText: raw.fromText } : {}),
      ...(raw.toText !== undefined ? { toText: raw.toText } : {}),
      ...(raw.toPort !== undefined ? { toPort: raw.toPort } : {}),
      ...(done.authored !== undefined ? { authored: done.authored } : {}),
    };
  });

  return { key, path, config, children, edges, ...(authored !== undefined ? { authored } : {}) };
}

const isKey = (entry: Entry, key: string): entry is ConfigEntry =>
  entry.kind === 'ConfigEntry' && entry.key[0] === key;

/** Does the root have an `@imports` entry? A document that does is resolved
 *  by `@sgl/core/imports` (A9, DD-02 §10.2; the app loads it only then,
 *  DD-08 §15 I25). */
export const hasImports = (ast: Document): boolean => ast.entries.some((e) => isKey(e, 'imports'));

/**
 * The seam `@sgl/core/imports` resolves a document with `@imports` through
 * (A9, DD-02 §10.2, I7), and nothing else: everything import-specific is
 * there, off the boot path (§10.9).
 */
export interface ImportSeam {
  /** The imported variables around the root's own, with the closure's
   *  shared budget (I13, I21). */
  readonly scope: VarScope;
  /** The imported class names, so references to them are known (I13). */
  readonly classes: readonly string[];
  /** Set by `resolve()`: the root scope, what the document exports (I15). */
  vars?: VarScope;
}

/**
 * Fold the AST into the canonical document model: merge redeclarations, expand
 * shorthands, normalise dotted `@`-keys, substitute variables, collect classes.
 *
 * Design: DD-02.
 */
export function resolve(ast: Document, seam?: ImportSeam): ResolveResult {
  const diags: Diagnostic[] = [];

  // `@sgl` is discarded — `DocumentModel.sgl` is the fixed literal `'1.0'`,
  // never round-tripped through generic config folding. `@classes` is routed
  // to class construction and never appears in `root.config` (DD-02 §4).
  // Root's `@vars` are resolved first: class bodies are declared at the root
  // and substitute from its scope.
  const classesEntries: ConfigEntry[] = [];
  const rootEntries: Entry[] = [];
  const rootVarsBag: Bag = { config: {}, configSpans: new Map() };
  for (const entry of ast.entries) {
    if (entry.kind === 'ConfigEntry' && entry.key.length === 1 && entry.key[0] === 'sgl') continue;
    if (entry.kind === 'ConfigEntry' && entry.key.length === 1 && entry.key[0] === 'classes') {
      classesEntries.push(entry);
      continue;
    }
    if (isKey(entry, 'vars')) {
      insertConfigValue(rootVarsBag, entry.key, coerceValue(entry.value, diags), entry.keySpan, diags);
      continue;
    }
    rootEntries.push(entry);
  }

  const declared = rootVarsBag.config.vars;
  const docScope = seam?.scope ?? newScope();
  const scoped = declared === undefined ? undefined : declareVars(declared, rootVarsBag.configSpans.get('vars') as SourceSpan, docScope, diags);
  const rootVars: VarScope = scoped ?? docScope;
  if (seam) seam.vars = rootVars;

  const { raw: rawClasses, classNames } = collectClasses(classesEntries, diags, seam?.classes);
  const { classes, classSpans } = buildClasses(rawClasses, classNames, rootVars, diags);

  const rootAcc: Acc = { config: {}, configSpans: new Map(), children: new Map(), edges: [] };
  buildEntries(rootEntries, rootAcc, classNames, diags);

  const spans = new Map<string, SourceSpan>(classSpans);
  const root = finalizeContainer('', [], rootAcc, 'root', ast.span, spans, classNames, diags, rootVars, scoped === undefined ? undefined : declared);

  return { model: { sgl: '1.0', root, classes, spans: spans as SpanTable }, diagnostics: diags };
}
