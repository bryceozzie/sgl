import type { ConfigBag, DocumentModel } from '@sgl/core';

/** DD-08 §10: "`@layout.engine` / `@theme` in the document override the
 *  pickers." Both `@theme: "x"` and `@layout.engine: "x"` / `@layout: {
 *  engine: "x" }` fold into `DocumentModel.root.config` the same way
 *  regardless of which spelling the author used (the resolver normalises
 *  dotted keys and nested objects alike, DD-02 §2), so reading the override is
 *  a single property lookup either way. */

function asBag(value: unknown): ConfigBag | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ConfigBag) : undefined;
}

export function documentThemeOverride(model: DocumentModel): string | undefined {
  const value = model.root.config.theme;
  return typeof value === 'string' ? value : undefined;
}

export function documentEngineOverride(model: DocumentModel): string | undefined {
  const layout = asBag(model.root.config.layout);
  const value = layout?.engine;
  return typeof value === 'string' ? value : undefined;
}
