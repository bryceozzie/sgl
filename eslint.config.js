// Flat config. Encodes the two rule sets that DD-00 §2 and §3 make normative:
// the import-boundary rules, and the determinism ban.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** DD-00 §3 — "no Math.random, no Date.now" in any package below apps/web.
 *  Stands in for the named `sgl/no-nondeterminism` rule until it is packaged
 *  as a plugin; the banned surface is identical. `performance.now` joined the
 *  ban in Stage H's fix round (item 9): DD-06 §3 has exactly one sanctioned
 *  read of it (the worker protocol's `ms` telemetry field, never fed back into
 *  anything an engine produces) — banning it too, with one inline
 *  `eslint-disable-next-line` at that call site, makes "there is only one
 *  exception" mechanical instead of a convention someone has to remember. */
const noNondeterminism = {
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Non-deterministic. Use ctx.random() (DD-00 §3).' },
    { object: 'Date', property: 'now', message: 'Non-deterministic. Time must be injected (DD-00 §3).' },
    {
      object: 'performance',
      property: 'now',
      message: 'Non-deterministic (DD-00 §3). The one sanctioned exception is worker-runtime.ts\'s ms telemetry — disable inline with a reason if this really is that call site.',
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'Date', message: 'Non-deterministic. Time must be injected (DD-00 §3).' },
  ],
};

/** DD-00 §2 — dependency direction, enforced in CI. */
const boundaries = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

const NO_PREACT = { group: ['preact', 'preact/*', '@preact/*'], message: 'DD-00 §2 rule 5: only apps/web may import preact.' };
const NO_DOM_PKG = { group: ['@sgl/render-svg', '@sgl/layout-*', '@sgl/measure', '@sgl/theme'], message: 'DD-00 §2 rule 1: core imports nothing from the workspace.' };

export default tseslint.config(
  { ignores: ['.claude/worktrees/**', '**/dist/**', '**/node_modules/**', '**/*.parser.js', '**/*.parser.terms.js'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['packages/**/*.ts'],
    rules: { ...noNondeterminism, ...boundaries([NO_PREACT]) },
  },

  // 1. core imports nothing from the workspace.
  {
    files: ['packages/core/**/*.ts'],
    rules: boundaries([NO_PREACT, NO_DOM_PKG, { group: ['@sgl/core*'], message: 'Use a relative import inside core.' }]),
  },

  // 2. theme, layout-api, render-svg, measure import only core.
  //    measure and render-svg additionally consume @sgl/theme, because DD-05 §4
  //    takes a StyledGraph and DD-07 takes a StyledGraph plus a ResolvedTheme.
  //    DD-00 §2 rule 2 as worded does not allow this — see README, open questions.
  {
    files: ['packages/theme/**/*.ts', 'packages/layout-api/**/*.ts'],
    rules: boundaries([NO_PREACT, { group: ['@sgl/*', '!@sgl/core'], message: 'DD-00 §2 rule 2: this package may import only @sgl/core.' }]),
  },
  {
    files: ['packages/measure/**/*.ts', 'packages/render-svg/**/*.ts'],
    rules: boundaries([NO_PREACT, { group: ['@sgl/*', '!@sgl/core', '!@sgl/theme'], message: 'DD-00 §2 rule 2: this package may import only @sgl/core and @sgl/theme.' }]),
  },

  // 3. Engines import only layout-api and core.
  {
    files: ['packages/layout-elk/**/*.ts', 'packages/layout-std/**/*.ts'],
    rules: boundaries([NO_PREACT, { group: ['@sgl/*', '!@sgl/core', '!@sgl/layout-api'], message: 'DD-00 §2 rule 3: an engine may import only @sgl/layout-api and @sgl/core.' }]),
  },

  // 4. apps/web is the only package that touches the DOM.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly' } },
  },

  // DD-08 §4: "the app never calls `parse` on its own" — the pipeline's `parsed`
  // computed reuses the editor's own tree, and everything else (the pickers'
  // root-config writes included) reads `parsed`. `pipeline.ts` alone may import
  // it, to build the initial tree before any editor exists.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: ['apps/web/src/state/pipeline.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@sgl/core', importNames: ['parse'], message: "DD-08 §4: the app never calls parse on its own; read the pipeline's `parsed` instead." }] },
      ],
    },
  },

  // Test-only code is exempt from the import-boundary and determinism rules:
  // `**/test/**/*.ts` covers not just `*.test.ts` files themselves but the
  // dev-only fixture/harness modules beside them (e.g. `theme/test/corpus.ts`,
  // `render-svg/test/pipeline.ts`) that legitimately need to reach across
  // packages a shipped src/ file may not, to compose a pipeline no single
  // package owns.
  {
    files: ['**/test/**/*.ts', 'bench/**/*.js', 'eslint.config.js', '**/*.config.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-globals': 'off', 'no-restricted-imports': 'off' },
  },

  // bench/generate.js runs as a plain Node script (not bundled, not type-checked
  // by tsc -b), so it needs Node's ambient globals declared explicitly.
  {
    files: ['bench/**/*.js'],
    languageOptions: { globals: { console: 'readonly', URL: 'readonly', AbortController: 'readonly' } },
  },
);
