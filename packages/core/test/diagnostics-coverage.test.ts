import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { CATALOGUE, type DiagnosticCode } from '../src/diagnostics.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';

/**
 * DD-09 §3.4's coverage gate, enabled from Stage C on (DD-03 §"Gate"): every code
 * in `CATALOGUE` needs at least one `corpus/` document that emits it and one that
 * does not. Codes the pipeline cannot reach yet are named here with a reason, and
 * this allowlist is expected to shrink as later stages land — see
 * `corpus/README.md`'s own "Not yet covered" section, which this mirrors.
 *
 * Scoped to `parse -> resolve -> compile` — `@sgl/core` imports nothing from the
 * workspace (DD-00 §2 rule 1), so this file can't reach `@sgl/theme` or
 * `@sgl/render-svg` to check `SGL5xxx`/`SGL6001` reachability itself.
 * `packages/render-svg/test/diagnostics-coverage.test.ts` (Stage G) runs the
 * *whole* pipeline — parse through render — and owns those codes; this file's
 * allowlist only needs to name the ones unreachable from *this* narrower
 * pipeline, which is why `SGL5xxx` and `SGL6001` are absent from it below
 * rather than listed as unreachable: they are `@sgl/render-svg`'s gate to keep.
 */
const NOT_YET_REACHABLE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  // Layout — the engine and worker host (Stage E, Stage H) don't exist below
  // @sgl/core; SGL4002/SGL4003 additionally need a deliberately corrupt engine
  // output, which no *document* can produce (see the render-svg gate).
  'SGL4001',
  'SGL4002',
  'SGL4003',
  'SGL4010',
  'SGL4011',
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
  // pipeline over every corpus file, malformed ones included, is safe.
  const emittedBy = new Map<DiagnosticCode, Set<string>>();
  for (const file of files) {
    const src = readFileSync(`${corpusDir}${file}`, 'utf8');
    const { ast, diagnostics: parseDiags } = parse(src);
    const { model, diagnostics: resolveDiags } = resolve(ast);
    const { diagnostics: compileDiags } = compile(model);
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
  const OUT_OF_SCOPE_HERE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
    'SGL5001',
    'SGL5002',
    'SGL5003',
    'SGL5004',
    'SGL5005',
    'SGL5006',
    'SGL6001',
  ]);

  const codes = (Object.keys(CATALOGUE) as DiagnosticCode[]).filter((c) => !OUT_OF_SCOPE_HERE.has(c));

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
});
