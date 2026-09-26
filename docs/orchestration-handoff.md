# Orchestration handoff

**Purpose.** This is a restart point for a new orchestrator session if the current one is lost. It covers:

- the state of the build;
- the work in flight;
- the decisions already made;
- how this project is run.

It **does not replace** [07 — Execution plan](07-execution-plan.md) §2 and §2.1. Those remain the authoritative record of the build and of the open findings; read them first. This file adds what 07 doesn't hold: in-flight branches, pending next steps, and working practices.

*Last updated: 2026-09-25 by the orchestrator (cloud session). `main` = `672948a` (plus this note). A18 branch 1 status added 2026-09-26 by its implementer (§2); A18 branch 2 status added 2026-09-26 by its implementer (§2); A18 branch 3 status added 2026-09-26 by its implementer (§2).*

---

## 1. Where the build is

- **Gate 3 (MVP) is cleared** by human decision (2026-09-24). Recorded exceptions:
  - Figma and Safari were waived;
  - the PWA install check is delayed until a release, not waived;
  - GitHub CI has never run (the human chose not to pursue this).
- **Stage L is in progress.** On `main`, merged `--no-ff` and each verified from clean by the orchestrator:

  | Item | What |
  |---|---|
  | Stage J / K | Files, share, offline; the elk adapter |
  | Wildcards in parent segments | `store*.api* -> x` |
  | F17 | SVG renders in Inkscape |
  | F19 | Large documents are never half-parsed |
  | F9 | Theme fast path: met on a quiet machine, marginally. **The row stays open** |
  | F21 | Layout host re-posts the request on respawn |
  | Golden re-baseline | F7 + F14 + F18 |
  | A8 | Variables, plus the F3 cycle guard |
  | C5 | high-contrast and print themes, with theme `force` |
  | D6/D7 | PNG export and clipboard |
  | D2 | Exported SVG embeds Inter |

- **Last full clean check on `main`** (`672948a`): 3664 Vitest (unit + browser, Chromium), 86/86 e2e (Chromium), core bundle 178.91 kB of 180 kB.

## 2. In flight (pushed; nothing is only local)

### A9 `@imports`: branch `feat/imports` (not merged)

**Status: MERGED to `main` at `c2a5c3e`** (2026-09-26), after orchestrator verification from clean (4875 Vitest, 95/95 e2e, core 179.63 of 182 kB). Next: A18, starting with `feat/a18-grammar` from `main`. The earlier status follows for the record: fix round 1 was complete and awaiting verification. The branch head is the commit that carries this line, or a later one on `feat/imports`. Fix round 1 answered the three reviews (16 items) with human decisions H1 (I14 for documents with `@imports` only), H2 (a share group resolves only within itself) and H3 (core limit 182 kB, its own commit); core bundle **179.63 kB** of 182 kB. 07 §2 has the round's paragraph; §2.1 F23 is new (a keystroke in a document importing 12 000 nodes costs what 12 000 nodes cost).

- **Design:** DD-02 §10 (I1–I22, I31, I32) and DD-08 §15 (I23–I30) on that branch.
- **Human decisions (2026-09-25):**
  - relative paths resolve against the user's **stored documents**;
  - Share bundles imports (`i=`);
  - an unresolved import is a warning;
  - all five flagged items accepted:
    - **I16** qualified names `ns.Name` / `$ns.name` in the grammar;
    - **I14** no `.` in a document's own class names;
    - **I17** every import failure is a warning;
    - **I21** shared expansion budget;
    - **I29** a share link adds a document group.
- **Commits so far:**
  - `21b3383`: lazy Documents ▾.
  - `e65dda4`: pinned every existing document's CST/AST.
  - `3423b9b`: the I16 grammar.
  - `544fe6d`: wip, stopped over the size limit (180.13 kB).
  - `45e1f9e`: **step A**. At the orchestrator's decision, all import machinery moved into the lazy `@sgl/core/imports` entry. Core is now **178.94 kB**.
  - `053d48d`: `corpus/imports` and a file-system host.
  - `3a8e074`: records carry `fileName` and group; the title skips imported containers.
  - `e3072ec`: the lazy imports chunk, index, host and pipeline gate.
  - `0ef0f65`: Share bundling `i=` and group storage.
