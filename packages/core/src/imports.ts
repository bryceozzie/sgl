/**
 * `@sgl/core/imports` (A9, DD-02 §10): everything import-specific, off the
 * boot path (§10.9).
 *
 * The boot bundle keeps only `hasImports` and `resolve()`'s `ImportSeam`
 * (imported variables around the root's own, imported class names known).
 * Everything else is here: reading `@imports` (§10.2), checking paths (I19),
 * looking documents up through a synchronous `ImportHost` (I7), cycles
 * (I20), caps (I21), parsing and resolving each import with core's own
 * parser (I8), qualifying what it exports, precedence and clashes
 * (I10–I15), grafting its subtree (I12), the warnings a failed import causes
 * (I17), the import rows of the catalogue, and the memo that makes a
 * keystroke in the importer cost only lookups (`ImportCache`).
 *
 * A caller resolves a document with `@imports` through `resolveImports` and
 * compiles its model through `compileImports`; the app loads this entry
 * lazily, and only for a document that has `@imports` (DD-08 §15, I25).
 *
 * Determinism (I18): the result of a root resolve is a pure function of its
 * AST and the host's answers. The cache never changes it: an entry is
 * reused only when every lookup it made answers the same again and the
 * closure's shared state (caps, the expansion budget) could not have changed
 * its outcome, and the variables an import exports are copied fresh for
 * every run, as they stood when that import was resolved.
 */

import type { ConfigEntry, Document, Entry, PathExpr, PathStep, Value } from './ast.js';
import { breakExtendsCycles } from './class-graph.js';
import { compile, renderPath, resolveBase, type CompileResult } from './compile.js';
import { CATALOGUE, diagnostic, type Diagnostic } from './diagnostics.js';
import type { ViewSelector } from './graph.js';
import { nodeIdFromPath } from './ids.js';
import { importDiagnostic, type ImportDiagnosticCode } from './imports-catalogue.js';
import type { ClassModel, ConfigBag, ContainerModel, DocumentModel, EdgeModel, ImportModel, ImportOrigin } from './model.js';
import { parse, type ParseResult } from './parse.js';
import {
  IDENT,
  IDENTIFIER,
  MAX_VARIABLE_EXPANSION,
  REF_PATTERNS,
  resolve,
  type Budget,
  type ImportSeam,
  type ResolveResult,
  type VarEntry,
  type VarScope,
} from './resolve.js';
import type { SourceSpan } from './span.js';

export { IMPORT_CATALOGUE, importDiagnostic, type ImportDiagnosticCode } from './imports-catalogue.js';

/** How an import path finds a document (DD-02 §10.1; the app's is DD-08 §15). */
export interface ImportHost {
  /** Synchronous and side-effect free. `from` is the importing document's
   *  key (`undefined` for a root without `self`). `candidates` > 1 is
   *  `SGL2018`. */
  lookup(path: string, from: string | undefined): ImportAnswer | undefined;
}

export interface ImportAnswer {
  readonly key: string;
  readonly source: string;
  /** How many documents the path matched; the host picked this one. */
  readonly candidates: number;
  /** The picked document's name, for `SGL2018`; the key when absent. */
  readonly name?: string;
}

/** Memoises parsing (by source) and each import's resolve (I8). Owned by the
 *  caller; the app keeps one for as long as its pipeline lives. `stats`
 *  counts the work actually done, for tests and the bench. */
export interface ImportCache {
  readonly stats: { readonly parses: number; readonly resolves: number };
}

/** An import that was linked, for a caller that needs the closure (the
 *  app's Share, DD-08 §15 I27). */
export interface LinkedDocument {
  /** The importing document's key (`undefined`: the root without `self`). */
  readonly from: string | undefined;
  readonly path: string;
  readonly key: string;
}

export interface ImportLinkerOptions {
  /** The importing document's own key: a lookup answering it is a cycle. */
  readonly self?: string;
  readonly cache?: ImportCache;
}

/** Links one document's `@imports` for `resolveImports` (DD-02 I7). Opaque:
 *  `createImportLinker` makes one. */
export interface ImportLinker {
  /** @internal Called once per resolve, first. Marks the items that failed. */
  link(items: readonly ImportModel[], diags: Diagnostic[]): Linked;
}

/** A linker for a root resolve, plus the closure its last run linked. */
export interface RootImportLinker extends ImportLinker {
  /** Every import the last resolve linked, depth first in link order. */
  linked(): readonly LinkedDocument[];
}

/** DD-02 I21. */
const MAX_DEPTH = 8;
const MAX_INSTANCES = 64;
const MAX_SOURCE_UNITS = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Reading `@imports` (DD-02 §10.2)
// ---------------------------------------------------------------------------

