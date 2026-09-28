# Orchestration handoff

**Purpose.** This is a restart point for a new orchestrator session if the current one is lost. It covers:

- the state of the build;
- the work in flight;
- the decisions already made;
- how this project is run.

It **does not replace** [07 — Execution plan](07-execution-plan.md) §2 and §2.1. Those remain the authoritative record of the build and of the open findings; read them first. This file adds what 07 doesn't hold: in-flight branches, pending next steps, and working practices.

*Last updated: 2026-09-27 by the orchestrator (cloud session): A18 merged to `main` at `1e92015` and verified there from clean (5360 Vitest, 109/109 e2e). **F20 merged** (`0345d73`): core **175.99 kB of 182** (grid descriptor split, terser minifier as a build-time devDependency). Verified on `main` from clean (5366 Vitest, 109/109 e2e, 175.99 kB). **In flight (2026-09-27):** `design/b5-engines` (DD-12: `fixed`, `tree`, `radial`, `force`; design only, decisions for the human), `fix/f16-title-crossings` (elk edges through container titles; only changed-route elk goldens may move), `fix/f12-f13-app` (multi-tab SW update, in-place share import, toast cap), `design/help` (DD-13, in-browser documentation).*

**B5 decisions (human, 2026-09-27; DD-12 on `design/b5-engines` at `877f58b`, being updated to record them):** H1 an unpinned node under `fixed` is packed below the pinned ones and warns (SGL4020); H2 pin coordinates are the top-left relative to the parent's content box (spec change); H3 `force` cut from v1.0 to Could with B21; H4 an engine without the `pins?` capability warns on pins (SGL4021); H5 codes SGL4020/SGL4021 approved; H6 root `@layout` options reach the engine (`checkout.sgl`'s elk goldens may be regenerated); H7 `layered` becomes `elk` in the spec and in `checkout.sgl`; H8 `radial` is `bitwise` with in-house trig (ADR-0004 amended); H9 `tree`/`radial` in a lazy `std-trees` chunk in the worker, `fixed` static. Orchestrator: bare engine names are accepted (bug fix). **F27 decided:** B21 (edge bundling) demoted to Could with `force` (human, 2026-09-27). Branch order: `feat/b5-pin` → `feat/b5-fixed` → `fix/root-layout-options` → `feat/b5-tree` → `feat/b5-radial` → `docs/b5-force`.

**Trap (new):** `pnpm typecheck` (`tsc -b`) writes per-file JS into `packages/*/dist` over the build output; running it *after* `pnpm build` breaks the next app build until you rebuild. The clean-check order (typecheck before build) avoids it.

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

