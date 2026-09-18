import { CATALOGUE, type DiagnosticCode } from '@sgl/core';
import { neutralDark, neutralLight, type ThemeDoc } from '@sgl/theme';
import { beforeAll, describe, expect, it } from 'vitest';
import { corpusSource, listCorpusDocs, runPipeline } from './pipeline.js';

/**
 * DD-09 §3.4's coverage gate, the `SGL5xxx`/`SGL6001` half of it.
 *
 * `packages/core/test/diagnostics-coverage.test.ts` runs `parse -> resolve ->
 * compile` and covers every `1xxx`/`2xxx`/`3xxx` code, but `@sgl/core` imports
 * nothing from the workspace (DD-00 §2 rule 1), so it cannot reach `@sgl/theme`
 * or `@sgl/render-svg` to check theme/renderer codes itself. This file runs
 * the whole pipeline — parse through render, via `runPipeline` (Stage G) — and
 * owns `SGL5xxx` (theme) and `SGL6001` (renderer) instead.
 *
 * Before Stage G, both codes' half of the gate had gone stale: the core-only
 * test's allowlist comment said theme "is not yet wired to the corpus" and the
 * renderer "has no tests yet" — true when written, false since Stage D and
 * Stage F respectively, but nobody reconnected the check, so `SGL5004`
 * (`checkout.sgl`'s `@style.stroke: $hot`) and `SGL6001`
 * (`injection/js-url-link.sgl`) sat marked unreachable for two stages after
 * they had a real corpus fixture — exactly the drift this gate's own
 * anti-regression check exists to catch, caught here by actually running it.
 * `SGL5001`, `SGL5002`, `SGL5003`, `SGL5005`, `SGL5006` are still unreachable,
 * but for a different, still-true reason than the stale comment gave: each
 * fires on a defect in a *theme document* (an extends cycle, depth over 8, an
 * unknown token), not in a `.sgl` document, and both built-in themes are
 * well-formed — no corpus fixture, however malformed itself, can reach them.
 * `@sgl/theme`'s own suite (`cascade.test.ts`) exercises them directly against
 * hand-built `ThemeDoc`s instead.
 */
const NOT_YET_REACHABLE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'SGL5001',
  'SGL5002',
  'SGL5003',
  'SGL5005',
  'SGL5006',
]);

const OWNED_CODES: readonly DiagnosticCode[] = (Object.keys(CATALOGUE) as DiagnosticCode[]).filter(
  (c) => c.startsWith('SGL5') || c === 'SGL6001',
);

const THEMES: readonly ThemeDoc[] = [neutralLight, neutralDark];
const DOCS = listCorpusDocs();

describe('diagnostics coverage gate, theme + renderer half (DD-09 §3.4, Stage G)', () => {
  const emittedBy = new Map<DiagnosticCode, Set<string>>();

  // `runPipeline` is async (the frozen `LayoutEngine.layout` contract returns a
  // `Promise`), so the whole-corpus sweep runs once in `beforeAll` rather than
  // at `describe`-body collection time.
  beforeAll(async () => {
    for (const doc of DOCS) {
      const src = corpusSource(doc);
      for (const themeDoc of THEMES) {
        const { diagnostics } = await runPipeline(src, themeDoc);
        for (const d of diagnostics) {
          if (!OWNED_CODES.includes(d.code)) continue;
          const set = emittedBy.get(d.code) ?? new Set<string>();
          set.add(doc);
          emittedBy.set(d.code, set);
        }
      }
    }
  });

  it.each(OWNED_CODES.filter((c) => !NOT_YET_REACHABLE.has(c)))('%s has a corpus fixture that emits it', (code) => {
    expect(emittedBy.get(code)?.size ?? 0).toBeGreaterThan(0);
  });

  it.each(OWNED_CODES.filter((c) => !NOT_YET_REACHABLE.has(c)))('%s also has a corpus fixture that does not emit it', (code) => {
    expect(emittedBy.get(code)?.size ?? 0).toBeLessThan(DOCS.length);
  });

  it('the allowlist names only codes with no reachable stage yet', () => {
    for (const code of NOT_YET_REACHABLE) {
      expect(emittedBy.get(code)?.size ?? 0, `${code} is reachable now — remove it from NOT_YET_REACHABLE`).toBe(0);
    }
  });
});