const isImports = (entry: Entry): entry is ConfigEntry => entry.kind === 'ConfigEntry' && entry.key[0] === 'imports';

/**
 * An `@imports` value as items: a string path, or `{ path: "…", as: name }`.
 * Anything else is `SGL2011` and ignored — the item, or the whole value when
 * it is not an array (or the key is dotted). A variable is not substituted
 * here (imports are linked before variables exist), so `$x` is `SGL2011` and
 * `"$x"` the literal path `$x`.
 */
function readImports(entry: ConfigEntry, diags: Diagnostic[]): ImportModel[] {
  const bad = (span: SourceSpan): void => void diags.push(diagnostic('SGL2011', span, { key: 'imports', type: 'an array of paths and `{ path, as }` objects' }));
  const value: Value = entry.value;
  const items: ImportModel[] = [];
  if (value.kind !== 'Array' || entry.key.length > 1) {
    bad(value.span);
    return items;
  }
  for (const v of value.items) {
    if (v.kind === 'String') {
      items.push({ path: v.value, form: 'string', span: v.span });
      continue;
    }
    let path: string | undefined;
    let as: string | undefined;
    let ok = v.kind === 'Object';
    for (const p of v.kind === 'Object' ? v.props : []) {
      const w = p.value;
      if (!p.isConfig && p.key === 'path' && w.kind === 'String') path = w.value;
      else if (!p.isConfig && p.key === 'as' && (w.kind === 'Word' || w.kind === 'String') && IDENTIFIER.test(w.value)) as = w.value;
      else ok = false;
    }
    if (ok && path !== undefined) items.push(as === undefined ? { path, form: 'object', span: v.span } : { path, as, form: 'object', span: v.span });
    else bad(v.span);
  }
  return items;
}

/**
 * The document's own `@classes`, less any class whose name has a `.`: that
 * is reserved for imported classes, `ns.Name`, in a document with `@imports`
 * (DD-02 I14; `SGL2011`, the class ignored). Returns the entries to resolve
 * and each own class's name and first declaration.
 */
