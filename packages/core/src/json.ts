/**
 * Canonical JSON (DD-02 §6): `toJson` and `fromJson`, the lossless round trip
 * of the document model.
 *
 * A separate entry, `@sgl/core/json` (A8 fix round 2, F20): only Save ▾ →
 * Canonical JSON needs it, so the app imports it from the lazy `file-actions`
 * chunk and the writers stay out of the boot bundle. Reading a `.sgl.json`
 * needs nothing from here: the grammar reads JSON, so `fromJson` is just
 * `resolve(parse(text))`, and boot parses stored and opened documents as
 * source either way.
 */

import type { PathExpr, PathStep } from './ast.js';
import { configKeyOrder } from './config-registry.js';
import type { ClassModel, ConfigBag, ContainerModel, DocumentModel, EdgeModel } from './model.js';
import { parse } from './parse.js';
import { resolve, type ResolveResult } from './resolve.js';

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
  const out: Record<string, unknown> = { from: edge.fromText ?? printPath(edge.from), to: edge.toText ?? printPath(edge.to) };
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
