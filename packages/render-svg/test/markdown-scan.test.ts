import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile, parse, resolve } from '@sgl/core';
import { parseInline } from '@sgl/core/inline';
import { corpusSource, listCorpusDocs } from './pipeline.js';

/**
 * T13's promise, pinned (DD-11 §3): markdown is always on for `@label`, and **no
 * document without markdown changes** — not its graph, so not its measure keys,
 * its layout or its render. Every corpus document, the app's example and the
 * generated scale documents are compiled with and without the inline parser; the
 * graphs must be byte-identical for every document but the ones that are there to
 * hold markdown. The no-intraword rule (T6) is what keeps `a*b`, `2*3*4`, wildcard
 * endpoints and snake_case names out of that list.
 */

const APP_EXAMPLE = fileURLToPath(new URL('../../../apps/web/src/examples/checkout.sgl', import.meta.url));
const SCALE = ['n50.sgl', 'n500.sgl', 'n2000.sgl'];

/** The documents written to hold markdown, and nothing else. */
const MARKDOWN_DOCS = ['multiline.sgl', 'text/markdown.sgl', 'text/wrap.sgl', 'injection/markdown-in-label.sgl'];

function graphJson(source: string, withParser: boolean): string {
  const { model } = resolve(parse(source).ast);
  return JSON.stringify(compile(model, undefined, withParser ? { inline: parseInline } : undefined).graph);
}

describe('no document without markdown changes under the inline parser (DD-11 T13)', () => {
  const docs = listCorpusDocs();

  it('scans the whole corpus, the generated scale documents included', () => {
    expect(docs.length).toBeGreaterThan(60);
    for (const doc of SCALE) expect(docs, `${doc}: run pnpm generate:corpus`).toContain(doc);
  });

  it('exactly the markdown documents change; every other corpus document compiles byte-identically', () => {
    const changed = docs.filter((doc) => graphJson(corpusSource(doc), false) !== graphJson(corpusSource(doc), true));
    expect(changed.sort()).toEqual([...MARKDOWN_DOCS].sort());
  });

  it('the app\'s example document compiles byte-identically', () => {
    expect(existsSync(APP_EXAMPLE)).toBe(true);
    const source = readFileSync(APP_EXAMPLE, 'utf8');
    expect(graphJson(source, true)).toBe(graphJson(source, false));
  });

  it('the markdown documents do change, so the scan can see a change', () => {
    for (const doc of MARKDOWN_DOCS) expect(graphJson(corpusSource(doc), true), doc).not.toBe(graphJson(corpusSource(doc), false));
  });
});
