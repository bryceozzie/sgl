import { layoutDiagnostic, type Diagnostic, type Document, type Entry, type SourceSpan, type Value } from '@sgl/core';
import type { JSONSchema7 } from './contract.js';

/**
 * SGL4010 (DD-06 §2, §9) — the document's `@layout` keys checked against the
 * effective engine (Stage K fix round 1, item 23; human decision 2026-09-23).
 * Two cases, both warnings, both "ignored":
 *
 * - (a) a container-level `@layout.engine` naming a different engine than
 *   the effective (root) one. Per-container engines are B8/B9 and
 *   `ctx.sublayout` is unimplemented, so the whole document is laid out by
 *   one engine; the `{key}` is `engine`.
 * - (b) any `@layout.{key}` — root or container, `@direction` sugar included —
 *   that the effective engine declares neither as an option (`optionsSchema`)
 *   nor as a hint (`hintsSchema`), e.g. `columns` under `elk`. A container's
 *   `@layout` keys are hints (DD-06 §2), so the hint schema counts too.
 *
 * **Why here.** `@sgl/core` knows nothing about engines, and the engine's
 * schemas live on its descriptor, which only a caller that knows the
 * effective engine has. `@sgl/layout-api` owns the `LayoutEngine` contract,
 * `optionsSchema`/`hintsSchema` included, and may import `@sgl/core`'s AST
 * types, so the check is a pure function of (AST, engine schemas) here; the
 * app's pipeline calls it with the effective engine's descriptor, beside
 * `buildLayoutInput`. It reads the AST rather than the `SemanticGraph`
 * because `compile()` drops the root's config bag and neither keeps a span per
 * `@layout` sub-key: the squiggle belongs on the key itself.
 *
 * An engine the caller has no schemas for gets (a) only.
 *
 * SGL4021 (DD-12 N6, H4), in the same walk: a node's `@pin` under an engine
 * that does not declare `pins: true` is warned about once per node (by path,
 * however many times it is declared), at its first pin key in source order,
 * and ignored. Given the resolver's diagnostics (`resolved`), a node whose pin
 * the resolver dropped with `SGL2011` is skipped: that is already reported.
 * A pin on the root, a class or an edge is the resolver's `SGL2012` and is not
 * visited. Nodes grafted by `@imports` have
 * no AST here and are not checked (they cannot be edited from this document).
 */

export interface EngineSchemas {
  readonly id: string;
  readonly optionsSchema?: JSONSchema7;
  readonly hintsSchema?: JSONSchema7;
  /** The engine's `capabilities.pins` (DD-12 N6); absent means `false`. */
  readonly pins?: boolean;
}

interface LayoutKey {
  readonly key: string;
  readonly span: SourceSpan;
  readonly value: Value;
}

export function layoutConfigDiagnostics(ast: Document, engine: EngineSchemas, resolved: readonly Diagnostic[] = []): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  const declared = declaredKeys(engine);
  // SGL4021 (fix round 1, items 6 and 7): each node's first pin key in source
  // order, by its path, so a node declared twice is warned about once; `null`
  // once the resolver has dropped one of its pins (SGL2011 at that key), which
  // is then reported once, by the resolver.
  const dropped = new Set(resolved.filter((d) => d.code === 'SGL2011').map((d) => d.span.from));
  const pins = new Map<string, SourceSpan | null>();
  const visit = (entries: readonly Entry[], path: string | null): void => {
    for (const entry of entries) {
      if (entry.kind === 'NodeDecl') {
        if (entry.value?.kind === 'Block') visit(entry.value.entries, path === null ? entry.key : `${path}\u0000${entry.key}`);
        continue;
      }
      if (entry.kind !== 'ConfigEntry') continue;
      if (path !== null && engine.pins !== true && entry.key[0] === 'pin') {
        if (dropped.has(entry.keySpan.from)) pins.set(path, null);
        else if (!pins.has(path)) pins.set(path, entry.keySpan);
      }
      for (const k of layoutKeys(entry)) {
        if (k.key === 'engine') {
          if (path !== null && !namesEngine(k.value, engine.id)) {
            out.push(layoutDiagnostic('SGL4010', k.span, { key: 'engine', id: engine.id }));
          }
          continue;
        }
        if (declared !== null && !declared.has(k.key)) out.push(layoutDiagnostic('SGL4010', k.span, { key: k.key, id: engine.id }));
      }
    }
  };
  visit(ast.entries, null);
  for (const span of pins.values()) if (span !== null) out.push(layoutDiagnostic('SGL4021', span, { id: engine.id }));
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

/** `sgl.elk`, or its short form `elk`. An empty name counts as naming it:
 *  the resolver drops it with SGL2011 (fix round 1, item 8), so it is not a
 *  second engine to warn about. */
function namesEngine(value: Value, id: string): boolean {
  const name = value.kind === 'String' || value.kind === 'Word' ? value.value : undefined;
  if (name === undefined) return false;
  return name.trim() === '' || name === id || (id.startsWith('sgl.') && name === id.slice('sgl.'.length));
}

function declaredKeys(engine: EngineSchemas): ReadonlySet<string> | null {
  if (engine.optionsSchema === undefined && engine.hintsSchema === undefined) return null;
  const keys = new Set<string>();
  for (const schema of [engine.optionsSchema, engine.hintsSchema]) {
    const props = schema?.['properties'];
    if (typeof props === 'object' && props !== null) for (const k of Object.keys(props)) keys.add(k);
  }
  return keys;
}
