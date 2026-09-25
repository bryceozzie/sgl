import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Tree } from '@lezer/common';
import { describe, expect, it } from 'vitest';
// The generated parser is committed (DD-10 §3), so this runs without the generator.
import { parser } from '../src/grammar/sgl.parser.js';
import { parse } from '../src/parse.js';

/**
 * The grammar's anti-regression pin (A9 phase 2, I16; DD-01 §2 "Qualified
 * names: the token audit"). Every committed corpus document — `malformed/`
 * and the rest included, since error recovery is part of the grammar's
 * behaviour too — plus the app's example and the e2e fixtures, parsed and
 * printed as its whole CST: every node's name and range, error nodes
 * included. The files under `__goldens__/trees/` were written **before**
 * the qualified-name change to `sgl.grammar`; after it they must be
 * byte-identical, which is the proof that no existing document parses
 * differently. A grammar change that moves one of them is a language change
 * for documents people already have.
 *
 * Node names, not term ids: ids are an artefact of the generated tables and
 * renumber whenever a production is added, while names and ranges are what
 * `buildAst`, highlighting and folding read.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));

/** Committed documents only (`git ls-files`): the generated scale fixtures
 *  (`corpus/n*.sgl`, gitignored) are derived from `bench/scale-document.js`
 *  and have nothing to pin. */
const DOCS: readonly string[] = execFileSync('git', ['ls-files', 'corpus', 'apps/web/src/examples', 'apps/web/e2e/fixtures'], { cwd: repo, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(sgl|sgl\.json)$/.test(f))
  .sort();

/** One line per node, indented by depth: `Name from-to`. */
export function printTree(tree: Tree): string {
  const lines: string[] = [];
  const cursor = tree.cursor();
  let depth = 0;
  for (;;) {
    lines.push(`${'  '.repeat(depth)}${cursor.type.isError ? '⚠' : cursor.type.name} ${cursor.from}-${cursor.to}`);
    if (cursor.firstChild()) {
      depth += 1;
      continue;
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return `${lines.join('\n')}\n`;
      depth -= 1;
    }
  }
}

describe('every existing document parses exactly as before (I16 pin)', () => {
  it('finds the documents to pin', () => {
    expect(DOCS.length).toBeGreaterThan(60);
  });

  it.each(DOCS)('%s', async (doc) => {
    const tree = parser.parse(readFileSync(`${repo}${doc}`, 'utf8'));
    await expect(printTree(tree)).toMatchFileSnapshot(`./__goldens__/trees/${doc}.txt`);
  });
});

describe('and builds exactly the same AST and syntax diagnostics (I16 pin)', () => {
  it.each(DOCS)('%s', async (doc) => {
    const { ast, diagnostics } = parse(readFileSync(`${repo}${doc}`, 'utf8'));
    await expect(`${JSON.stringify({ ast, diagnostics }, null, 1)}\n`).toMatchFileSnapshot(`./__goldens__/ast/${doc}.json`);
  });
});
