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
 */

export interface EngineSchemas {
  readonly id: string;
  readonly optionsSchema?: JSONSchema7;
  readonly hintsSchema?: JSONSchema7;
}

interface LayoutKey {
  readonly key: string;
  readonly span: SourceSpan;
  readonly value: Value;
}

export function layoutConfigDiagnostics(ast: Document, engine: EngineSchemas): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  const declared = declaredKeys(engine);
  const visit = (entries: readonly Entry[], level: 'root' | 'node'): void => {
    for (const entry of entries) {
      if (entry.kind === 'NodeDecl') {
        if (entry.value?.kind === 'Block') visit(entry.value.entries, 'node');
        continue;
      }
      if (entry.kind !== 'ConfigEntry') continue;
      for (const k of layoutKeys(entry)) {
        if (k.key === 'engine') {
          if (level === 'node' && !namesEngine(k.value, engine.id)) {
            out.push(layoutDiagnostic('SGL4010', k.span, { key: 'engine', id: engine.id }));
          }
          continue;
        }
        if (declared !== null && !declared.has(k.key)) out.push(layoutDiagnostic('SGL4010', k.span, { key: k.key, id: engine.id }));
      }
    }
  };
  visit(ast.entries, 'root');
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

/** `sgl.elk`, or its short form `elk`. */
function namesEngine(value: Value, id: string): boolean {
  const name = value.kind === 'String' || value.kind === 'Word' ? value.value : undefined;
  if (name === undefined) return false;
  return name === id || (id.startsWith('sgl.') && name === id.slice('sgl.'.length));
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
