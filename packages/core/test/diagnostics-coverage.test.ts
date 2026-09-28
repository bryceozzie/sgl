import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DiagnosticCode } from '../src/diagnostics.js';
import { compileImports, createImportLinker, resolveImports } from '../src/imports.js';
import { parse } from '../src/parse.js';
import { ALL_DIAGNOSTIC_CODES, CORE_OWNED_CODES, RENDER_SVG_OWNED_CODES } from './diagnostics-scope.js';
import { fileSystemHost } from './fs-host.js';

/**
 * DD-09 §3.4's coverage gate, enabled from Stage C on (DD-03 §"Gate"): every code
 * in `CATALOGUE` needs at least one `corpus/` document that emits it and one that
 * does not. Codes the pipeline cannot reach yet are named here with a reason, and
 * this allowlist is expected to shrink as later stages land — see
 * `corpus/README.md`'s own "Not yet covered" section, which this mirrors.
 *
 * Scoped to `parse -> resolve -> compile` (their import-aware forms, A9) — `@sgl/core` imports nothing from the
 * workspace (DD-00 §2 rule 1), so this file can't reach `@sgl/theme` or
 * `@sgl/render-svg` to check `SGL5xxx`/`SGL6001` reachability itself.
 * `packages/render-svg/test/diagnostics-coverage.test.ts` (Stage G) runs the
 * *whole* pipeline — parse through render — and owns those codes instead.
 * `./diagnostics-scope.js` defines the split once, so `CORE_OWNED_CODES` here and
 * `RENDER_SVG_OWNED_CODES` there are a partition of `CATALOGUE` by construction,
 * not two hand-maintained lists that could drift apart; the last test below
 * checks that directly.
 */
const NOT_YET_REACHABLE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  // Layout — the engine and worker host (Stage E, Stage H) don't exist below
  // @sgl/core; SGL4002 additionally needs a deliberately corrupt engine
  // output, which no *document* can produce. (SGL4003 moved to the render-svg
  // gate in feat/b5-fixed: `layout/pin-negative.sgl` reaches it under `fixed`.)
  'SGL4001',
  'SGL4002',
  'SGL4011',
  // B8 (DD-14 C28, §9): a box whose own engine fails is laid out by its
  // parent's, with this warning. No document can make a built-in engine fail;
  // `layout-api/test/compose.test.ts` covers it with stub engines.
  'SGL4013',
  // A9 fix round 1: emitted by the app's pipeline when the lazy `imports`
  // chunk cannot load, which no document can cause (DD-08 §15.6);
  // `apps/web/test/pipeline.test.ts` covers it.
  'SGL2027',
  // A18 fix round 1, item 2: emitted by the app's pipeline when the lazy
  // `rich-text` chunk cannot load, which no document can cause (DD-08 §3);
  // `apps/web/test/rich-text.test.ts` covers it.
  'SGL6002',
]);

function listCorpusFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listCorpusFiles(`${dir}/${entry.name}`, `${rel}${entry.name}/`));
    else if (entry.name.endsWith('.sgl') || entry.name.endsWith('.sgl.json')) out.push(`${rel}${entry.name}`);
  }
  return out;
}

describe('diagnostics coverage gate, parse/resolve/compile (DD-09 §3.4)', () => {
  const corpusDir = fileURLToPath(new URL('../../../corpus/', import.meta.url));
  const files = listCorpusFiles(corpusDir.slice(0, -1));
  expect(files.length).toBeGreaterThan(0);

  // parse/resolve/compile never throw on bad input (DD-00 §3) — including a
  // syntactically malformed document's partial AST, so running the whole
  // pipeline over every corpus file, malformed ones included, is safe. The
  // import-aware resolve and compile (A9, `@sgl/core/imports`), over a
  // file-system host, so `corpus/imports/` can import its neighbours; a
  // document without `@imports` resolves and compiles through them exactly
  // as through `resolve()` and `compile()`.
  const emittedBy = new Map<DiagnosticCode, Set<string>>();
  for (const file of files) {
    const path = `${corpusDir}${file}`;
    const src = readFileSync(path, 'utf8');
    const { ast, diagnostics: parseDiags } = parse(src);
    const { model, diagnostics: resolveDiags } = resolveImports(ast, createImportLinker(fileSystemHost(path), { self: path }));
    const { diagnostics: compileDiags } = compileImports(model);
    for (const d of [...parseDiags, ...resolveDiags, ...compileDiags]) {
      const set = emittedBy.get(d.code) ?? new Set<string>();
      set.add(file);
      emittedBy.set(d.code, set);
    }
  }

  // SGL5xxx/SGL6001 are the full-pipeline gate's to check (see the file doc
  // comment above) — excluded here rather than added to NOT_YET_REACHABLE,
  // because that set means "no corpus fixture reaches this at all", which is
  // no longer true for SGL5004/SGL6001 and was never the reason for the rest.
  const codes = CORE_OWNED_CODES;

  it.each(codes.filter((c) => !NOT_YET_REACHABLE.has(c)))('%s has a corpus fixture that emits it', (code) => {
    expect(emittedBy.get(code)?.size ?? 0).toBeGreaterThan(0);
  });

  it.each(codes.filter((c) => !NOT_YET_REACHABLE.has(c)))('%s also has a corpus fixture that does not emit it', (code) => {
    expect(emittedBy.get(code)?.size ?? 0).toBeLessThan(files.length);
  });

  it('the allowlist names only codes with no reachable stage yet', () => {
    // Anti-regression on the allowlist itself: once a stage lands and a code
    // becomes reachable, it must be removed from NOT_YET_REACHABLE rather than
    // silently continuing to pass via the exemption.
    for (const code of NOT_YET_REACHABLE) {
      expect(emittedBy.get(code)?.size ?? 0, `${code} is reachable now — remove it from NOT_YET_REACHABLE`).toBe(0);
    }
  });

  it('CORE_OWNED_CODES and RENDER_SVG_OWNED_CODES partition CATALOGUE (no drift between the two gates)', () => {
    const overlap = CORE_OWNED_CODES.filter((c) => RENDER_SVG_OWNED_CODES.includes(c));
    expect(overlap).toEqual([]);
    expect(new Set([...CORE_OWNED_CODES, ...RENDER_SVG_OWNED_CODES])).toEqual(new Set(ALL_DIAGNOSTIC_CODES));
  });
});
