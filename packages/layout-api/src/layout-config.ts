import {
  diagnostic,
  layoutDiagnostic,
  nodeIdFromPath,
  type ConfigBag,
  type ContainerModel,
  type Diagnostic,
  type Document,
  type DocumentModel,
  type Entry,
  type NodeId,
  type SourceSpan,
  type Value,
} from '@sgl/core';
import type { LayoutPlan, LayoutScope } from './compose.js';
import type { JSONSchema7 } from './contract.js';

/**
 * SGL4010 (DD-06 §2, §9) — the document's `@layout` keys checked against the
 * engine each one is for (Stage K fix round 1, item 23; human decision
 * 2026-09-23; scope-aware since B8, DD-14 C9–C11). Warnings, all "ignored":
 *
 * - at the root, a key the root's engine does not declare as an option
 *   (`optionsSchema`; DD-12 H6: `rootLayoutOptions` sends the rest to it);
 * - on a **boundary**, a container whose own engine the plan runs (DD-14 C1,
 *   `layoutPlan`), a key that engine does not declare as an option: its
 *   `@layout` works as the root's (C6);
 * - on any other node, a key the engine around it (the root's, or its
 *   innermost enclosing boundary's) does not declare as a hint (`hintsSchema`):
 *   those keys are hints for that engine (C9), so `@direction` on a plain
 *   container under `elk` is one. `@direction` is sugar for
 *   `@layout.direction` everywhere.
 *
 * A node's `engine` key is never `SGL4010`: an available engine makes the
 * container a boundary, and an unavailable one is `layoutPlan`'s `SGL4012`.
 *
 * **Why here.** `@sgl/core` knows nothing about engines, and the engine's
 * schemas live on its descriptor, which only a caller that knows the
 * engines has. `@sgl/layout-api` owns the `LayoutEngine` contract,
 * `optionsSchema`/`hintsSchema` included, and may import `@sgl/core`'s AST
 * types, so the check is a pure function of (AST, engine schemas) here; the
 * app's pipeline calls it with the root engine's descriptor and the plan's
 * boundaries, beside `buildLayoutInput`. It reads the AST rather than the
 * `SemanticGraph` because `compile()` drops the root's config bag and
 * neither keeps a span per `@layout` sub-key: the squiggle belongs on the key
 * itself.
 *
 * An engine the caller has no schemas for checks no key.
 *
 * SGL4021 (DD-12 N6, H4), in the same walk: a node's `@pin` under an engine
 * that does not declare `pins: true` is warned about once per node (by path,
 * however many times it is declared), at its first pin key in source order,
 * and ignored. The engine is the one that places the node (DD-14 C10): the
 * one around it, so a boundary's own pin is judged by its parent's engine.
 * Given the resolver's diagnostics (`resolved`), a node whose pin the
 * resolver dropped with `SGL2011` is skipped: that is already reported. A pin
 * on the root, a class or an edge is the resolver's `SGL2012` and is not
 * visited. Nodes grafted by `@imports` have no AST here and are not checked
 * (they cannot be edited from this document).
 */

export interface EngineSchemas {
  readonly id: string;
  readonly optionsSchema?: JSONSchema7;
  readonly hintsSchema?: JSONSchema7;
  /** The engine's `capabilities.pins` (DD-12 N6); absent means `false`. */
  readonly pins?: boolean;
  /** DD-12 H6: whether a `@layout` option's value is one the engine takes
   *  (`rootLayoutOptions`, `layoutPlan`). Absent: any value of a declared option. */
  readonly accepts?: (key: string, value: unknown) => boolean;
}

interface LayoutKey {
  readonly key: string;
  readonly span: SourceSpan;
  readonly value: Value;
}

/**
 * `boundary(id)` is the engine of the boundary `id`, from the plan
 * (`layoutPlan`'s scopes, looked up by the caller), or `undefined` for a node
 * that is not one. Without it, no node is a boundary.
 */
