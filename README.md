# SGL — Structured Graphing Language

A text-first diagramming platform. JSON-esque source in, SVG out, with **layout engines and themes as first-class plugins**, running entirely in the browser.

> **Status: skeleton.** The design is complete to component level; the workspace, package boundaries, contracts and fixtures are in place; the pipeline stages are declared but not yet implemented. See [Current state](#current-state).

```sgl
@theme: "neutral-light"
@layout: { engine: layered, direction: right }

@classes: {
  Service: { @shape: round }
  Store:   { @shape: cylinder }
}

payments: {
  @label: "Payments"
  api:    Service
  ledger: Store

  api -> ledger: "writes"
}
```

Keys are containers. Unprefixed entries inside them are children; `@`-prefixed entries are configuration.

## Getting started

```bash
pnpm install && pnpm check
```

| Command | Does |
|---|---|
| `pnpm dev` | Vite dev server for `apps/web` |
| `pnpm check` | `lint` + `typecheck` + `test` — what CI gates on |
| `pnpm build` | Every package, then the app |
| `pnpm grammar` | Regenerate the Lezer parser from `sgl.grammar` |
| `pnpm test` | Vitest (Node) |

Node 20.19+ (`.nvmrc`), pnpm 10.

## Current state

The pipeline's six functions ([DD-00 §4](docs/detailed-design/00-overview.md)) exist as declared, typed signatures. Calling one throws `NotImplemented` naming its design document — deliberately, so an unbuilt stage can never be mistaken for a stage that found nothing.

| Package | Built | Declared, not implemented |
|---|---|---|
| `@sgl/core` | `fnv1a64` hashing · the full [diagnostic catalogue](packages/core/src/diagnostics.ts) (33 codes) · AST, document-model and IR types · the [Lezer grammar](packages/core/src/grammar/sgl.grammar), which **compiles** | `parse` · `resolve` · `compile` · `toJson` / `fromJson` |
| `@sgl/theme` | The [style-property registry](packages/theme/src/registry.ts) with every `affects` classification · both built-in themes | `resolveTheme` · `styleGraph` |
| `@sgl/measure` | `Measurer` interface, run-based from day one | `CanvasMeasurer` · `premeasure` |
| `@sgl/layout-api` | The [`LayoutEngine` contract](packages/layout-api/src/contract.ts) · worker protocol · engine registry | host · result validation · host fallbacks · conformance suite |
| `@sgl/layout-elk` | Engine descriptor: capabilities, options and hints schemas | the elkjs adapter |
| `@sgl/layout-std` | `grid` descriptor | `grid` layout |
| `@sgl/render-svg` | XML escaping · link-scheme allowlist · the `Shape` interface | `render` · the seven shapes |
| `apps/web` | The two-pane shell | everything in [DD-08](docs/detailed-design/08-application.md) |

Also in place: 15 corpus documents plus 23 error and injection fixtures ([`corpus/`](corpus/README.md)), the [import-boundary and determinism lint rules](eslint.config.js) from DD-00 §2–§3, and [CI](.github/workflows/ci.yml).

**Next:** the phase-0 spike — `parse`, `compile`, `grid`, minimal SVG out — which exists to confirm the pipeline shape is right.

## Repository layout

```
packages/
  core/          @sgl/core          grammar, parser, resolver, IR, diagnostics
                                    Zero DOM. No workspace dependencies.
  theme/         @sgl/theme         property registry, cascade, geometry/paint hashes
  measure/       @sgl/measure       Measurer interface + canvas implementation
  layout-api/    @sgl/layout-api    engine contract, worker host, fallbacks, conformance
  layout-elk/    @sgl/layout-elk    DEFAULT engine: elkjs adapter (ADR-0005)
  layout-std/    @sgl/layout-std    grid (MVP)
  render-svg/    @sgl/render-svg    StyledGraph + LayoutResult -> SVG
apps/
  web/                              the SPA (Preact + signals, CodeMirror 6, Vite)
corpus/                             shared fixtures — every test level draws on these
bench/                              perf harness against the DD-09 §2 budgets
```

`@sgl/plugin-sdk`, `@sgl/cli`, `@sgl/text`, `@sgl/lsp` and `apps/worker` are later phases; their directories do not exist until they have code.

Dependency direction is strictly downward and enforced by lint: `core` knows nothing about layout; `layout-*` knows nothing about rendering; `render-svg` knows nothing about the app.

## Documents

| | |
|---|---|
| [01 — Requirements](docs/01-requirements.md) | Goals, personas, functional and non-functional requirements, performance budgets, risks, v1 acceptance criteria |
| [02 — Language spec](docs/02-language-spec.md) | Surface syntax, canonical JSON form, nodes, edges, classes, variables, imports, diagnostics |
| [03 — Architecture](docs/03-architecture.md) | The nine-stage pipeline, package layout, layout-engine plugin API, theme system, renderer, Cloudflare deployment, testing |
| [04 — Feature backlog](docs/04-feature-backlog.md) | 136 features from comparable tools, triaged — 51 Must, 38 Should, 40 Could, 7 declined — plus the revised delivery plan |
| [05 — Design review](docs/05-design-review.md) | Is the concept durable, sustainable and maintainable? Seven findings |
| [06 — Feasibility and MVP](docs/06-feasibility-and-mvp.md) | Check against the original brief, the corrected MVP, eight pitfalls resolved, and the technology stack |
| [Detailed design](docs/detailed-design/00-overview.md) | Component-level design for the MVP: grammar, resolver, IR, theme, measurement, layout host and engines, renderer, application, security/perf/testing, build/deploy |

### Decision records

- [ADR-0001 — Distinguishing configuration from children](docs/adr/0001-config-key-sigil.md)
- [ADR-0002 — Where the layout engine boundary sits](docs/adr/0002-layout-engine-boundary.md)
- [ADR-0003 — Deterministic text measurement](docs/adr/0003-deterministic-text-measurement.md)
- [ADR-0004 — Scope of the determinism guarantee](docs/adr/0004-scope-of-determinism.md)
- [ADR-0005 — elkjs is the default layout engine](docs/adr/0005-default-engine-elkjs.md)

## The three ideas the design turns on

1. **Semantic graph, layout, and theme are rigorously separate.** The engine never sees a colour; the theme never sees a coordinate. Every plugin boundary is a boundary between two of these.

2. **Themes split metrics from paint.** Changing a fill re-runs the renderer only — no re-measure, no re-layout. Changing a font size invalidates layout. That split is what makes a theme switch land in one frame instead of reflowing the diagram.

3. **Text measurement is deterministic everywhere.** Precomputed font metrics rather than `canvas.measureText`, so the browser, the CLI, and the Cloudflare Worker produce byte-identical SVG. This is what makes golden-file testing, caching, and reproducible CI renders possible at all.

## Open questions

### Found while scaffolding

Three defects and one correction, all in normative documents. None blocks the phase-0 spike; the first two block the claim that any JSON object is a valid SGL document.

1. **Quoted `@`-keys do not parse as configuration.** `ConfigEntry { ConfigKey ":" Value }` ([DD-01 §2](docs/detailed-design/01-grammar-and-parser.md)) matches only the bareword `@type` form. In canonical JSON every key is quoted, so `"@type": ["Datastore"]` falls through to `NodeDecl`, whose value may not be an array — a parse error. Scalar cases are worse: `"@title": "x"` parses silently as a *node named `@title`*. This breaks FR-L1 (JSON superset) and FR-L6 (canonical round-trip), and the canonical document in [language spec §9](docs/02-language-spec.md) does not parse. `corpus/json-form.sgl.json` reproduces it. The fix is a quoted-config-key token with precedence over `String`.

2. **`$variable` has no token.** [Language spec §5](docs/02-language-spec.md) defines `$name` and `${name}`; the grammar has neither. `${name}` is unaffected because it lives inside a string, but `@style.stroke: $hot` does not parse — and that appears in the worked example, which [DD-09 §3.2](docs/detailed-design/09-security-performance-testing.md) makes the app's default document. Variables are A8, deferred to v1.0, but the grammar is the *single* parser for both runtime and editor, so the token is cheaper to add now than to re-cut later. `corpus/checkout.sgl` reproduces it.

3. **DD-00 §2 rule 2 contradicts DD-05 and DD-07.** Rule 2 says `measure` and `render-svg` import only `core`, but `premeasure` takes a `StyledGraph` and `render` takes a `StyledGraph` plus a `ResolvedTheme` — both from `@sgl/theme`. Either the rule needs amending to "core, plus theme for types", or `StyledGraph` belongs in `core` alongside the other cross-package data. The lint config currently permits `@sgl/theme` in both, and says so.

4. **`lezer-generator` has no `--strict` flag** ([DD-10 §3](docs/detailed-design/10-build-and-deploy.md)). It fails on grammar conflicts by default, so the intent holds; the flag is dropped from the script.

Good news from the same pass: **the grammar compiles without conflicts, and parses 13 of the 15 corpus documents clean** — including three-level nesting, every edge operator, ports, parallel edges, self-loops, unicode keys, and wildcard endpoints with name globs. The two failures are exactly the defects above.

### From the design

- `@` sigil for configuration keys — unfamiliar to Mermaid users. See [ADR-0001](docs/adr/0001-config-key-sigil.md).
- Implicit node creation from edge references (A11): convenient, but typos silently become nodes. Currently Could.
- `checkout.sgl` uses `@shape: cloud`, which is not one of the seven shapes the MVP renderer draws. Under the MVP it falls back to `rect` with an `SGL3001` warning — fine as a fixture, worth deciding deliberately.

**Resolved:** default engine is **elkjs** ([ADR-0005](docs/adr/0005-default-engine-elkjs.md)); the in-house `layered` engine moves to the roadmap.

**Resolved:** G11 — the VS Code extension is scoped to **preview only** (a webview rendering SVG via `@sgl/core`), so it carries no language-intelligence cost and does not depend on the LSP. G12 remains the upgrade path.
