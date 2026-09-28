import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DD-13 P4, P13, P46 (help branches 1 and 2): the reference builder and the
 * help content are lazy. Only the help
 * chunks import it, dynamically, so it must never be statically reachable
 * from the page's entry (`main.tsx`) or from the layout worker's, which
 * together are the core bundle. `feat/help-drawer` (branch 4) imports it,
 * from the lazy help chunks, and names `reference-*.js` and the help chunks
 * in `.size-limit.js`'s lazy list, where `check-core-chunks.mjs` checks the
 * built chunks by their module graph; this still walks the sources.
 *
 * Help branch 2 adds the help content: the modules in `src/help/` (the
 * content types and `joinHelp`), the Markdown in `apps/web/help/` and its
 * compiled form, the `virtual:sgl-help-content` module
 * (`build/help-plugin.ts`). None may be reachable from either entry; branch 4
 * imports them from the lazy help chunks, and `check-core-chunks.mjs` then
 * also checks the built chunks.
 *
 * Static imports and re-exports only: `import('./x.js')` is how a lazy chunk
 * is loaded and is not followed; `import type` is erased and is not followed.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const HELP_MARKDOWN = fileURLToPath(new URL('../help/', import.meta.url));
const ENTRIES = ['main.tsx', 'layout.worker.ts'];
const REFERENCE_DIR = 'reference/';
const HELP_DIR = 'help/';
const HELP_MODULE = 'virtual:sgl-help-content';

/** Every specifier a file imports or re-exports statically, relative or not. */
const ANY_STATIC = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g;

/** The static imports in `code` (the file at `from`) that reach the help content: the virtual module, or a file under `apps/web/help/`. */
function helpImports(from: string, code: string): readonly string[] {
  return [...code.matchAll(ANY_STATIC)]
    .map((m) => m[1]!)
    .filter((spec) => spec.split('?')[0] === HELP_MODULE || (spec.startsWith('.') && resolve(dirname(from), spec.split('?')[0]!).startsWith(HELP_MARKDOWN)));
}

const STATIC =
  /(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)(?:[\w$*{}\s,]+?\s+from\s+)?['"](\.{1,2}\/[^'"?]+)(?:\?[^'"]*)?['"]/g;

function resolveSource(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`];
  return candidates.find((c) => /\.tsx?$/.test(c) && existsSync(c));
}

/** Every source file under `src/` the entries reach by static imports. */
function staticGraph(entries: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(SRC, e));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(STATIC)) {
      const next = resolveSource(file, m[1]!);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  return new Set([...seen].map((f) => relative(SRC, f).split('\\').join('/')));
}

describe('the reference builder and the help content stay out of the core bundle (DD-13 P46)', () => {
  const reached = staticGraph(ENTRIES);

  it('the walk sees the boot path (not vacuous)', () => {
    for (const f of ['App.tsx', 'io/app-boot.ts', 'state/pipeline.ts', 'toolbar/EnginePicker.tsx']) expect(reached).toContain(f);
    // Help branch 4: the Help button and the first-visit check are the boot
    // path's share of help; the drawer is `import('../help/help.js')`.
    for (const f of ['toolbar/HelpButton.tsx', 'state/first-visit.ts']) expect(reached).toContain(f);
    // `share.ts` is lazy (`import('./share.js')`): proof dynamic imports are not followed.
    expect(reached).not.toContain('state/share.ts');
    expect(existsSync(resolve(SRC, REFERENCE_DIR, 'build.ts'))).toBe(true);
  });

  it('no file in src/reference/ is statically reachable from main.tsx or the layout worker', () => {
    expect([...reached].filter((f) => f.startsWith(REFERENCE_DIR))).toEqual([]);
  });

  it('no file in src/help/ (the content types, joinHelp) is statically reachable either', () => {
    expect(existsSync(resolve(SRC, HELP_DIR, 'join.ts'))).toBe(true);
    expect([...reached].filter((f) => f.startsWith(HELP_DIR))).toEqual([]);
  });

  it('no reachable file imports the compiled content or the help Markdown', () => {
    // The detector itself, on imports that would break the rule.
    const app = resolve(SRC, 'App.tsx');
    expect(helpImports(app, "import content from 'virtual:sgl-help-content';\nimport x from '../help/quickstart.md?raw';\nimport y from './help/join.js';")).toEqual([
      'virtual:sgl-help-content',
      '../help/quickstart.md?raw',
    ]);
    expect(helpImports(app, "const c = import('virtual:sgl-help-content');\nimport type { HelpContent } from 'virtual:sgl-help-content';")).toEqual([]);
    const offenders = [...reached].flatMap((f) => helpImports(resolve(SRC, f), readFileSync(resolve(SRC, f), 'utf8')).map((spec) => `${f}: ${spec}`));
    expect(offenders).toEqual([]);
  });
});