export function layoutConfigDiagnostics(
  ast: Document,
  engine: EngineSchemas,
  resolved: readonly Diagnostic[] = [],
  boundary: (id: NodeId) => EngineSchemas | undefined = () => undefined,
): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  // SGL4021 (fix round 1, items 6 and 7): each node's first pin key in source
  // order, by its path, so a node declared twice is warned about once; `null`
  // once the resolver has dropped one of its pins (SGL2011 at that key), which
  // is then reported once, by the resolver.
  const dropped = new Set(resolved.filter((d) => d.code === 'SGL2011').map((d) => d.span.from));
  const pins = new Map<string, readonly [SourceSpan, string] | null>();
  // `around` places this layer's nodes; `own` is the node's own engine when it
  // is a boundary. Recursive over the AST, as before: the parser's own depth
  // bounds it.
  const visit = (entries: readonly Entry[], path: readonly string[] | null, around: EngineSchemas, own: EngineSchemas | undefined): void => {
    const id = path === null ? '' : nodeIdFromPath(path);
    for (const entry of entries) {
      if (entry.kind === 'NodeDecl') {
        if (entry.value?.kind === 'Block') {
          const child = [...(path ?? []), entry.key];
          const inner = boundary(nodeIdFromPath(child) as NodeId);
          visit(entry.value.entries, child, own ?? around, inner);
        }
        continue;
      }
      if (entry.kind !== 'ConfigEntry') continue;
      if (path !== null && around.pins !== true && entry.key[0] === 'pin') {
        if (dropped.has(entry.keySpan.from)) pins.set(id, null);
        else if (!pins.has(id)) pins.set(id, [entry.keySpan, around.id]);
      }
      // The root's keys and a boundary's are options of their own engine;
      // any other node's are hints for the engine around it.
      const schemas = path === null ? around : own;
      const known = declaredKeys(schemas ?? around, schemas === undefined ? 'hintsSchema' : 'optionsSchema');
      for (const k of layoutKeys(entry)) {
        if (k.key !== 'engine' && known !== null && !known.has(k.key)) out.push(layoutDiagnostic('SGL4010', k.span, { key: k.key, id: (schemas ?? around).id }));
      }
    }
  };
  visit(ast.entries, null, engine, undefined);
  for (const pin of pins.values()) if (pin !== null) out.push(layoutDiagnostic('SGL4021', pin[0], { id: pin[1] }));
  return out;
}

/** Every `@layout` sub-key a config entry sets: `@layout.k: v`,
 *  `@layout: { k: v, … }`, and the `@direction` sugar. */
function layoutKeys(entry: Extract<Entry, { kind: 'ConfigEntry' }>): LayoutKey[] {
  const [head, sub] = entry.key;
  if (head === 'direction' && sub === undefined) return [{ key: 'direction', span: entry.keySpan, value: entry.value }];
  if (head !== 'layout') return [];
  if (sub !== undefined) return [{ key: sub, span: entry.keySpan, value: entry.value }];
  if (entry.value.kind !== 'Object') return [];
  return entry.value.props.map((p) => ({ key: p.key, span: p.keySpan, value: p.value }));
}

/** The keys `engine` declares in one of its schemas, or `null` when it has
 *  neither schema (nothing is checked). */
function declaredKeys(engine: EngineSchemas, schema: 'optionsSchema' | 'hintsSchema'): ReadonlySet<string> | null {
  if (engine.optionsSchema === undefined && engine.hintsSchema === undefined) return null;
  const props = engine[schema]?.['properties'];
  return new Set(typeof props === 'object' && props !== null ? Object.keys(props) : []);
}

/**
 * The options a `@layout` bag sets for `engine`: every key but `engine` that
 * the engine declares in its `optionsSchema`, with its resolved value
 * (variables substituted, the `@direction` sugar folded in), keys sorted. A
 * value `engine.accepts` refuses is left out and is one `SGL2011` at the last
 * key that set it (later wins), found in `keys` (none for an imported
 * container: it has no source here). An undeclared key is left out too: it
 * is `layoutConfigDiagnostics`' `SGL4010`.
 */
function optionsOf(
  bag: unknown,
  engine: EngineSchemas,
  keys: readonly LayoutKey[],
  diagnostics: Diagnostic[],
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const declared = declaredKeys(engine, 'optionsSchema');
  if (typeof bag !== 'object' || bag === null || declared === null) return options;
  const refused = new Map<string, SourceSpan | null>();
  for (const key of Object.keys(bag).sort()) {
    const value = (bag as ConfigBag)[key];
    if (key === 'engine' || !declared.has(key)) continue;
    if (engine.accepts?.(key, value) === false) refused.set(key, null);
    else options[key] = value;
  }
  for (const k of keys) if (refused.has(k.key)) refused.set(k.key, k.span);
  for (const [key, span] of refused) if (span !== null) diagnostics.push(diagnostic('SGL2011', span, { key: `layout.${key}`, type: `a value engine \`${engine.id}\` accepts` }));
  return options;
}

/**
 * DD-12 H6 (N40; language spec §4): the options a document's root `@layout`
 * sets for `engine` (`optionsOf`). For that document they override the
 * editor's options (the app merges them over its form's bag).
 *
 * A key the engine does not declare is not here (it is `layoutConfigDiagnostics`'
 * `SGL4010`). A value `engine.accepts` refuses is not here either: it is one
 * `SGL2011` at the key that set it (the last one, since later wins), and the
 * editor's value applies. Neither DD-06 nor DD-12 says what an invalid value
 * is; `SGL2011` is the resolver's "expects …; ignored", the code a malformed
 * `@pin` already gets.
 */
export function rootLayoutOptions(
  ast: Document,
  root: ConfigBag,
  engine: EngineSchemas,
): { readonly options: Readonly<Record<string, unknown>>; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const keys = ast.entries.flatMap((e) => (e.kind === 'ConfigEntry' ? layoutKeys(e) : []));
  return { options: optionsOf(root['layout'], engine, keys, diagnostics), diagnostics };
}

