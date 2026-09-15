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
| `classes.sgl` | inheritance diamond, override order, theme `byClass` |
| `containers-edges.sgl` | edges to containers, boundary-crossing edges (the ELK case) |
| `wildcards.sgl` | `*` and `**` endpoints: fan-out, descendants, cross product, ports, hidden children, relative and root-absolute wildcards |
| `wildcard-globs.sgl` | name globs: prefix, suffix, both ends, a dash before the star, quoted keys, and the near-misses that must **not** match |
| `shapes.sgl` | every built-in shape once |
| `unicode.sgl` | quoted keys with spaces, dots and emoji; RTL text in labels |
| `hidden.sgl` | hidden nodes with edges to them |
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

Fixtures still to add as the stages that emit their codes land: `SGL1005`,
`SGL2005`–`SGL2008`, `SGL2011`, `SGL2012`, `SGL3002` (has a fixture, needs
expectations), `SGL3005` (needs a generated document past the 1 000-edge expansion
ceiling — it belongs with the `n*` fixtures in `bench/generate.js`),
`SGL4001`–`SGL4011`, `SGL5001`–`SGL5006`.

## A note on `checkout.sgl`

It is reproduced verbatim from the language spec, including `@shape: cloud`, which
is not one of the seven shapes the MVP renderer draws (DD-07 §4). Under the MVP it
falls back to `rect` with an `SGL3001` warning — useful as a fixture, but worth
deciding deliberately rather than by accident.

## Two fixtures the current grammar cannot parse

Both are correct against the language spec; the grammar is what is wrong. See
README → *Open questions → Found while scaffolding*.

| Fixture | Fails on | Why |
|---|---|---|
| `checkout.sgl` | `@style.stroke: $hot` | no `$variable` token in DD-01 §2 |
| `json-form.sgl.json` | `"@type": ["Datastore"]` | quoted `@`-keys are not config entries |

The other eleven documents parse with zero error nodes.
