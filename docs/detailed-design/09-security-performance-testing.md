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
| Viewer's CPU | Pathological document (deep nesting, huge counts, layout blow-up) | Parser is linear; 2 MB file cap on open; layout timeout terminates the worker; node-count warning above 2 000 | DD-08 §7, DD-06 §3 | host timeout test; 10 000-node smoke |
| Viewer's local data | Another origin reading IndexedDB | Same-origin by platform; nothing else needed | — | — |
| Viewer's local data | XSS reaching storage | Follows from the first row | — | — |
| Integrity of the app | Supply chain (elkjs, CodeMirror, Preact) | Pinned versions, lockfile, `pnpm audit` in CI, no post-install scripts | DD-10 | CI |

Out of scope for MVP and designed for later: untrusted engine code (**B17** → iframe isolation, DD-06 §3), remote imports (**A9** is same-origin/relative only), server endpoints (**G5** → Turnstile and rate limits).

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

`'unsafe-inline'` for styles is the one concession, and it is why the rendered SVG's `<style>` block must still be generated only from validated values — CSP does not protect a document from its own inline styles.

### 1.3 Exported SVG

An exported file is opened in tools we do not control (browsers, Inkscape, Figma, docs sites). The renderer treats it as hostile territory: no scripts, no event attributes, no external references, links only on the allowlist, and `<a>` elements carry `rel="noopener"`. An SVG that passes the injection corpus in the live view passes it in export, because they are the same string.

---

## 2. Performance

Budgets from [Requirements §4.1](../01-requirements.md#41-performance-budgets), with where each millisecond is spent and the mechanism that keeps it there.

| Budget | Target | Mechanism |
|---|---|---|
| First contentful paint | < 1.0 s | Precached shell (PWA); `lastGoodSvg` from IndexedDB painted before fonts or the worker are ready (DD-08 §9); `elk` chunk lazy — not on the critical path |
| Core bundle, gzipped | < 180 kB | Preact (~4 kB) not React; CodeMirror ~120 kB is the bulk; Lezer runtime ~10 kB; `@sgl/*` core packages ~25 kB; **engines and `elk` excluded by definition** (ADR-0005) — tracked by `size-limit` in CI |
| Keystroke → SVG, 50 nodes | < 60 ms | Sync stages only on the keystroke path (DD-08 §3); layout debounced and off-thread; incremental reparse via the editor's tree |
| Full pipeline, 500 nodes | < 400 ms | `elk` on a 500-node compound graph is typically 100–250 ms; pre-measure delta; string renderer |
| Full pipeline, 2 000 nodes | < 3 s | Same path; chip after 300 ms; `grid` suggested above 2 000 |
| Paint-only theme switch | < 16 ms up to 500 nodes; < 50 ms at 2 000 nodes (Chromium) | DD-08 §3 — **not** a `<style>`-only swap against a retained tree, which DD-07 §11 and execution plan §2.1 (F7) record as not implementable: a theme toggle is a full `render()` plus an `innerHTML` replacement. **Renegotiated 2026-09-23** from a flat `< 16 ms` after Stage H measured `render()` alone at ~1–2 ms (50 nodes), 8–16 ms (500) and 34–54 ms (2 000) across Chromium and Firefox — scaled by size like the other budgets here, with [Requirements §4.1](../01-requirements.md#41-performance-budgets) changed in the same commit. Measured in Chromium, the bench target (§3.1); Firefox's 54 ms at 2 000 nodes is a watch item, not a gate. Measured with the `innerHTML` swap and the layout it forces (Stage I, execution plan §2.1 **F9**), the 2 000-node figure is currently missed (and, with layout counted, so is the 500-node one); the budget stands (human decision, 2026-09-23) and a `morphdom` swap of the live view's wrapper `<g>` is scheduled before Gate 4 (Stage L) |
| Layout timeout | 10 s | Worker terminate + respawn (DD-06 §3) |

### Where it will actually go wrong, and the planned response

| Symptom | First response | Second response |
|---|---|---|
| Keystroke path over budget on large docs | Profile `resolve`/`compile` — the likely cost is `structuredClone` of the `LayoutInput`, which is *not* on the keystroke path; verify | Memoise `resolve` per top-level container (the stages are pure) |
| `innerHTML` swap over 20 ms | Measure at 2 000 nodes | `morphdom` on the wrapper `<g>` |
| `elk` slow on a specific shape of graph | Try `nodePlacement: LINEAR_SEGMENTS` (faster, cruder) | Per-document engine option in the picker; `grid` fallback |
| Pre-measure slow on theme change | Only styles changed, not text — the cache key includes style so this is a full re-measure | Batch `measureText` calls; it is already a tight loop |

Benchmarks (`bench/`) run in CI on the 50/500/2 000-node corpus documents under headless Chromium and fail the build at the *hard ceiling*, warn at the target.

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
| Perf | custom bench in headless Chromium | nightly + release | §2 budgets |
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
| 2. Theme switch without re-layout | Playwright test 3 + hash property 3 + the `neutral-dark ≡ neutral-light` geometry test (DD-04 §8) + the pipeline-level theme-switch test (`packages/render-svg/test/pipeline.test.ts`, Stage G) — the strongest automation of this criterion that exists today: a real `grid` run under both built-in themes produces `toEqual` `LayoutResult`s, not just an equal hash |
| 3. Broken syntax keeps last render, shows squiggle | Playwright test 2 + malformed corpus |
| 4. Open / edit / save round-trip for all three file types | Playwright test 5 |
| 5. Full function offline | Playwright test 7 |
| 6. Share link opens identically in a fresh browser | Playwright test 6 |