- **Stopped by the human mid-work** (2026-09-25), just before writing `apps/web/e2e/imports.spec.ts`; resumed 2026-09-26.
- **Finished on resumption** (each commit pushed): `main` merged in (`c306cdb`); `e2e/imports.spec.ts` (8 cases), an offline case and a CSP case; the test-plan audit's gaps (Share's closure, the visibility refresh, exact cap edges, a warm-cache double run over `corpus/imports/`, a capped cache entry not reused elsewhere); the keystroke bench (`bench/imports/`, 1.8–2.0 ms per keystroke, lookups only); docs (spec §2/§5/§8/§11, DD-02, DD-03, DD-08, DD-09 §1.1 and §2, 07 §2, Stage L and F20 rows; DD-01's audit was already complete). Core bundle **179.47 kB**. DD-02 §10.8 and DD-08 §15.5 map every test-plan item to a test.
- **Still to do:**
  - **the orchestrator's verification**: a clean check, a size check, and a proof that no golden changed;
  - **review**: three Opus reviewers covering design conformance, mutation testing, and rules/security;
  - triage, at most two fix rounds, then merge `--no-ff`.
- **Before resuming, check** whether the human wants it resumed. They interrupted it.

**Update 2026-09-26.** Phase 2 was completed at `667f6d2`, orchestrator-verified from clean (4462 Vitest, 95/95 e2e, 179.47 kB), and reviewed by three agents. Two blockers were found: a nested import failure still produces errors (I17), and a failed import makes compile quadratic (56 s at 16 000 edges). **Fix round 1 is in flight**, sent to the same implementer: 16 items plus these human decisions:
- **H1**: I14 applies only to documents with `@imports` (the implementer's narrower scope is accepted).
- **H2**: a document from a share group resolves imports **only within its own group**, never the recipient's own documents (security).
- **H3**: the core bundle limit is raised **180 → 182 kB** in a separate commit. The hard ceiling stays 300 kB.

After the fix round: re-verify, then merge `--no-ff`. The `wip` commit `544fe6d` stays as a documented exception; `main`'s first-parent history is still green. Then A18, whose boot-path cost now fits under 182 kB.

**A18 part 1 (`feat/a18-grammar`) merged to `main` at `0ba4339`** (2026-09-26; one review, one fix round; 5050 Vitest, 98/98 e2e, 180.38 of 182 kB). Next: `feat/a18-text` (parser, runs, measurement, wrapping; T58's `unicode.sgl` and `multiline.sgl` compile-golden updates belong there), then `feat/a18-render`.

**A18 part 2 (`feat/a18-text`): complete and pushed; awaiting orchestrator verification; not merged**
(2026-09-26, from `main` `33af6e7`). Scope as briefed: `@sgl/text` (types, faces, keys, `labelBox`,
both line models), `@sgl/core/inline` (T5–T14), the `TextRun` flags, `contentInsets`/`labelMaxWidth`
in core, node sizing, the two boot gates and the lazy `rich-text` chunk (the app half of T53 moved
here from branch 3 by the brief). For the reviewer:
- **Goldens:** only T58's two compile goldens changed (`unicode.sgl`, `multiline.sgl`). New
  documents live in `corpus/text/` with rich-pipeline compile/grid/elk goldens; the `CLEAN_DOCS`
  suites keep compiling without the parser, and `markdown-scan.test.ts` proves the parser changes
  no other document (corpus, app example, n50/n500/n2000).
- **Found and fixed:** the theme registry had no `maxWidth` row, so `@size.maxWidth` never reached
  geometry (SGL5003). **Found, open (§19 item 10):** a class's `@size` validates but never sizes a
  node (DD-04 step 6 is inline only), so it does not wrap; a language question for the human.
- **Interim rendering** (until `feat/a18-render`): a parsed label is drawn as its runs' plain text,
  markers removed; a wrapped label is laid out wrapped but drawn on its hard lines.
- **Size:** 181.22 kB of 182 (+0.84 kB); the render branch has 0.78 kB. The lazy chunk is 2.01 kB.
- DD-11 §19 items 1, 2, 6, 7 fixed; 3, 5, 8 remain (render branch's), 9 found and fixed, 10 and 11
  found (10 open).
- Next: `feat/a18-render` (T42–T50, fonts, T57), from `main` once this merges.

**A18 part 3 (`feat/a18-render`): complete and pushed; awaiting orchestrator verification; not merged**
(2026-09-26, from `feat/a18-text` at `24e5638`, so it merges with branch 2; merge `origin/feat/a18-text`
in when its fix round is done — the fix round's H1/H2, degraded mode and linear breaker need no
change here: the renderer only reads the lines a table entry holds, and a miss or plain runs draw
hard lines). Scope as briefed: T42–T50, the fonts (T26, T49), T56–T57, render goldens, §19 items 3,
5, 8. For the reviewer:
- **Goldens:** no existing golden changed (the test pipeline passes the table to `render()`). New:
  rich render goldens for `multiline.sgl` and `text/*.sgl` × 4 themes; `injection/markdown-in-label.sgl`.
- **New dependency:** `@fontsource/ibm-plex-mono` 5.3.0, OFL-1.1 (licence at
  `public/fonts/OFL-IBM-Plex-Mono.txt`). Inter 700/italics come from the existing `@fontsource/inter`.
- **Deviations from DD-11:** only boxed labels are looked up in the table (unboxed ones are their
  hard lines by construction; no hashing on render); the app renders with the table its landed
  layout was sized from; `r-code`'s family is `CODE_FONT_FAMILY` verbatim (spaces after commas);
  `structureHash`'s marks are an extra length-framed field. T60's Firefox half not run (no Firefox here).
- **For the human:** execution plan §2.1 **F24** (the rendered ascent 0.8 em vs measured 1 em in
  Chromium: labels 2.4–2.6 px higher than measurement's baseline; fixing it re-baselines every render
  golden). F9: `n2000-rich` theme switch 48/54 ms (reported, not gated; budget 50).
- **Size:** **181.82 kB** of 182 (+0.60 kB: fonts 0.14, renderer 0.46); 0.18 kB left.

### A18 markdown labels: branch `design/a18-text` at `8ca91c9` (design only, not merged)

**Status 2026-09-26: branch 1, `feat/a18-grammar`, is complete and pushed; awaiting orchestrator
verification; not merged.** From `main` `31db16c` with `design/a18-text` merged in (so merging it
brings DD-11 too). Scope as T60 branch 1: the `"""` token, T17 dedent, the `\*`/`` \` `` escapes,
one `SGL1003` for an unterminated `"""`, `scanLexicalErrors`, editor tags, folding and triple-quote
closing, DD-01/spec/DD-11 docs. Human decisions of 2026-09-25/26 applied: the subset, markdown
always on for `@label` (T13), a fixed `@size.width` wraps (T36), the full font set (T26), a lazy
`rich-text` chunk (T55), core limit 182 kB. For the reviewer:
- **Audit corrections to DD-11 T16** (DD-01 §2): `"""` in a key or path is `SGL1002` because of a
  shared Lezer token group, not because the lexer skips it; and `"""k""": v` at an entry start was
  three valid pre-A18 nodes. No committed document is affected (92 CST/AST pins byte-identical).
- **No existing golden changed.** T58's `unicode.sgl` change is branch 2's. `multiline.sgl`'s new
  compile golden will change in branch 2 the same way.
- **Size:** 180.38 kB of 182 (this branch +0.68 kB; T54 estimated 0.20–0.25). Branches 2–3 have
  1.62 kB. If branch 3 does not fit, that is a human budget decision.
- Next: `feat/a18-text` from `main` once this merges.

- **Design:** DD-11 `docs/detailed-design/11-text.md` (T1–T60).
- **Human decisions (2026-09-25):**
  - subset = `**bold**`, `*italic*`, `` `code` ``, `\n` and `"""` breaks, wrapping at `@size.maxWidth`;
  - markdown is **always on for `@label`** (T13);
  - a fixed `@size.width` also wraps (T36);
  - the **full font set**: Inter 700, Inter italic 400–700, IBM Plex Mono 400/700, lazy and precached (T26);
  - a **lazy `rich-text` chunk**, and the 180 kB limit stays (T55).
- **Sequencing:**
  - A18's grammar branch starts **after A9's grammar is on `main`**.
  - Whichever merges second must re-run `pnpm grammar`; never hand-merge generated parser files.
- **Plan:** `feat/a18-grammar` → `feat/a18-text` → `feat/a18-render` (T60).
- **Budget risk:** A18 needs about 0.8–1.05 kB at boot. After A9 there may not be room. If so, take measured numbers to the human: more lazy-loading, or raise the budget. The budget is a human decision.
- DD-11 §19 lists eight contradictions it found in existing docs. Fix them in the A18 branches.

## 3. Remaining Stage L after A9/A18

Rough order, orchestrator's call:

- **B5 engines:** `fixed` first, `force` last.
- **F2** drag-and-drop.
- **F5** `.sglpack` (pairs with A9).
- **Rest of E17:** delete, rename, tabs.
- **F12:** multi-tab service-worker update.
- **F13:** hashchange share import via reload.
- **F16:** edges through titles under elk.
- **F15:** measure elk against the DD-09 budget in the browser before Gate 4.
- **F20:** bundle headroom.
- **F6:** ports are unreachable (unowned).
- **F10:** per-document seed.
- **F9:** re-measure before Gate 4.

Gate 4 requires **every Must** in 04 plus the DD-09 bench budgets.

## 4. How this project is run (the human's standing instructions)

- **Roles.**
  - The orchestrator does **not** write feature code.
  - It briefs **Opus** implementers, each in their own worktree (Agent tool, `model: "opus"`, `isolation: "worktree"`, background).
  - It **verifies independently before reading the prose**: every task maps to a file in the diffstat, it runs a clean check itself, and every gate item maps to a named test.
  - It then runs **three parallel Opus reviewers**, read-only, one lens each. For a small change, one reviewer is proportionate.
  - It triages, sends fix lists to the **same** implementer (SendMessage), allows **at most two fix rounds**, then merges `--no-ff`, re-checks `main`, and updates 07 §2 / §2.1.
- **Decision rules.**
  - **The orchestrator decides** anything reversible that doesn't change a product promise. It records each decision in the commit message and 07.
  - **The human decides:**
    - budgets and MVP criteria;
    - anything that re-baselines every golden;
    - the language spec, ADRs, new runtime dependencies, security posture;
    - dropping a Must;
    - any choice between two defensible options with product consequences.
  - Batch escalations, each with a recommendation.
- **Pushing:** the human has authorised pushing all work (branches, and `main` after merges). Also push `main` to `claude/sgl-orchestrator-setup-3xsluo`.
- **The standard clean check.** Run it yourself, in full, before every merge:

  ```
  export PLAYWRIGHT_BROWSERS_PATH=/home/user/pw-browsers && rm -rf .tsbuild packages/*/dist apps/*/dist node_modules/.vite && pnpm lint && pnpm typecheck && pnpm build && pnpm size && pnpm generate:corpus && pnpm generate:bench-fixtures && pnpm generate:grid-fixture && pnpm exec vitest run --project unit --project 'browser (chromium)' && SGL_E2E_PORT=<free port> pnpm test:e2e
  ```

- **Traps this project has hit:**
  - **Stale `dist/`:** `pnpm build` must run before tests. `pnpm dev` also needs `pnpm build` first (README says so).
  - **Line endings:** CRLF files exist (e.g. `docs/03-architecture.md`, `eslint.config.js`, `packages/core/src/hash.ts`). Edit them in binary mode. `git diff --stat` must equal `--ignore-cr-at-eol --stat`.
  - **Lezer grammar:** any new token needs `@precedence` and an audit of every production it shadows. Pin the corpus parse before changing it.
  - **Seams:** unit tests on each half of a seam aren't enough. Require a pipeline- or e2e-level assertion.
  - **Agent claims:** they overclaim. Verify against the diff and make them show each test failing first.
  - **Flakes:** "flake" is never a root cause (see F21: it was a real host bug).
  - **Merges:** a branch based on an older `main` can conflict in `docs/07-execution-plan.md` rows. Resolve by keeping both sides, then run the full check on the merged tree before pushing.

## 5. Cloud-environment notes

- **Playwright's CDN is blocked** (`cdn.playwright.dev` returns 403). Only Chromium is available. Playwright 1.63 expects build 1243, so `/home/user/pw-browsers` holds symlinks aliasing the pre-installed Chromium 1194 as 1243:
  - `chromium_headless_shell-1243/chrome-headless-shell-linux64/*` points to `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/*`, with `chrome-headless-shell` pointing to `headless_shell`;
  - `chromium-1243/chrome-linux64/*` points to `/opt/pw-browsers/chromium-1194/chrome-linux/*`;
  - each directory needs `INSTALLATION_COMPLETE` and `DEPENDENCIES_VALIDATED` marker files.

  Recreate the symlinks if the container is fresh.
- **Firefox and WebKit** have never been verified in this environment.
- **Inkscape:** `apt-get install -y inkscape` works here (1.2.2), for T5-style checks.
- **The theme bench** (`pnpm bench:theme`) is load-sensitive. Run it only on a quiet machine: check `uptime`, and make sure no other vitest or playwright is running.
