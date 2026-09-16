# Corpus

The shared fixture set every test level draws on (DD-09 §3.2). Each document has a
single purpose, so a failure names what broke.

| File | Purpose |
|---|---|
| `empty.sgl` | zero nodes |
| `single.sgl` | one node, no edges |
| `json-form.sgl.json` | the JSON subset; exercises the label rule and root braces |
| `checkout.sgl` | the language-spec worked example (02 §9); the app's default document |
| `nesting-3.sgl` | three levels, edges at every level, `../` and `/` paths |
| `chains.sgl` | every operator, mixed chains, labels on chains |
| `parallel-selfloop.sgl` | parallel edges, self-loops, `<->` |
| `ports.sgl` | all four sides, port-to-port edges |
| `classes.sgl` | inheritance diamond, override order, theme `byClass`, ports cascading from a class with inline override |
| `containers-edges.sgl` | edges to containers, boundary-crossing edges (the ELK case) |
| `wildcards.sgl` | `*` and `**` endpoints: fan-out, descendants, cross product, ports (one- and both-sided), hidden children, relative and root-absolute wildcards |
| `wildcard-globs.sgl` | name globs: prefix, suffix, both ends, a dash before the star, quoted keys, and the near-misses that must **not** match |
| `shapes.sgl` | every built-in shape once |
| `unicode.sgl` | quoted keys with spaces, dots and emoji; RTL text in labels |
| `hidden.sgl` | hidden nodes with edges to them, and an edge hidden by its own `@hidden` between two visible nodes |
| `n50.sgl` `n500.sgl` `n2000.sgl` | **generated** by `bench/generate.js`; perf and scale |
| `malformed/*.sgl` | one syntax error each, with the expected diagnostic and a partial AST |
| `injection/*.sgl` | one hostile string per context |
| `unresolved/*.sgl` | one resolution error each |

## The coverage gate

DD-09 §3.4: line coverage is reported, not gated. The gate is this directory —
**every diagnostic code in `packages/core/src/diagnostics.ts` must have at least
one document here that emits it and one that does not.** A new code without a
fixture fails CI via a table check.

The `// expects: SGLnnnn` comment at the top of each error fixture is what that
table check reads.

A document in `malformed/` carries a syntax *diagnostic*, which is not always an
*error node*: `unknown-escape.sgl` lexes as a perfectly good `String` token and
earns its `SGL1004` in the AST builder's string decoder. Assert on the diagnostic,
not on the tree shape.

## Not yet covered

Fixtures still to add as the stages that emit their codes land: `SGL3005`
(needs a generated document past the 1 000-edge expansion ceiling — it belongs
with the `n*` fixtures in `bench/generate.js`), `SGL4001`–`SGL4011`,
`SGL5001`–`SGL5006`, `SGL6001`.

Stage B (resolver) added fixtures for `SGL2005`–`SGL2009`, `SGL2011` and
`SGL2012`. `SGL2009` (a `$variable` used before Stage K substitutes it) also
has a positive fixture in `checkout.sgl` itself — see the note below.

Stage C (compiler) picked up the eight `unresolved/*.sgl` fixtures DD-02 §8
reserved for it (`SGL2001`, `SGL2003`, every `SGL3xxx`) — `resolve()` never
touches path resolution or wildcard expansion, so these were inert until now.
It also emits `SGL1005` and `SGL3002` for the first time from a real document:
`SGL1005` was already reachable through `malformed/unterminated-comment.sgl`
(Stage A wired it, this note had simply gone stale), and `hidden.sgl` — listed
above as "needs expectations" — now gets a real one via `SGL3002`.

A post-review pass on `feat/compiler` added `SGL3006` (a shape the language
knows but this version doesn't draw) and `SGL3007` (an invalid port `side`),
with `unresolved/shape-not-drawn.sgl` and `unresolved/bad-port-side.sgl`
covering each.

## A note on `checkout.sgl`

It is reproduced verbatim from the language spec, including `@shape: cloud`, which
is not one of the seven shapes the MVP renderer draws (DD-07 §4). The deliberate
decision this note used to ask for has been made: `cloud` is one of the language's
twelve recognised shape names (language spec §4), just not a drawn one yet, so it
falls back to `rect` with an **`SGL3006`** ("not drawn in this version") info
diagnostic — not `SGL3001`, which is reserved for a name outside all twelve.
`corpus/unresolved/shape-not-drawn.sgl` (`actor`) covers the code on its own;
`corpus/unresolved/unknown-shape.sgl` (`trapezoid`) still covers `SGL3001`.

Its `@style.stroke: $hot` parses into a `Variable` AST node but is not substituted
— that is Stage B (resolver), not the grammar.
