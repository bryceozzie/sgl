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

/** DD-12 N22: a bare name (`grid`, `elk`, `fixed`, …) means the `sgl.*`
 *  engine of that name when `known` says it is registered, the rule
 *  `layoutConfigDiagnostics`' `namesEngine` uses. A registered id, or any
 *  name whose `sgl.*` engine is not registered, is passed through, so an
 *  unknown one is `SGL4011` from the worker, as before. */
export function documentEngineOverride(model: DocumentModel, known?: (id: string) => boolean): string | undefined {
  const layout = asBag(model.root.config.layout);
  const value = layout?.engine;
  if (typeof value !== 'string') return undefined;
  return known !== undefined && !known(value) && known(`sgl.${value}`) ? `sgl.${value}` : value;
}