**A18 (markdown labels, wrapping, rich rendering) MERGED to `main`** (2026-09-27): `feat/a18-text` and `feat/a18-render` merged together (`--no-ff` of `feat/a18-render` at `343e8d2`, which contains `feat/a18-text` `94f3491` via the orchestrator's merge `dfb7a59`). Two reviews per branch, one fix round each; verified by the orchestrator from clean at `343e8d2`: 5360 Vitest, 109/109 e2e, core **181.97 kB of 182 (30 B left)**. Only T58's two compile goldens changed on `main` (`unicode.sgl`, `multiline.sgl`); all other A18 goldens are new.
- Human decisions applied: H1 (a fixed width splits a word only when `maxWidth` is set), H2 (a class's `@size` applies to its nodes); new dependency `@fontsource/ibm-plex-mono` (OFL, T26); new code `SGL6002` (rich-text chunk failed to load; degraded, not frozen).
- Orchestrator decisions: a boxed label missing from the landed layout's table draws from the latest table (brief vertical overflow rather than a one-line sideways spill); run faces also load when a style (not markup) asks for weight >600 or italic; the `labelRunKey` memo and `textBlock`'s unused width estimate removed to stay under 182 kB.
- **F25** (rendered ascent 0.8 em vs measured): **human decision 2026-09-27, leave it for now**; fold into the next render-golden re-baseline made for another reason. **F20** (30 B of headroom after A18) was cleared by `feat/boot-headroom`: 6.01 kB left. F24 (canvas cache thrashes past ~7 000 wrapped labels) recorded with a proposed remedy.
- T57 on this machine: `n2000-labelled` 31.3 / 32.7 ms, `n2000-rich` 44.9 / 43.7 ms (markup ~12 ms); reported, not gated; F9's quiet-machine measurement before Gate 4 stands.

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


**In-browser help (human request and decisions, 2026-09-27):** "documentation in the browser to look up @ keys, see examples and basic information". D1 a Help drawer for quick lookup plus a separate help page for detail; no editor hover. D2 facts generated from code (key registry, catalogue, engine descriptors, themes, shapes); hand-written prose and examples, every example checked by a test. D3 snippets with a rendered preview and "Open as new document". D4 a **Must for v1.0** (Gate 4). Design (DD-13) in flight on `design/help`.

**Help decisions, round 2 (human, 2026-09-27; DD-13 `design/help` at `998ef03`, being updated):** HD1 an in-app view at `#help/<kind>/<name>`; HD2 Copy, not Insert; HD3 a Help link on each diagnostics row; HD4 prose for every diagnostic code, plus a proved example per document-reachable code; HD5 no keyboard shortcut; HD6 first visit opens the drawer at Quick start without moving focus. `@style: dashed` (a non-object `@style`) **warns SGL2011; the spec, corpus (checkout, chains), first-run example and comment are rewritten to `@style: { strokeDash: … }`** (branch `fix/style-shorthand`; the checkout/chains render goldens re-baseline because the edges now draw dashed). The spec and 01 are fixed to match the code: edge `@width`→`@style.strokeWidth`, `@surface.raised`→a real token, "Applies to" follows the registry, `@a11y.role`/`@icon` not in v1.0, FR-Y8 `elk`, criterion 1 five engines.

**Practice (2026-09-27): machine load breaks timing tests.** With four agents running suites at once (load ~18 on 4 cores), `main`'s full check failed on a *different* absolute-time test each run (`wrap.test` linear breaker, `imports.test` 16 000 edges, `variables-limits.test` 20 000 variables). `wrap.test` was hardened (best of three, 400 ms; commit `6f39b3d`). Rules from now: at most **two** implementers at once; run orchestrator verification runs when the machine is quiet (check `uptime`); treat a timing-test failure under load as unproven, and re-run quiet before calling anything green or red. The other absolute-time tests are candidates for the same best-of-three hardening.

**Status 2026-09-27 (later):** awaiting orchestrator verification or review: `fix/f16-title-crossings` `bdc471c` (fix round 1 done; +823 B over main, accepted by the orchestrator against its own +600 B cap; `wildcards` keeps 4 crossings, F16 stays open for it), `feat/help-reference` `63e25ea` (+54 B), `feat/b5-pin` `08eb7b0` (+0.39 kB; needs one review: engine notes → host → diagnostics). In fix round 1: `fix/f12-f13-app` (two data-loss blockers from review). **Watch:** `apps/web/e2e/rich-text.spec.ts:52` (an empty computed font-family) failed once under load in two agents' runs and passed on repeat; investigate, do not call it a flake. The elk bug found by b5-pin (an edge from a node declared after a titled container into it fails conformance check 6) is queued as a separate task.

**Merged 2026-09-27:** `feat/help-reference` (`63e25ea`) and `fix/f16-title-crossings` (`bdc471c`) into `main` (`b2dae52`, after the human's own deploy commits `52ee6d9`..`51eb761`: Wrangler + a GitHub Actions workflow). Verified on `main` from clean: 5423 Vitest, 109/109 e2e, core **176.88 kB of 182**. In flight: `fix/f12-f13-app` fix round 1; a review of `feat/b5-pin`; `fix/style-shorthand` (help branch 0).

**Merged:** `feat/b5-pin` (`f70df02`, B5 branch 1) into `main` (`e488c39`); the tree is identical to the verified branch. Core 176.96 kB. Next B5 branch: `feat/b5-fixed` (starts when an implementer slot frees; at most two at once). `e2e/large-document.spec.ts:79` (3 000-node edit) is load-sensitive: it failed at load 17 and passed 3/3 when quiet.

**Merged:** `fix/style-shorthand` (`7dd9254`) into `main` (`2e5cedb`). **In flight:** `feat/b5-fixed` (B5 branch 2; `packCells` refactor committed at `a1d35b1`) and `fix/f12-f13-app` (fix round 1 done at `52391f5`; merge of `main` committed at `e9b2079`, re-running checks). Both were stopped by an API usage limit (reset 10:10 UTC) and resumed at 12:01. Next: `feat/help-content` (help branch 2) when a slot frees. Note: the Wrangler stub `src/index.ts` was deleted by the human's `51eb761`, and `main`'s lint is clean.

**Merged:** `fix/f12-f13-app` (`70843ad`) into `main` (`281c173`); core 178.03 kB (+1.07 kB accepted; the update path must stay on the boot path, DD-08 §12). **B5 decisions (human, 2026-09-27):** root-level pins fix positions **relative to each other** (the drawing is framed to fit; spec §4 wording to change); new code **SGL4022** (info) "N more layout warnings not shown" when the host caps engine notes at 100. `feat/b5-fixed` (`88403cb`; review: no blockers, 14/14 mutations killed) is in fix round 1 with these. `feat/help-content` in progress. **Budget forecast:** ~179.1 kB after `fixed`; tree/radial lazy plumbing + help ≈ +0.5–1 kB at boot; tight against 182.

**Human decisions (2026-09-27, later):** F29: keep spec §9's container engine and **build B8 (per-container engines) sooner**. F31: a **new warning code for an unknown `@theme`** is approved. **Merged:** `feat/b5-fixed` (`7d77b63`). **Finished, awaiting verification:** `feat/help-content` `2bd7217` (contains `7d77b63`); `fix/root-layout-options` `5dfc16f` (179.50 kB; merges second, so the help prose on root options and `@direction` must then be updated per P21). Both agents were lost to a container restart after pushing.

**Merged (2026-09-28):** `feat/help-content` (`9f47545`) and `fix/root-layout-options` (`671b3d3`; core 179.5 kB). **In flight:** `fix/unknown-theme` (F31, SGL5007, +129 B accepted; finishing), `feat/b5-tree` (B5 branch 4, lazy `std-trees` chunk), `design/b8-container-engines` (DD-14, design only). **Load-sensitive tests seen so far:** `wrap.test` (hardened), `imports.test` 16 000 edges, `variables-limits.test` 20 000 vars, `naming-memo` n2000, `host.test` "a params object with a million keys" (timeout at load 11.6; 5/5 when quiet), `e2e/large-document.spec.ts:79`, `e2e/rich-text.spec.ts:52`. **All hardened** on `test/harden-timing` (see the last entry).

**Human decisions (2026-09-28), B8 / DD-14 (`design/b8-container-engines` `c7807b4`):** all recommendations accepted: (1) a container naming an engine always gets its own layout, even the parent's engine; (2) boundary options work as root options, unset ones inherit from the nearest enclosing same-engine scope; (3) keys on a container without its own engine are hints to the surrounding engine, an ignored one is SGL4010; (4) crossing edges: elk routes to a fixed port on the box and the host adds a straight leg, grid/fixed straight; **ADR-0002 amended** (host composes; `ctx.sublayout` stays reserved for B9); (5) **SGL4012 and SGL4013 approved**, and DD-14's proposed spec text approved; (6) the B8 composer is lazy, and **the core limit is raised to 184 kB** (hard 300 unchanged). **Verified:** `main` `9c543c8` from clean (120/120 e2e). **Finished:** `feat/b5-tree` `537b31c` (+385 B, core 179.98 kB; `std-trees` chunk 3.17 kB). New findings F32 (elk `root` id collision) and F33 (failed lazy import cached).

**2026-09-28:** merged `design/b8-container-engines` (DD-14 decided, `44f50d0`) and `feat/b5-tree` (`9b3d9e5`; core 180.03 kB of 184). **In flight:** `feat/b8-compose` (B8 branch 1, fix round 1 plus a merge of `main` for tree check 7 and a tree-in-grid golden; branch verified clean at `624b569`), `feat/b5-radial` (B5 branch 5). **Next:** `feat/b8-wire`, help branches 3–5 (content-2, drawer, page), `docs/b5-force` (the backlog note), F30, F32–F35 triage, the load-sensitive test hardening pass.

**Merged:** `feat/b8-compose` (`86a3659`; core 180.07 kB). The orchestrator merged `main` into it once, when the classifier refused the agent's merge; the human authorised merges on agents' branches. Add `layout-std/test/tree.test.ts` "grows linearly … best of five" to the load-sensitive list. **Next:** `feat/b8-wire` (B8 branch 2); `feat/b5-radial` in flight.

**B5 complete (2026-09-28):** `fixed`, `tree`, `radial` all merged (`radial` at `910ef62`; core 180.19 kB of 184). `docs/b5-force` is not needed: the backlog split (`force` = B22, Could) landed with DD-12's design merge. **In flight:** `feat/b8-wire` (B8 branch 2), `fix/elk-root-id` (F32). **Next:** help branches 3–5 (`feat/help-content-2`, `feat/help-drawer`, `feat/help-page`), then B8 branches 3–4 (`feat/b8-ports`, `perf/b8-cache` if measured), F30, F33–F36, and the load-sensitive test hardening pass.

**Merged:** `fix/elk-root-id` (F32) at `762e01b`; verified on `main` (6901 Vitest + the 2 load-sensitive tests 3/3 when quiet, 129/129 e2e; core ≈180.26 kB of 184). **In flight:** `feat/b8-wire` (B8 branch 2), `test/harden-timing` (the load-sensitive tests, plus the `rich-text.spec.ts:52` investigation).

**Merged:** `feat/b8-wire` (B8 branch 2, `59211ec`; core 181.14 kB of 184). Per-container engines now work for users; F29 cleared; new F37 (`__proto__` node name breaks `compile()`). **In flight:** `feat/help-drawer` (help branch 4), `test/harden-timing`. **Next:** `perf/b8-cache` (needed: 200 elk boxes ≈ 3 s; DD-14 C32, and degrading under time pressure noted in §11.2), then `feat/b8-ports`, `feat/help-content-2`, `feat/help-page`.
**Load-sensitive tests hardened (2026-09-28, `test/harden-timing`, not merged):** every test on the list above is hardened — `imports.test` 16 000 edges, `variables-limits.test` 20 000 vars, `host.test` million keys, `naming-memo` n2000, `tree.test` grows linearly, `e2e/large-document.spec.ts:79`, `e2e/rich-text.spec.ts:52` — plus the other corpus-wide renders near the 5 s default and elk K10. Node timings are CPU time, best of three, setup in `beforeAll`; each still fails its reintroduced regression (07 §2). `rich-text.spec.ts:52` was a real race (a read of a tspan that a later render had detached), now read atomically and polled. **Product finding for triage:** after an edit that adds markup, a frame with the rich labels unmeasured (nodes at minimum width) is drawn before the measured one when the run faces are slow (07 §2). A timing failure under load is no longer expected from these tests; treat one as a real regression and re-run quiet to confirm.

**Human instruction (2026-09-28): use Sonnet sub-agents unless the task is complex;** Opus only for complex work (new engines, composer or protocol changes, security-sensitive seams, and reviews of those). Small fixes, doc passes, merges and follow-ups: Sonnet. `main` `d657551` verified from clean (7225 Vitest, 133/133 e2e, 181.14 kB of 184). In flight (Opus, started before this instruction): `feat/help-drawer`, `perf/b8-cache`.

**Human instruction (2026-09-28): pause development once running tasks finish.** Let the two in-flight agents (`feat/help-drawer`, `perf/b8-cache`) finish and push their branches; then start nothing new - no verification, review, merge or queued branch - until the human says to resume. On resume: verify each of those two branches from clean, review, merge, then continue the queue (`feat/b8-ports`, `feat/help-content-2`, `feat/help-page`, findings F30, F33, F35-F38).
**Paused state:** `feat/help-drawer` finished and pushed at `acf80f4` (branched from `900f93b`, not merged; agent reports 2 clean runs, 6945 Vitest, 142/142 e2e). To check on resume: boot 180.84 kB, only 14 B under its +0.6 kB line and `main` has moved; `@sgl/core/imports` is now its own lazy `imports-*.js` chunk fetched on help open; outside clicks do not close the drawer (DD-13 P39 over the brief); a theme switch re-renders previews in full. `perf/b8-cache` still running.