/**
 * DD-14 C8 (B8 branch 2): the document's **plan**, which containers are laid
 * out by an engine of their own (**boundaries**, C1), in `graph.order`, each
 * with its engine's full id, its options, complete, and the span of its
 * `engine` key (where the composer's `SGL4013` goes). From the resolved model
 * (so `engine: $e` works, and imported containers count), with the spans from
 * the AST.
 *
 * - **A boundary** is a visible container with a visible child whose
 *   `@layout.engine` names an engine `engines` has, by id or bare name
 *   (DD-12 N22). A leaf, or a hidden container, is not one and gets no
 *   warning (§3.7).
 * - **Options (C6):** its `@layout` keys that are options of its engine
 *   (`optionsOf`, as the root's: `SGL2011` for a value the engine refuses),
 *   over the options of the nearest enclosing boundary, or the root
 *   (`root.options`, the bag the root's engine is sent), laid out by the
 *   same engine, over that engine's defaults (its `optionsSchema`'s
 *   `default`s). Keys sorted.
 * - **`SGL4012` (C12):** a visible node naming an engine `engines` does not
 *   have, at its (last) `engine` key: it is laid out by the engine around it,
 *   and is not a boundary. Not for an imported node, which has no source here.
 *
 * The model walk is iterative (DD-12 N28): an imported document may nest
 * deeper than the call stack. The AST walk recurses, as
 * `layoutConfigDiagnostics`' does: the parser's own depth bounds it.
 */
export function layoutPlan(
  ast: Document,
  model: DocumentModel,
  root: { readonly engine: string; readonly options: Readonly<Record<string, unknown>> },
  engines: (id: string) => EngineSchemas | undefined,
): { readonly scopes: LayoutPlan; readonly diagnostics: readonly Diagnostic[] } {
  // Every node's `@layout` keys in source order, by id. A node grafted by
  // `@imports` has none: it gets no SGL4012 and no SGL2011 (§3.7).
  const keysOf = new Map<string, LayoutKey[]>();
  const walk = (entries: readonly Entry[], path: readonly string[]): void => {
    for (const entry of entries) {
      if (entry.kind === 'NodeDecl' && entry.value?.kind === 'Block') walk(entry.value.entries, [...path, entry.key]);
      else if (entry.kind === 'ConfigEntry' && path.length > 0) {
        const id = nodeIdFromPath(path);
        keysOf.set(id, [...(keysOf.get(id) ?? []), ...layoutKeys(entry)]);
      }
    }
  };
  walk(ast.entries, []);

  const scopes: LayoutScope[] = [];
  const diagnostics: Diagnostic[] = [];
  // [container, the engine around it, the options each engine's nearest scope has]
  type Frame = readonly [ContainerModel, string, ReadonlyMap<string, Readonly<Record<string, unknown>>>];
  const stack: Frame[] = [];
  const push = (parent: ContainerModel, around: string, inherit: Frame[2]): void => {
    for (let i = parent.children.length - 1; i >= 0; i -= 1) stack.push([parent.children[i]!, around, inherit]);
  };
  push(model.root, root.engine, new Map([[root.engine, root.options]]));
  while (stack.length > 0) {
    const [c, parentEngine, parentScopes] = stack.pop()!;
    let around = parentEngine;
    let inherit = parentScopes;
    // A hidden node hides its subtree: nothing below it is visited.
    if (c.config['hidden'] === true) continue;
    const id = nodeIdFromPath(c.path) as NodeId;
    const layout = c.config['layout'];
    const name = typeof layout === 'object' && layout !== null && !Array.isArray(layout) ? (layout as ConfigBag)['engine'] : undefined;
    const keys = keysOf.get(id) ?? [];
    let at: SourceSpan | undefined;
    for (const k of keys) if (k.key === 'engine') at = k.span;
    if (typeof name === 'string' && name.trim() !== '') {
      const schemas = engines(name) ?? engines(`sgl.${name}`);
      if (schemas === undefined) {
        if (at !== undefined) diagnostics.push(layoutDiagnostic('SGL4012', at, { name, node: id, id: around }));
      } else if (c.children.some((k) => k.config['hidden'] !== true)) {
        const bag: Record<string, unknown> = {};
        const props = schemas.optionsSchema?.['properties'] as Record<string, { default?: unknown }> | undefined;
        for (const k in props ?? {}) if (props![k]?.default !== undefined) bag[k] = props![k].default;
        Object.assign(bag, inherit.get(schemas.id), optionsOf(layout, schemas, keys, diagnostics));
        const options: Record<string, unknown> = {};
        for (const k of Object.keys(bag).sort()) options[k] = bag[k];
        scopes.push({ node: id, engine: schemas.id, options, ...(at !== undefined && { span: at }) });
        around = schemas.id;
        inherit = new Map(inherit).set(schemas.id, options);
      }
    }
    push(c, around, inherit);
  }
  return { scopes, diagnostics };
}
