/**
 * The resolver (DD-02): fold the AST into the canonical `DocumentModel` — merge
 * redeclarations, expand shorthands, normalise dotted `@`-keys, collect and
 * validate classes, split edge chains into `EdgeModel`s with unresolved
 * endpoints, substitute `@vars` (A8, DD-02 §3.5). `toJson`/`fromJson` are the
 * lossless canonical-JSON round trip (DD-02 §6), which keeps variable
 * references as written.
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
import { configKeyOrder, SIZE_KEYS, validateConfigKey } from './config-registry.js';
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
const IDENT = '[A-Za-z_](?:[A-Za-z0-9_]|-[A-Za-z0-9_])*';
const IDENTIFIER = new RegExp(`^${IDENT}$`);
/** A string that is exactly `$name` — the canonical-JSON spelling of a
 *  `Variable` (language spec §9: `"stroke": "$hot"`). */
const WHOLE_REF = new RegExp(`^\\$(${IDENT})$`);
const INTERPOLATION = new RegExp(`\\$\\{(${IDENT})\\}`, 'g');

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
  const whole = WHOLE_REF.exec(text);
  if (whole !== null) return new Ref(text, [{ name: whole[1] as string }], true, span);
  if (!text.includes('${')) return text;
  const parts: RefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(INTERPOLATION)) {
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
function parsePathText(text: string, realSpan: SourceSpan): PathExpr {
  const { ast } = parse(`${text} -> __sgl_edges_placeholder__`);
  for (const entry of ast.entries) {
    if (entry.kind === 'EdgeStmt' && entry.endpoints.length > 0) {
      return remapPathSpans((entry.endpoints[0] as { path: PathExpr }).path, realSpan);
    }
  }
  return { kind: 'PathExpr', root: false, parents: 0, segments: [], span: realSpan };
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
      bag,
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

/** Every variable visible in a container, its enclosing containers' included,
 *  mapped to its value. A variable whose own declaration failed maps to
 *  `FAILED`: a use of it drops the value without a second diagnostic, since
 *  the declaration already carries one. */
type VarScope = ReadonlyMap<string, unknown>;

const FAILED = Symbol('failed');
/** A substitution that dropped its value: the key is treated as absent. */
const DROP = Symbol('drop');

type Lookup = (name: string, ref: Ref) => unknown;

/** Plain JSON copied, so no two elements of the model share an object. It is
 *  also how a bag as written is taken: `Ref.toJSON` is its text. */
const copyJson = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;

/** Replace every `Ref` in `raw`. `$name` takes the variable's value whatever
 *  its type; `${name}` interpolates a string, number or bool by its canonical
 *  text and leaves an object, array or null out with `SGL2015`. A dropped
 *  reference (`lookup` returned `DROP`) drops the value that holds it: an array
 *  item, an object property, or at the top the key itself. */
function substitute(raw: unknown, lookup: Lookup, diags: Diagnostic[]): unknown {
  if (raw instanceof Ref) {
    if (raw.whole) return lookup((raw.parts[0] as { name: string }).name, raw);
    let out = '';
    for (const part of raw.parts) {
      if (typeof part === 'string') {
        out += part;
        continue;
      }
      const v = lookup(part.name, raw);
      if (v === DROP) return DROP;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out += String(v);
      else diags.push(diagnostic('SGL2015', raw.span, { name: part.name, kind: Array.isArray(v) ? 'an array' : v === null ? 'null' : 'an object' }));
    }
    return out;
  }
  if (Array.isArray(raw)) return raw.map((item) => substitute(item, lookup, diags)).filter((v) => v !== DROP);
  if (isPlainObject(raw)) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(raw)) {
      const v = substitute(item, lookup, diags);
      if (v !== DROP) out[k] = v;
    }
    return out;
  }
  return raw;
}

/** Look a name up in `scope`: its value (a copy), `DROP` silently for a
 *  variable that itself failed, or `SGL2013` and `DROP` for a name no
 *  enclosing `@vars` declares. */
const scopeLookup =
  (scope: VarScope, diags: Diagnostic[]): Lookup =>
  (name, ref) => {
    if (!scope.has(name)) {
      diags.push(diagnostic('SGL2013', ref.span, { name }));
      return DROP;
    }
    const v = scope.get(name);
    return v === FAILED ? DROP : copyJson(v);
  };

