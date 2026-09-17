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
 */
const NOT_YET_REACHABLE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  // Needs a document past the 1 000-edge expansion ceiling — a generated fixture
  // that belongs with the `n*` corpus documents `bench/generate.js` produces in
  // Stage G, not a hand-written one (DD-03 §3.1, Stage G tasks).
  'SGL3005',
  // Layout — the engine and worker host (Stage E, Stage H) don't exist yet.
  'SGL4001',
  'SGL4002',
  'SGL4003',
  'SGL4010',
  'SGL4011',
  // Theme cascade — @sgl/theme exists but is still tested against hand-built
  // StyledGraph fixtures (packages/theme/test/cascade.test.ts); it is not yet
  // wired to the corpus (that is Stage D's job), so these are unreachable from
  // *this* corpus-driven pipeline even though the theme package's own suite
  // already exercises the codes directly.
  'SGL5001',
  'SGL5002',
  'SGL5003',
  'SGL5004',
  'SGL5005',
  'SGL5006',
  // Renderer — @sgl/render-svg exists but has no tests yet (Stage F).
  'SGL6001',
]);

function listCorpusFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listCorpusFiles(`${dir}/${entry.name}`, `${rel}${entry.name}/`));
    else if (entry.name.endsWith('.sgl') || entry.name.endsWith('.sgl.json')) out.push(`${rel}${entry.name}`);
  }
  return out;
}

describe('diagnostics coverage gate (DD-09 §3.4)', () => {
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

  const codes = Object.keys(CATALOGUE) as DiagnosticCode[];

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