function ownClasses(entries: readonly Entry[], diags: Diagnostic[]): { entries: Entry[]; own: Map<string, SourceSpan> } {
  const own = new Map<string, SourceSpan>();
  const out = entries.map((entry): Entry => {
    if (entry.kind !== 'ConfigEntry' || entry.key.length !== 1 || entry.key[0] !== 'classes' || entry.value.kind !== 'Object') return entry;
    const props = entry.value.props.filter((prop) => {
      if (!prop.key.includes('.')) {
        if (!own.has(prop.key)) own.set(prop.key, prop.span);
        return true;
      }
      diags.push(diagnostic('SGL2011', prop.keySpan, { key: `classes.${prop.key}`, type: 'a class name without `.`' }));
      return false;
    });
    return { ...entry, value: { ...entry.value, props } };
  });
  return { entries: out, own };
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

interface Recorded {
  readonly path: string;
  readonly from: string | undefined;
  readonly answer: ImportAnswer | undefined;
}

/** A closure-wide diagnostic (a cycle, a cap), kept as its parts so a cache
 *  hit can report it again where the new run reaches it. */
interface ClosureNote {
  readonly code: ImportDiagnosticCode;
  readonly values: Readonly<Record<string, string | number>>;
}

interface Totals {
  instances: number;
  units: number;
  /** Caps and budget refusals so far: anything whose outcome depended on
   *  the closure's shared state. */
  events: number;
}

/** One import's resolve, and everything it did to the run. */
interface Resolved {
  readonly result: ResolveResult;
  /** Its exported variables as they stood when it was resolved (`copyVars`
   *  makes each run's own from these). */
  readonly exports: ReadonlyMap<string, VarEntry>;
  readonly lookups: readonly Recorded[];
  readonly linked: readonly LinkedDocument[];
  readonly closure: readonly ClosureNote[];
  readonly delta: { readonly instances: number; readonly units: number; readonly budget: number; readonly refused: number; readonly events: number };
  /** The run's state when it began, kept only when something in it depended
   *  on that state (a cap, a budget refusal): then only the same state may
   *  reuse it. */
  readonly before?: string;
  /** With `before`: the caps reported by the end, which a reuse restores. */
  readonly capped?: readonly string[];
  gen: number;
}

interface CacheState extends ImportCache {
  readonly stats: { parses: number; resolves: number };
  readonly parsed: Map<string, { readonly result: ParseResult; gen: number }>;
  readonly resolved: Map<string, Resolved>;
  gen: number;
}

export function createImportCache(): ImportCache {
  const cache: CacheState = { stats: { parses: 0, resolves: 0 }, parsed: new Map(), resolved: new Map(), gen: 0 };
  return cache;
}

/** Drops what the last two runs did not use. */
function sweep(cache: CacheState): void {
  for (const map of [cache.parsed, cache.resolved] as Map<string, { gen: number }>[]) {
    for (const [k, v] of map) if (v.gen < cache.gen - 1) map.delete(k);
  }
}

const sameAnswer = (a: ImportAnswer | undefined, b: ImportAnswer | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.key === b.key && a.source === b.source && a.candidates === b.candidates && a.name === b.name);

// ---------------------------------------------------------------------------
// One root resolve's shared state
// ---------------------------------------------------------------------------

interface Run extends Totals {
  readonly budget: Budget;
  /** Caps already reported: one `SGL2020` per cap (I21). */
  readonly capped: Set<string>;
  readonly lookups: Recorded[];
  readonly linked: LinkedDocument[];
  readonly closure: ClosureNote[];
  /** The root's diagnostics, and the root item being linked: where a
   *  closure-wide problem is reported. */
  readonly diags: Diagnostic[];
  top: ImportModel;
}

const stateOf = (run: Run): string => JSON.stringify([run.instances, run.units, run.events, run.budget.used, run.budget.refused, [...run.capped].sort()]);

function note(run: Run, code: ImportDiagnosticCode, values: Readonly<Record<string, string | number>>): void {
  run.closure.push({ code, values });
  run.diags.push(importDiagnostic(code, run.top.span, values));
}

// ---------------------------------------------------------------------------
// Problems inside an import: one SGL2021 per item (I17)
// ---------------------------------------------------------------------------

/** An `SGL2021`'s own count and first message, so an importer counts every
 *  problem at any depth rather than one per summary. */
const SUMMARY = new WeakMap<Diagnostic, readonly [number, string]>();

function summarise(origin: ImportOrigin, problems: readonly Diagnostic[], diags: Diagnostic[]): void {
  let n = 0;
  let first: string | undefined;
  for (const d of problems) {
    if (d.severity === 'info') continue;
    const [count, message] = SUMMARY.get(d) ?? [1, d.message];
    n += count;
    first ??= message;
  }
  if (first === undefined) return;
  const d = importDiagnostic('SGL2021', origin.span, { path: origin.path, n, first: first.replace(/\.$/, '') });
  SUMMARY.set(d, [n, first]);
  diags.push(d);
}

// ---------------------------------------------------------------------------
// Variables an import exports (I10, I11, I15)
// ---------------------------------------------------------------------------

/** Every variable visible at a document's root, its own shadowing the ones
 *  it imported. */
function flatten(scope: VarScope): Map<string, VarEntry> {
  const scopes: VarScope[] = [];
  for (let s: VarScope | undefined = scope; s !== undefined; s = s.parent) scopes.unshift(s);
  const out = new Map<string, VarEntry>();
  for (const s of scopes) for (const [name, e] of s.entries) out.set(name, e);
  return out;
}

/**
 * Copies `vars` and every variable they depend on, keeping each one's state:
 * a value already computed stays computed, anything else is computed afresh
 * on first use, charged to `budget` and reporting to `sink`. No recursion,
 * so a dependency chain of any length is safe.
 */
function copyVars(vars: ReadonlyMap<string, VarEntry>, budget: Budget, sink?: Diagnostic[]): Map<string, VarEntry> {
  const copies = new Map<VarEntry, VarEntry>();
  const stack = [...vars.values()];
  while (stack.length > 0) {
    const e = stack.pop() as VarEntry;
    if (copies.has(e)) continue;
    copies.set(e, { raw: e.raw, refs: new Map(), budget, state: e.state === 2 ? 2 : 0, value: e.value, ...(sink !== undefined ? { sink } : {}) });
    for (const d of e.refs.values()) if (typeof d === 'object') stack.push(d);
  }
  for (const [e, c] of copies) for (const [name, d] of e.refs) c.refs.set(name, typeof d === 'object' ? (copies.get(d) as VarEntry) : d);
  return new Map([...vars].map(([name, e]) => [name, copies.get(e) as VarEntry]));
}

/**
 * The patterns `resolve()` reads `"$name"` and `"${name}"` with, extended to
 * `ns.name` for this document's import namespaces (DD-02 I16): a string is a
 * reference through a namespace only when it is one of them, so
 * `"$user.name"` stays literal text wherever `user` is not.
 */
function refPatterns(namespaces: readonly string[]): typeof REF_PATTERNS {
  const name = `(?:(?:${namespaces.join('|')})(?:\\.${IDENT})+|${IDENT})`;
  return { whole: new RegExp(`^\\$(${name})$`), interp: new RegExp(`\\$\\{(${name})\\}`, 'g') };
}

// ---------------------------------------------------------------------------
// The grafted subtree (I11, I12)
// ---------------------------------------------------------------------------

/**
 * The container `ns` for an import's root children and root edges: a copy
 * with every path under `ns`, every span the `@imports` item's, an absolute
 * path prefixed (`/x.y` → `/ns/x/y`) and a `../` that would climb out of the
 * import kept as written, as `EdgeModel.fromText` (so `compile()` reports it
 * and cannot reach the importer's own nodes), and every `@type` qualified
 * like the classes it names. Labelled with its `@title`, or `ns`; the rest
 * of its root configuration is dropped.
 */
function graftOne(model: DocumentModel, origin: ImportOrigin, ns: string, spans: Map<string, SourceSpan>): ContainerModel {
  const at = origin.span;
  const retype = (config: ConfigBag): ConfigBag =>
    Array.isArray(config.type) ? { ...config, type: config.type.map((t) => (typeof t === 'string' ? `${ns}.${t}` : t)) } : config;
  const step = (s: PathStep): PathStep => ({ ...s, span: at });
  const path = (p: PathExpr, depth: number): { p: PathExpr; text?: string } =>
    p.root
      ? { p: { ...p, span: at, segments: [{ kind: 'Name', value: ns, span: at }, ...p.segments.map(step)] } }
      : p.parents > depth
        ? { p: { kind: 'PathExpr', root: false, parents: 0, segments: [], span: at }, text: renderPath(p) }
        : { p: { ...p, span: at, segments: p.segments.map(step) } };
  const edge = (e: EdgeModel, depth: number): EdgeModel => {
    const from = e.fromText === undefined ? path(e.from, depth) : { p: path(e.from, 0).p, text: e.fromText };
    const to = e.toText === undefined ? path(e.to, depth) : { p: path(e.to, 0).p, text: e.toText };
    const out: { -readonly [K in keyof EdgeModel]: EdgeModel[K] } = { ...e, from: from.p, to: to.p, config: retype(e.config) };
    delete out.fromText;
    delete out.toText;
    if (from.text !== undefined) out.fromText = from.text;
    if (to.text !== undefined) out.toText = to.text;
    return out;
  };
  const walk = (c: ContainerModel, at_: readonly string[], depth: number): Pick<ContainerModel, 'children' | 'edges'> => {
    const id = nodeIdFromPath(at_);
    spans.set(`n:${id}`, at);
    return {
      children: c.children.map((k) => {
        const p = [...at_, k.key];
        return { ...k, path: p, config: retype(k.config), ...walk(k, p, depth + 1), ...(k.origin !== undefined ? { origin: { path: k.origin.path, span: at } } : {}) };
      }),
      edges: c.edges.map((e, i) => {
        spans.set(`e:${id}#${i}`, at);
        return edge(e, depth);
      }),
    };
  };
  const title = model.root.config.title;
  return { key: ns, path: [ns], config: { label: typeof title === 'string' ? title : ns }, ...walk(model.root, [ns], 0), origin };
}

// ---------------------------------------------------------------------------
// The linker
// ---------------------------------------------------------------------------

interface Chained {
  readonly key: string | undefined;
  /** How the chain names it in `SGL2019`. */
  readonly name: string;
}

/** An import the linker took in: its item, the document it resolved to,
 *  and where problems computing its variables later go. */
interface Taken {
  readonly item: ImportModel;
  readonly origin: ImportOrigin;
  readonly model: DocumentModel;
  readonly problems: Diagnostic[];
}

/** What one document's imports bring (§10.3), for `resolveWith`. */
interface Linked {
  /** The variable-expansion budget, shared by the whole closure (I21). */
  readonly budget: Budget;
  /** The imported variables, qualified: the scope around the root's own. */
  readonly vars: ReadonlyMap<string, VarEntry>;
  /** The imported classes, qualified, in import order; a later import's
   *  replaced an earlier one's (`SGL2023`). */
  readonly classes: ReadonlyMap<string, ClassModel>;
  readonly taken: readonly Taken[];
}

/**
 * The linker for one document of the closure. `chain` is how it was reached
 * (the root's is `self`), so its own imports are at depth `chain.length`.
 */
function linkerAt(host: ImportHost, cache: CacheState, chain: readonly Chained[], shared: { run?: Run }): ImportLinker {
  const isRoot = chain.length === 1;
  return {
    link(items, diags) {
      if (isRoot) {
        cache.gen += 1;
        shared.run = {
          budget: { used: 0, refused: 0 },
          instances: 0,
          units: 0,
          events: 0,
          capped: new Set(),
          lookups: [],
          linked: [],
          closure: [],
          diags,
          top: items[0] as ImportModel,
        };
      }
      const run = shared.run as Run;
      const vars = new Map<string, VarEntry>();
      const classes = new Map<string, ClassModel>();
      const taken: Taken[] = [];
      const seen = new Set<string>();

      for (const item of items) {
        if (isRoot) run.top = item;
        const fail = (): void => void ((item as { failed?: true }).failed = true);
        const cap = (kind: string, limit: string): void => {
          fail();
          run.events += 1;
          if (run.capped.has(kind)) return;
          run.capped.add(kind);
          note(run, 'SGL2020', { path: item.path, limit });
        };
        const ns = item.as;
        // I14: a second import with the same `as` is skipped. It has not
        // failed: the name belongs to the first.
        if (ns !== undefined) {
          if (seen.has(ns)) {
            diags.push(importDiagnostic('SGL2022', item.span, { name: ns, what: 'the name of an earlier import', outcome: 'this import was skipped' }));
            continue;
          }
          seen.add(ns);
        }
        // I19: relative paths only.
        if (item.path === '' || /^[\\/]|^[^\\/]*:/.test(item.path)) {
          fail();
          diags.push(importDiagnostic('SGL2025', item.span, { path: item.path }));
          continue;
        }
        if (chain.length > MAX_DEPTH) {
          cap('depth', `${MAX_DEPTH} levels of imports`);
          continue;
        }
        const from = chain[chain.length - 1]?.key;
        const answer = host.lookup(item.path, from);
        run.lookups.push({ path: item.path, from, answer });
        if (answer === undefined) {
          fail();
          diags.push(importDiagnostic('SGL2017', item.span, { path: item.path }));
          continue;
        }
        if (answer.candidates > 1) diags.push(importDiagnostic('SGL2018', item.span, { path: item.path, n: answer.candidates, chosen: answer.name ?? answer.key }));
        // I20: a document already on the chain is a cycle.
        const at = chain.findIndex((c) => c.key === answer.key);
        if (at >= 0) {
          fail();
          run.events += 1;
          note(run, 'SGL2019', { path: item.path, cycle: [...chain.slice(at).map((c) => c.name), item.path].join(' -> ') });
          continue;
        }
        if (run.instances + 1 > MAX_INSTANCES) {
          cap('instances', `${MAX_INSTANCES} imported documents`);
          continue;
        }
        if (run.units + answer.source.length > MAX_SOURCE_UNITS) {
          cap('source', `${MAX_SOURCE_UNITS} characters of imported source`);
          continue;
        }
        run.instances += 1;
        run.units += answer.source.length;
        run.linked.push({ from, path: item.path, key: answer.key });

        const resolved = resolveImport(host, cache, [...chain, { key: answer.key, name: item.path }], shared, answer.source);
        const { model, diagnostics } = resolved.result;
        const problems: Diagnostic[] = [...diagnostics];
        const origin: ImportOrigin = { path: item.path, span: item.span };
        taken.push({ item, origin, model, problems });

        // What it exports, under `ns` when it has one. A later import
        // shadows or replaces an earlier one (I13).
        const q = (name: string): string => (ns === undefined ? name : `${ns}.${name}`);
        for (const [name, e] of copyVars(resolved.exports, run.budget, problems)) vars.set(q(name), e);
        for (const c of Object.values(model.classes)) {
          const name = q(c.name);
          const prior = classes.get(name);
          if (prior !== undefined) {
            diags.push(importDiagnostic('SGL2023', item.span, { name, path: prior.origin?.path ?? '' }));
            classes.delete(name);
          }
          classes.set(name, { name, extends: ns === undefined ? c.extends : c.extends.map(q), config: c.config, origin });
        }
        // I10: without `as`, the nodes and edges stay behind, and it says so.
        if (ns === undefined && (model.root.children.length > 0 || model.root.edges.length > 0)) {
          diags.push(importDiagnostic('SGL2026', item.span, { path: item.path }));
        }
      }
      if (isRoot) sweep(cache);
      return { budget: run.budget, vars, classes, taken };
    },
  };
}

/** One import's resolve, from the cache when nothing it depended on has
 *  changed. `chain` ends with the import itself. */
function resolveImport(host: ImportHost, cache: CacheState, chain: readonly Chained[], shared: { run?: Run }, source: string): Resolved {
  const run = shared.run as Run;
  const key = JSON.stringify(chain.map((c) => c.key)) + source;
  const hit = cache.resolved.get(key);
  if (hit !== undefined && reusable(host, run, hit)) {
    hit.gen = cache.gen;
    run.instances += hit.delta.instances;
    run.units += hit.delta.units;
    run.events += hit.delta.events;
    run.budget.used += hit.delta.budget;
    run.budget.refused += hit.delta.refused;
    run.lookups.push(...hit.lookups);
    run.linked.push(...hit.linked);
    for (const c of hit.capped ?? []) run.capped.add(c);
    for (const { code, values } of hit.closure) note(run, code, values);
    return hit;
  }

  const before = stateOf(run);
  const start = { lookups: run.lookups.length, linked: run.linked.length, closure: run.closure.length, instances: run.instances, units: run.units, events: run.events, budget: run.budget.used, refused: run.budget.refused };
  let parsed = cache.parsed.get(source);
  if (parsed === undefined) {
    cache.stats.parses += 1;
    parsed = { result: parse(source), gen: 0 };
    cache.parsed.set(source, parsed);
  }
  parsed.gen = cache.gen;
  let exports: ReadonlyMap<string, VarEntry> = new Map();
  cache.stats.resolves += 1;
  const { model, diagnostics } = resolveWith(parsed.result.ast, linkerAt(host, cache, chain, shared), (scope) => {
    exports = copyVars(flatten(scope), run.budget);
  });
  const delta = {
    instances: run.instances - start.instances,
    units: run.units - start.units,
    events: run.events - start.events,
    budget: run.budget.used - start.budget,
    refused: run.budget.refused - start.refused,
  };
  const entry: Resolved = {
    result: { model, diagnostics: [...parsed.result.diagnostics, ...diagnostics] },
    exports,
    lookups: run.lookups.slice(start.lookups),
    linked: run.linked.slice(start.linked),
    closure: run.closure.slice(start.closure),
    delta,
    ...(delta.events > 0 || delta.refused > 0 ? { before, capped: [...run.capped] } : {}),
    gen: cache.gen,
  };
  cache.resolved.set(key, entry);
  return entry;
}

/** Whether a cached resolve is still the one this run would make: every
 *  lookup it made answers the same, and the closure's shared state could not
 *  change its outcome — the same state as before when it hit a cap or the
 *  budget, and otherwise room for all it used. */
function reusable(host: ImportHost, run: Run, hit: Resolved): boolean {
  for (const { path, from, answer } of hit.lookups) if (!sameAnswer(host.lookup(path, from), answer)) return false;
  if (hit.before !== undefined) return hit.before === stateOf(run);
  return (
    run.instances + hit.delta.instances <= MAX_INSTANCES &&
    run.units + hit.delta.units <= MAX_SOURCE_UNITS &&
    run.budget.used + hit.delta.budget <= MAX_VARIABLE_EXPANSION
  );
}

/**
 * The linker for a root `resolveImports` (DD-02 I7). One per open document
 * in the app, with `self` its id; `cache` may be shared by every linker a
 * caller makes. Each resolve it is given is one run: its caps and its
 * variable-expansion budget cover the whole closure (I21).
 */
export function createImportLinker(host: ImportHost, options: ImportLinkerOptions = {}): RootImportLinker {
  const cache = (options.cache ?? createImportCache()) as CacheState;
  const shared: { run?: Run } = {};
  const root = linkerAt(host, cache, [{ key: options.self, name: 'this document' }], shared);
  return {
    link: (items, diags) => root.link(items, diags),
    linked: () => shared.run?.linked ?? [],
  };
}

// ---------------------------------------------------------------------------
// Resolving a document with imports
// ---------------------------------------------------------------------------

/** A diagnostic's values, read back from its message by its catalogue
 *  template (`{name}` of `SGL2002`, `SGL2013`). */
function valuesOf(d: Diagnostic): Record<string, string> {
  const keys: string[] = [];
  const template = (CATALOGUE as Record<string, { template: string }>)[d.code]?.template ?? '';
  const pattern = template.replace(/\{(\w+)\}|[.*+?^${}()|[\]\\]/g, (m: string, key?: string) => (key === undefined ? `\\${m}` : (keys.push(key), '(.*)')));
  const m = new RegExp(`^${pattern}$`, 's').exec(d.message);
  return Object.fromEntries(keys.map((k, i) => [k, m?.[i + 1] ?? '']));
}

/**
 * Resolve a document with its imports. The steps around core's `resolve()`
 * (DD-02 §10.7 §3): read `@imports` and link it; drop the own classes I14
 * reserves; tell `resolve()` the imported variables and class names through
 * its `ImportSeam`, with `$ns.name` strings read as references for this
 * document's namespaces; then fold in what came back — imported classes
 * first, the merged table's `@extends` cycles, grafted containers first,
 * the warnings a failed import causes and one summary per import.
 */
function resolveWith(ast: Document, linker: ImportLinker | undefined, onVars?: (scope: VarScope) => void): ResolveResult {
  const diags: Diagnostic[] = [];

  // `@imports` first: a later declaration wins, like any key. Linked before
  // anything else, so the imported classes and variables are known before
  // the document's own are declared over them.
  let importsEntry: ConfigEntry | undefined;
  const rest: Entry[] = [];
  for (const entry of ast.entries) {
    if (isImports(entry)) importsEntry = entry;
    else rest.push(entry);
  }
  const items = importsEntry === undefined ? [] : readImports(importsEntry, diags);
  const linked = linker?.link(items, diags);
  const failed = new Map<string, string>();
  for (const item of items) {
    // I9: with no linker, every import is unresolved.
    if (linked === undefined) {
      (item as { failed?: true }).failed = true;
      diags.push(importDiagnostic('SGL2017', item.span, { path: item.path }));
    }
    if (item.failed && !failed.has(item.as ?? '')) failed.set(item.as ?? '', item.path);
  }

  // Your own classes replace imported ones whole (I13, `SGL2023`).
  const { entries, own } = ownClasses(rest, diags);
  const imported: ClassModel[] = [];
  for (const c of linked?.classes.values() ?? []) {
    const span = own.get(c.name);
    if (span === undefined) imported.push(c);
    else diags.push(importDiagnostic('SGL2023', span, { name: c.name, path: c.origin?.path ?? '' }));
  }

  const budget = linked?.budget ?? { used: 0, refused: 0 };
  const seam: ImportSeam = { scope: { parent: undefined, entries: linked?.vars ?? new Map(), budget }, classes: imported.map((c) => c.name) };
  const namespaces = items.flatMap((i) => i.as ?? []);
  const saved = REF_PATTERNS.whole;
  const savedInterp = REF_PATTERNS.interp;
  let result: ResolveResult;
  try {
    if (namespaces.length > 0) Object.assign(REF_PATTERNS, refPatterns(namespaces));
    result = resolve({ ...ast, entries }, seam);
  } finally {
    REF_PATTERNS.whole = saved;
    REF_PATTERNS.interp = savedInterp;
  }
  onVars?.(seam.vars as VarScope);

  // I17: an unknown name that may come from an import that failed — its
  // qualifier names one, or it is bare and an unqualified import failed —
  // is `SGL2024`, a warning, instead of `SGL2002` or `SGL2013`.
  for (const d of result.diagnostics) {
    if (failed.size > 0 && (d.code === 'SGL2002' || d.code === 'SGL2013')) {
      const name = valuesOf(d).name as string;
      const dot = name.indexOf('.');
      const path = failed.get(dot < 0 ? '' : name.slice(0, dot));
      if (path !== undefined) {
        diags.push(importDiagnostic('SGL2024', d.span, { name, path, what: d.code === 'SGL2002' ? 'the class' : 'the value' }));
        continue;
      }
    }
    diags.push(d);
  }

  const model = result.model;
  const spans = new Map(model.spans);
  // Imported classes first, in import order, then your own (I18).
  const classes: Record<string, ClassModel> = {};
  for (const c of imported) {
    classes[c.name] = c;
    spans.set(`c:${c.name}`, (c.origin as ImportOrigin).span);
  }
  Object.assign(classes, model.classes);
  // `@extends` cycles over the merged table (I13): an imported class's
  // `@extends` binds late, so shadowing its base can close a cycle. Broken
  // the canonical way (`class-graph.ts`); the document's own cycles were
  // broken by `resolve()` already.
  const { breaks } = breakExtendsCycles(new Map(Object.values(classes).map((c) => [c.name, c.extends] as const)));
  for (const { member, from, cycle } of breaks) {
    const c = classes[from] as ClassModel;
    diags.push(diagnostic('SGL2004', spans.get(`c:${from}`) as SourceSpan, { a: member, cycle }));
    const ext = c.authored?.extends;
    classes[from] = {
      ...c,
      extends: c.extends.filter((n) => n !== member),
      ...(Array.isArray(ext) ? { authored: { ...c.authored, extends: ext.filter((n) => n !== member) } } : {}),
    };
  }

  // Grafted containers first among the root's children, in `@imports`
  // order (I11, I12); an `as` that is one of your own root keys is not
  // grafted (I14).
  const grafted: ContainerModel[] = [];
  const ownKeys = new Set(model.root.children.map((c) => c.key));
  for (const { item, origin, model: m } of linked?.taken ?? []) {
    const ns = item.as;
    if (ns === undefined || (m.root.children.length === 0 && m.root.edges.length === 0)) continue;
    if (ownKeys.has(ns)) {
      diags.push(importDiagnostic('SGL2022', item.span, { name: ns, what: 'a node in this document', outcome: `the nodes and edges of \`${item.path}\` were not imported` }));
      continue;
    }
    grafted.push(graftOne(m, origin, ns, spans));
  }
  for (const { origin, problems } of linked?.taken ?? []) summarise(origin, problems, diags);

  const root = grafted.length > 0 ? { ...model.root, children: [...grafted, ...model.root.children] } : model.root;
  return {
    model: { ...model, root, classes, spans, ...(importsEntry !== undefined ? { imports: items } : {}) },
    diagnostics: diags,
  };
}

/**
 * `resolve()` for a document that may have `@imports` (DD-02 §10.2, I7):
 * links them through `linker` (`createImportLinker`), or, without one,
 * reports each as `SGL2017` (I9). A document without `@imports` resolves
 * exactly as `resolve()` resolves it.
 */
export function resolveImports(ast: Document, linker?: ImportLinker): ResolveResult {
  return resolveWith(ast, linker);
}

// ---------------------------------------------------------------------------
// Compiling a document with imports (DD-02 I17; DD-03)
// ---------------------------------------------------------------------------

const sameSpan = (a: SourceSpan, b: SourceSpan): boolean => a.from === b.from && a.to === b.to;

/**
 * `compile()` for a model `resolveImports` built, with I17's two rules on
 * top: `compile()`'s diagnostics on grafted elements — every span of which
 * is its `@imports` item's (I12) — are one `SGL2021` per import, and an edge
 * endpoint that reaches into an import that failed is `SGL2024`, a warning,
 * instead of `SGL2001`. A model without `imports` compiles exactly as
 * `compile()` compiles it.
 */
export function compileImports(model: DocumentModel, view?: ViewSelector): CompileResult {
  const result = compile(model, view);
  if (model.imports === undefined) return result;
  const failed = new Map(model.imports.filter((i) => i.failed && i.as !== undefined).map((i) => [i.as as string, i.path]));
  const sinks = new Map<ImportOrigin, Diagnostic[]>();
  for (const c of model.root.children) if (c.origin !== undefined) sinks.set(c.origin, []);

  const diags: Diagnostic[] = [];
  for (const d of result.diagnostics) {
    const origin = [...sinks.keys()].find((o) => sameSpan(o.span, d.span));
    if (origin !== undefined) (sinks.get(origin) as Diagnostic[]).push(d);
    else diags.push(d.code === 'SGL2001' && failed.size > 0 ? (edgeIntoFailed(model, d, failed) ?? d) : d);
  }
  for (const [origin, list] of sinks) summarise(origin, list, diags);
  return { ...result, diagnostics: diags };
}

/** `SGL2024` for an `SGL2001` whose endpoint reaches into an import that
 *  failed: its declaring edge is found by the statement's span, and the
 *  endpoint by the message `compile()` wrote for it. */
function edgeIntoFailed(model: DocumentModel, d: Diagnostic, failed: ReadonlyMap<string, string>): Diagnostic | undefined {
  const visit = (c: ContainerModel): Diagnostic | undefined => {
    if (c.origin !== undefined) return undefined;
    const id = nodeIdFromPath(c.path);
    const label = c.path.length === 0 ? 'the document root' : c.path.join('.');
    for (const [i, e] of c.edges.entries()) {
      const span = model.spans.get(`e:${id}#${i}`);
      if (span === undefined || !sameSpan(span, d.span)) continue;
      for (const [p, text] of [
        [e.from, e.fromText],
        [e.to, e.toText],
      ] as const) {
        // The root-level name the endpoint reaches through: its base's
        // first, or its own first segment when that is a name (DD-03 §3.1).
        const base = text === undefined ? resolveBase(p, c.path) : undefined;
        if (base === undefined) continue;
        const step = p.segments[0];
        const first = base[0] ?? (step?.kind === 'Name' ? step.value : undefined);
        const path = first === undefined ? undefined : failed.get(first);
        if (path === undefined) continue;
        const name = renderPath(p);
        if (diagnostic('SGL2001', d.span, { path: name, container: label }).message === d.message) {
          return importDiagnostic('SGL2024', d.span, { name, path, what: 'the edge' });
        }
      }
    }
    for (const child of c.children) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(model.root);
}
