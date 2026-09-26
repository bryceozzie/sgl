# DD-09 — Security, Performance and Testing

Cross-cutting design for the MVP. Each section names where the mechanism lives and what verifies it.

---

## 1. Security

### 1.1 Threat model

The MVP has no server, no accounts and no third-party code. The attack surface is **content**: a document, theme or share link crafted by someone other than the viewer.

| Asset | Threat | Mitigation | Where | Verified by |
|---|---|---|---|---|
| Viewer's browser session | Script execution from document text (labels, keys, links, tooltips, class names) in the live view or in an exported SVG opened elsewhere | Every string reaches markup through exactly one escaping function per context; no `<foreignObject>`; no `innerHTML` of anything but renderer output — including the renderer's own earlier output for the same document, read back from this origin's IndexedDB (DD-08 §5 J6 boot paint; §9 requires `lastGoodSvg` to hold only `render()` output) | DD-07 §8 | injection corpus, XML-parsed |
| Viewer's browser session | `javascript:` / `data:` links | Scheme allowlist; disallowed links removed with `SGL6001` | DD-07 §8 | injection corpus |
| Viewer's browser session | CSS injection via style values (`fill: url(...)`, `expression()`) | Colours and lengths validated by type in the property registry before they exist; font families quoted; anything else rejected `SGL5004` | DD-04 §3 | registry type tests |
| Viewer's CPU / memory | Decompression bomb in a share link | Hard 2 MB inflated cap; abort and toast | DD-08 §8 | unit test with a crafted payload |
| Viewer's CPU / memory | Exponential variable expansion ("billion laughs": `v1: [$v0, $v0]`, `v2: [$v1, $v1]`, … — 2^n values or characters from a few hundred bytes) | Values computed only on use; a per-document expansion budget of 2 Mi units (one per value copied by `$name`, one per character produced by `${name}`, the same 2 MB-equivalent as the document and share-link caps); past it one `SGL2016` error and the value dropped, never a hang or a `RangeError` | DD-02 §3.5 | `variables-limits.test.ts`: doubling chains at n = 40 (array and string form) under 50 ms, 2^12 used 2 000 times hits the cap; `corpus/unresolved/variable-expansion.sgl` |
| Viewer's CPU / memory | A document whose PNG export (D6) would need a canvas too large to allocate. A 2 MB document can declare `@size: { width: 1e6 }`, and a 3× PNG of it would be gigapixels | A PNG is refused before anything is fetched or drawn when a side would exceed 16 384 px or the total 8192² ≈ 67 Mpx; a toast names the limit and a scale that fits | DD-08 §7 | `png.test.ts`; `e2e/png-export.spec.ts` (both caps, Save and Copy) |
| Viewer's browser session | Rasterising for PNG export (D6) loads the diagram as an image document | The `<img>` gets a `blob:` URL of our own `render()` output (the same trust as `lastGood.svg`, first row) with Inter embedded as `data:` fonts fetched from our own origin. An SVG drawn as an image runs no script and loads nothing external in any browser, so this adds no new capability to document text | DD-08 §7 | `e2e/csp.spec.ts` |
| Viewer's clipboard | Copy SVG / Copy PNG (D7) write to the system clipboard | Only on the user's click on that item, and only our own output: `lastGood.svg` as text, or its PNG. The app never *reads* the clipboard. The browser's own permission and user-activation rules apply, and a refusal is a toast | DD-08 §7 | `e2e/png-export.spec.ts` |
| Viewer's browser session | Script or markup from an imported document (A9): a stored document's text is untrusted content, like any document, even when it is the user's own, since it may have arrived in a share link | An import adds no capability: its text is parsed by core's own `parse()` and goes through the same resolve, compile and escaping path as the importer's (DD-07 §8); no network, no script, no new markup | DD-02 §10.4 I22 | injection corpus (the path is shared); `e2e/csp.spec.ts` loads the `imports` chunk and makes an `i=` link under the policy |
| Viewer's privacy / network | An `@imports` path that fetches (`https:`, `file:`, `//host`) | Relative paths only: anything else is `SGL2025` and skipped. The host's `lookup` is synchronous and reads only the stored-document index, so it cannot fetch | DD-02 §10.4 I19 | `imports-limits.test.ts` (every form), `import-host.test.ts`, `corpus/imports/remote.sgl` |
| Viewer's local data | A share link plants documents that change how the recipient's *other* documents resolve their imports (A9) | A link's bundled documents are stored as new documents in a group of their own, found first by their own group and never by any other document; the recipient's documents are never replaced, and resolve exactly as before | DD-02 §10.1 I4, DD-08 §15.3 I29, I30 | `import-host.test.ts` (groups), `boot.test.ts`, `e2e/imports.spec.ts` (the recipient's own `classes` unchanged) |
| Viewer's CPU / memory | Import bombs (A9): a diamond chain (`D1` imports `D2` twice, `D2` imports `D3` twice, …) is exponential; cycles; deep chains; large imported sources; each import bringing its own expansion budget | Per root resolve: depth 8, 64 import instances, 2 Mi code units of imported source, and **one** 2 Mi variable-expansion budget for the whole closure; the import that would cross a cap is skipped with one `SGL2020` per cap; a cycle is `SGL2019` and skipped. Parse and per-import resolve are memoised in a cache that keeps what the last two runs used | DD-02 §10.4 I20, I21 | `imports-limits.test.ts` (exact edges; diamond n = 30 in milliseconds; the shared `SGL2016`), `corpus/imports/too-many.sgl`, `cycle-a.sgl` |
| Viewer's CPU / memory | Decompression bomb or malformed bundle in a share link's `i=` (A9) | `i=` is inflated under its own 2 MB cap with the same sliced reader as `s=` (4 MB for a whole link), at most 64 entries, each with string `n`, `t`, `s`; a bad bundle is dropped with a toast and the main document still opens | DD-08 §15.3 I28 | `share.test.ts`, `boot.test.ts` |
| Viewer's CPU | Pathological document (deep nesting, huge counts, layout blow-up) | Parser is linear; 2 MB file cap on open; layout timeout terminates the worker; node-count warning above 2 000 | DD-08 §7, DD-06 §3 | host timeout test; 10 000-node smoke |
| Viewer's local data | Another origin reading IndexedDB | Same-origin by platform; nothing else needed | — | — |
| Viewer's local data | XSS reaching storage | Follows from the first row | — | — |
| Integrity of the app | Supply chain (elkjs, CodeMirror, Preact) | Pinned versions, lockfile, `pnpm audit` in CI, no post-install scripts | DD-10 | CI |

Out of scope for MVP and designed for later: untrusted engine code (**B17** → iframe isolation, DD-06 §3), remote imports (**A9** is relative only, against the user's stored documents: the rows above), server endpoints (**G5** → Turnstile and rate limits).

### 1.2 Content Security Policy

Served as a header from Cloudflare (DD-10 §5) and mirrored as a `<meta>` for local file previews:

```
default-src 'self';
script-src 'self';
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline';        /* CodeMirror injects its theme styles; nonce-ing them is ⟶ later */
img-src 'self' data: blob:;              /* PNG export round-trips through a blob <img> */
font-src 'self';
connect-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'none';
```

**Implemented (Stage J), `apps/web/build/headers.ts`**: the header is DD-10 §5's `_headers`, emitted into `dist/` by the build; the `<meta>` mirror is injected into the built `index.html` and leaves out `frame-ancestors`, which CSP ignores in a `<meta>` policy (Chromium logs an error for it). `apps/web/test/headers.test.ts` holds the directives to the block above, and `apps/web/e2e/csp.spec.ts` runs the production build under both with no violation.

**PNG export (D6) under this policy.** The rasteriser draws a `blob:` `<img>`, which `img-src … blob:` allows. Removing `blob:` makes `e2e/csp.spec.ts` fail. The WOFF2 files it embeds are fetched from `'self'` (`connect-src`). The `data:` fonts **inside** the SVG image are not subject to the page's `font-src 'self'`: an image document has no policy of the page's, and Chromium reports no violation for them under the real header plus its `<meta>` mirror (`e2e/csp.spec.ts` saves a PNG at every scale and uses both Copy items with no violation, and `png.browser.test.ts` shows that the embedded face is what gets drawn). **No directive changed.** This was checked in Chromium only. Firefox and WebKit are expected to behave the same, since an SVG image document is isolated in every engine, but that has not been run here.

`'unsafe-inline'` for styles is the one concession, and it is why the rendered SVG's `<style>` element (DD-07 §6) must still be generated only from validated values — CSP does not protect a document from its own inline styles.

### 1.3 Exported SVG

An exported file is opened in tools we do not control (browsers, Inkscape, Figma, docs sites). The renderer treats it as hostile territory: no scripts, no event attributes, no external references, links only on the allowlist, and `<a>` elements carry `rel="noopener"`. An SVG that passes the injection corpus in the live view passes it in export, because they are the same string.

---

## 2. Performance

Budgets from [Requirements §4.1](../01-requirements.md#41-performance-budgets), with where each millisecond is spent and the mechanism that keeps it there.

| Budget | Target | Mechanism |
|---|---|---|
| First contentful paint | < 1.0 s | Precached shell (PWA); `lastGoodSvg` from IndexedDB painted before fonts or the worker are ready (DD-08 §9); `elk` chunk lazy — not on the critical path |
| Core bundle, gzipped | < 180 kB | Preact (~4 kB) not React; CodeMirror ~120 kB is the bulk; Lezer runtime ~10 kB; `@sgl/*` core packages ~25 kB; **engines and `elk` excluded by definition** (ADR-0005); the other lazy chunks, `share`, `file-actions` (Open/Save ▾/Share's work, with `@sgl/core/json`), `engine-options-form` (the Options ▾ form; DD-10 §2), `documents-menu` (the Documents ▾ list), `imports` (A9: `@sgl/core/imports`, the stored-document index and host, loaded for a document with `@imports`) and `filename` (shared by `file-actions` and `imports`), are excluded by name — tracked by `size-limit` in CI |
| Keystroke → SVG, 50 nodes | < 60 ms | Sync stages only on the keystroke path (DD-08 §3); layout debounced and off-thread; incremental reparse via the editor's tree |
| Full pipeline, 500 nodes | < 400 ms | `elk` on a 500-node compound graph is typically 100–250 ms; pre-measure delta; string renderer |
| Full pipeline, 2 000 nodes | < 3 s | Same path; chip after 300 ms; `grid` suggested above 2 000 |
| Paint-only theme switch | < 16 ms up to 500 nodes; < 50 ms at 2 000 nodes (Chromium); hard ceilings 50 / 100 ms | **Met on a quiet machine, marginally at 2 000 nodes** (F9, `feat/theme-fast-path`; execution plan §2.1 **F9** watches it). Theme ▾ is a view preference (DD-08 §10): the pick always sets `themeId`, and on a document with no `@theme` that is all it changes, so nothing is re-parsed; `styleGraph` resolves each distinct cascade signature once and reuses per-graph work (DD-04 §5); the render is `renderPaintOnly` (DD-07 §6), which rebuilds only the `<style>` text, guarded by `structureHash`; the canvas swaps that text into the tree it shows (DD-08 §6); nothing is re-measured or laid out; `lastGood.svg` is derived only when read. Measured end to end from a Theme ▾ pick by `pnpm bench:theme` (execution plan §1): slower-pick median `work` on a quiet machine ~2.5 ms at 50 nodes, ~13 ms at 500 and ~44–49 ms at 2 000. At 2 000 nodes ~3–4 ms is script and ~40 ms is Chromium's style recalculation for the new `<style>` text, the floor (replacing even one rule's text costs ~24 ms there), so the **headroom is a few ms, within machine noise**: under load (another test suite running, load ≈ 6) a reviewer measured 50–56 ms at 2 000 nodes and 17.5 ms once at 500. The gate is therefore judged as §3.1 describes. A document that names its own `@theme` is edited by the pick and re-parsed and re-rendered in full: ~65–70 ms at 500 nodes and ~250–275 ms at 2 000, a known cost of the document's own text changing, not gated. **Renegotiated 2026-09-23** from a flat `< 16 ms` after Stage H measured `render()` alone at ~1–2 ms (50 nodes), 8–16 ms (500) and 34–54 ms (2 000) across Chromium and Firefox — scaled by size like the other budgets here, with [Requirements §4.1](../01-requirements.md#41-performance-budgets) changed in the same commit; kept by human decision (2026-09-23). Measured in Chromium, the bench target (§3.1) |
| Layout timeout | 10 s | Worker terminate + respawn (DD-06 §3) |

### Where it will actually go wrong, and the planned response

| Symptom | First response | Second response |
|---|---|---|
| Keystroke path over budget on large docs | Profile `resolve`/`compile` — the likely cost is `structuredClone` of the `LayoutInput`, which is *not* on the keystroke path; verify | Memoise `resolve` per top-level container (the stages are pure) |
| Theme switch over budget | Measure end to end (`pnpm bench:theme`: a Theme ▾ pick as the picker makes it, with and without `@theme` in the document, until the paint's style and layout are forced) and read its breakdown: script, the `<style>` swap, and the style recalculation it causes | Check the paint-only path is taken (the bench asserts it: no `render()`, no `innerHTML`, no pre-measure without `@theme`); past that the cost is Chromium's style recalculation over every element of the diagram. Not `morphdom` on the wrapper `<g>`: measured slower than the `innerHTML` swap at every size (Stage L), and dropped |
| `elk` slow on a specific shape of graph | Try `nodePlacement: LINEAR_SEGMENTS` (faster, cruder) | Per-document engine option in the picker; `grid` fallback |
| Pre-measure slow on theme change | Since F9 a theme switch that keeps the graph and its geometry does not pre-measure at all (DD-08 §3's measure effect: the table would be the same); one that changes text geometry re-measures, and the cache key includes the style, so that is a full re-measure | Batch `measureText` calls; it is already a tight loop |

Benchmarks run on the 50/500/2 000-node corpus documents under headless Chromium, nightly and at release (§3.1), not on every push: `render()` alone prints in the browser tests (`bench/README.md`), and the end-to-end theme switch (`pnpm bench:theme`) is gated as §3.1 describes, on a quiet machine.

---

## 3. Testing

### 3.1 Levels

| Level | Tool | Runs | Covers |
|---|---|---|---|
| Unit | Vitest (Node) | every push | DD-01…07 pure functions; the DOM-free packages run under Node with no shims — this is also the NFR-2 check |
| Golden | Vitest snapshot files, byte-exact | every push | resolver JSON, IR JSON, cascade output, `elk` input/output mapping, SVG |
| Property | `fast-check` | every push | parse/print round-trip; `.sgl.json` round-trip; hash partition invariants |
| Conformance | `@sgl/layout-api/conformance` | every push | both engines (DD-06 §8) |
| Browser | Vitest browser mode (Chromium, Firefox) | every push | `CanvasMeasurer`, worker host, `grid` bitwise cross-browser |
| End-to-end | Playwright (Chromium, Firefox, WebKit) | every push | DD-08 §14 — the editor loop, files, share, offline, font gate |
| Injection | Vitest + `fast-xml-parser` | every push | DD-07 §8 |
| Perf | custom bench in headless Chromium | nightly + release, on demand; **not** every push, and not part of `pnpm check` | §2 budgets. The theme-switch budget (`pnpm bench:theme`) is run on a quiet machine (check the load average; nothing else running) and gated per point on **three samples** in one run, each a full median measurement of the slower pick: the **best** of the three must be under the target, and the **median** of the three under the hard ceiling (50 ms up to 500 nodes, 100 ms at 2 000). All three are reported. Best-of-three because machine load only ever adds time: one quiet sample under the target shows the app can meet it, while a regression moves all three, and the median against the ceiling catches the gross ones |
| Manual gate | checklist | release | open a golden in Inkscape, Figma, Safari; install the PWA; open a `.sgl` from the OS |

### 3.2 Corpus

`corpus/` is the shared fixture set every level draws on. Each document has a purpose, so a failure names what broke:

| File | Purpose |
|---|---|
| `empty.sgl` | zero nodes |
| `single.sgl` | one node, no edges |
| `json-form.sgl.json` | the JSON subset, exercises the label rule and root braces |
| `checkout.sgl` | the language-spec worked example; the default document |
| `nesting-3.sgl` | three levels, edges at every level, `../` and `/` paths |
| `chains.sgl` | every operator, mixed chains, labels on chains |
| `parallel-selfloop.sgl` | parallel edges, self-loops, `<->` |
| `ports.sgl` | all four sides, port-to-port edges |
| `classes.sgl` | inheritance diamond, override order, theme `byClass` |
| `containers-edges.sgl` | edges to containers, boundary-crossing edges (the ELK case) |
| `shapes.sgl` | every built-in shape once |
| `unicode.sgl` | quoted keys with spaces, dots, emoji, RTL text in labels |
| `hidden.sgl` | hidden nodes with edges to them |
| `n50.sgl` `n500.sgl` `n2000.sgl` | generated; perf and scale |
| `malformed/*.sgl` | one syntax error each, with expected diagnostics and partial AST |
| `injection/*.sgl` | one hostile string per context |
| `unresolved/*.sgl` | one resolution error each |

### 3.3 Invariants tested as properties

1. `resolve(parse(toJson(resolve(parse(s)).model))).model ≡ resolve(parse(s)).model` for all `s` in the corpus.
2. For any document, shuffling top-level declaration order leaves the set of node and edge IDs unchanged.
3. For any (document, theme): flipping one paint property changes `paintHash` only; one geometry property changes both.
4. For any `bitwise`/`quantized` engine: two runs on the same input produce byte-identical `LayoutResult`.
5. For any layout: every non-hidden node and edge has geometry; every number is finite (the validator, tested in reverse).
6. For any rendered SVG: parsing it as XML yields no `script` element, no `on*` attribute, and every `href` matches the allowlist.
7. For any compiled document: every `GraphEdge.from.node` and `.to.node` is a key of `graph.nodes` — the general form of "a resolved endpoint of length zero (the document root) must not silently pass as a hit" (DD-03 §2.1, §3).

### 3.4 Coverage policy

Line coverage is reported, not gated. The gate is the corpus: **every diagnostic code in DD-01…07 has at least one corpus document that emits it and one that does not.** A new code without a fixture fails CI via a table check.

---

## 4. Acceptance mapping

| MVP criterion (06 §3) | Automated by |
|---|---|
| 1. 40-node, 3-level doc under both engines; switch changes geometry only | Playwright test 4 + SVG goldens |
| 2. Theme switch without re-layout | Playwright test 3 + hash property 3 + the geometry test that every built-in theme's `geometryHash` equals `neutral-light`'s (DD-04 §8; `neutral-dark`, and since C5 `high-contrast` and `print`) + the pipeline-level theme-switch test (`packages/render-svg/test/pipeline.test.ts`, Stage G) — the strongest automation of this criterion that exists today: a real `grid` run under both built-in themes produces `toEqual` `LayoutResult`s, not just an equal hash |
| 3. Broken syntax keeps last render, shows squiggle | Playwright test 2 + malformed corpus |
| 4. Open / edit / save round-trip for all three file types | Playwright test 5 |
| 5. Full function offline | Playwright test 7 |
| 6. Share link opens identically in a fresh browser | Playwright test 6 |