/**
 * Resolve one `@vars` block on top of its enclosing scope: a single pass in
 * declaration order, so nothing here recurses on the number of variables and a
 * block of any length, or any cycle, is safe. An entry sees the enclosing
 * scopes and the entries declared before it. A reference to an entry of the
 * same block declared at or after it (itself, a later one, and so every cycle)
 * is `SGL2014`, even when an enclosing scope has the name: the block's own
 * declaration shadows it for the whole block.
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
  const position = new Map<string, number>();
  for (const name of Object.keys(raw)) {
    if (IDENTIFIER.test(name)) position.set(name, position.size);
    else diags.push(diagnostic('SGL2011', span, { key: `vars.${name}`, type: 'an identifier as its name' }));
  }
  const scope = new Map(parent);
  const outer = scopeLookup(parent, diags);
  for (const [name, i] of position) {
    const v = substitute(
      raw[name],
      (ref, at) => {
        const j = position.get(ref);
        if (j === undefined) return outer(ref, at);
        if (j < i) return scopeLookup(scope, diags)(ref, at);
        diags.push(diagnostic('SGL2014', at.span, { name: ref, user: name }));
        return DROP;
      },
      diags,
    );
    scope.set(name, v === DROP ? FAILED : v);
  }
  return scope;
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
): NameRef[] {
  const out: NameRef[] = [];
  for (const item of items) {
    if (!(item instanceof Ref)) {
      out.push(item);
      continue;
    }
    const v = substitute(item, lookup, diags);
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
  return { raw, classNames: new Set(raw.keys()) };
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
    rawExtends.set(name, resolveClassRefs(known, 'extends', lookup, classNames, diags));
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
      config[key] = resolveClassRefs(items, 'type', lookup, classNames, diags).map((r) => r.name);
      used = true;
      continue;
    }
    const v = substitute(value, lookup, diags);
    if (v !== DROP) config[key] = v;
  }
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
      ...(raw.toPort !== undefined ? { toPort: raw.toPort } : {}),
      ...(done.authored !== undefined ? { authored: done.authored } : {}),
    };
  });

  return { key, path, config, children, edges, ...(authored !== undefined ? { authored } : {}) };
}

const isKey = (entry: Entry, key: string): entry is ConfigEntry =>
  entry.kind === 'ConfigEntry' && entry.key[0] === key;

/**
 * Fold the AST into the canonical document model: merge redeclarations, expand
 * shorthands, normalise dotted `@`-keys, substitute variables, collect classes.
 *
 * Design: DD-02.
 */
export function resolve(ast: Document): ResolveResult {
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
  const scoped =
    declared === undefined ? undefined : declareVars(declared, rootVarsBag.configSpans.get('vars') as SourceSpan, new Map(), diags);
  const rootVars: VarScope = scoped ?? new Map();

  const { raw: rawClasses, classNames } = collectClasses(classesEntries, diags);
  const { classes, classSpans } = buildClasses(rawClasses, classNames, rootVars, diags);

  const rootAcc: Acc = { config: {}, configSpans: new Map(), children: new Map(), edges: [] };
  buildEntries(rootEntries, rootAcc, classNames, diags);

  const spans = new Map<string, SourceSpan>(classSpans);
  const root = finalizeContainer('', [], rootAcc, 'root', ast.span, spans, classNames, diags, rootVars, scoped === undefined ? undefined : declared);

  return { model: { sgl: '1.0', root, classes, spans: spans as SpanTable }, diagnostics: diags };
}

// ---------------------------------------------------------------------------
// Canonical JSON (DD-02 §6)
// ---------------------------------------------------------------------------

// Mirrors the grammar's `Identifier` token exactly (`sgl.grammar`): a `-` is
// only part of the identifier when followed by another name character, so
// `a-` and `a--b` are NOT bare identifiers — printing them unquoted would
// parse back as a different, shorter name (`a`) on the next `fromJson`.
const BAREWORD = /^[A-Za-z_](?:[A-Za-z0-9_]|-[A-Za-z0-9_])*$/;

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
    if (cls.authored !== undefined) {
      const { extends: written, ...rest } = cls.authored;
      if (written !== undefined) body['@extends'] = written;
      writeConfig(body, rest);
    } else {
      if (cls.extends.length > 0) body['@extends'] = [...cls.extends];
      writeConfig(body, cls.config);
    }
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
  writeConfig(out, edge.authored ?? edge.config);
  return out;
}

function writeContainer(container: ContainerModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  writeConfig(out, container.authored ?? container.config);
  for (const child of container.children) out[child.key] = writeContainer(child);
  if (container.edges.length > 0) out['@edges'] = container.edges.map(writeEdge);
  return out;
}

/** Serialise the canonical `.sgl.json` form. Lossless but for comments and formatting. */
export function toJson(model: DocumentModel): string {
  const out: Record<string, unknown> = { '@sgl': model.sgl };
  writeConfig(out, model.root.authored ?? model.root.config);
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
