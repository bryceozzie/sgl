// Types for `scale-document.js`, for the TypeScript that imports it and is
// type-checked (`apps/web/bench/*.bench.ts`, A18).
export function scaleDocument(n: number, options?: { readonly rich?: boolean; readonly labelled?: boolean; readonly boxes?: 'grid' | 'elk' }): string;
export function editScaleDocument(source: string, kind: 'inside' | 'outside' | 'options', k: number): string;
