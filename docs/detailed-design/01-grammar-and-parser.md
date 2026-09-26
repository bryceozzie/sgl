# DD-01 — Grammar and Parser

**Package:** `@sgl/core` · **Inputs:** source text · **Outputs:** `ParseResult { tree: Tree; ast: Document; diagnostics }`

Lezer is the single parser (decided). The same grammar drives CodeMirror highlighting, folding and incremental reparse in the editor, and the runtime AST in the pipeline. There is no second parser.

---

## 1. Responsibilities

| Does | Does not |
|---|---|
| Tokenise and parse `.sgl` (a JSON superset) into a Lezer CST | Resolve paths, classes or config keys (DD-02, DD-03) |
| Recover from syntax errors, producing a partial tree | Reject unknown `@` keys (DD-02 — a warning, not syntax) |
| Convert the CST into a typed AST with spans | Distinguish a label string from a class reference in JSON input (DD-02 rule) |
| Emit `SGL1xxx` diagnostics for error nodes | Anything to do with layout or themes |

---

## 2. Grammar

`packages/core/src/grammar/sgl.grammar`, compiled by `@lezer/generator` at build time (DD-10 §3).

```lezer
// A document is either a bare entry list or one anonymous root block —
// the second form is what makes any JSON object a valid SGL document.
@top Document { Block | Entry* }

@skip { space | LineComment | BlockComment | "," }

Entry { ConfigEntry | EdgeStmt | NodeDecl }

// ---- configuration ----------------------------------------------------
ConfigEntry { (ConfigKey | ConfigString) ":" Value }

// ---- nodes ------------------------------------------------------------
NodeDecl  { NodeKey (":" NodeValue)? }
NodeKey   { Identifier | String }
NodeValue { Block | String | ConfigString | ClassRef }
ClassRef  { qualified }                      // A9, I16: `aws.Lambda`
Block     { "{" Entry* "}" }

// ---- edges ------------------------------------------------------------
EdgeStmt  { Endpoint (EdgeOp Endpoint)+ (":" EdgeValue)? }
EdgeValue { String | ConfigString | Block }
Endpoint  { Path Port? }
Port      { "[" Identifier "]" }
Path      { Root? Parent* PathStep ("." PathStep)* }
PathStep  { PathSegment | Wildcard }
PathSegment { Identifier | String }

// ---- values (configuration context only) ------------------------------
Value  { String | ConfigString | Number | Bool | Null | Word | Variable | Array | Object }
Word   { qualified }                         // bareword enum: hexagon, down, dashed; or a class, `aws.Lambda` (I16)
qualified { Identifier ("." Identifier)* }   // lower case: no node of its own, one set of LR states for both
Array  { "[" Value* "]" }
Object { "{" Property* "}" }
Property { PropKey ":" Value }
PropKey  { Identifier | String | ConfigKey | ConfigString }  // @-keys allowed inside class bodies

Bool { @specialize<Identifier, "true" | "false"> }
Null { @specialize<Identifier, "null"> }

@tokens {
  space        { @whitespace+ }
  LineComment  { "//" ![\n]* }
  BlockComment { "/*" blockRest }
  blockRest    { ![*] blockRest | "*" blockAfterStar }
  blockAfterStar { "/" | "*" blockAfterStar | ![/*] blockRest }

  // A dash is allowed inside an identifier only when followed by an identifier
  // character, so `a->b` lexes as Identifier EdgeOp Identifier, not `a-` `>b`.
  Identifier   { $[A-Za-z_] ($[A-Za-z0-9_] | "-" $[A-Za-z0-9_])* }
  ConfigKey    { "@" Identifier ("." Identifier)* }
  ConfigString { '"' "@" (![\\"\n] | "\\" _)* '"' }
  Variable     { "$" Identifier ("." Identifier)* }   // A9, I16: `$aws.brand`
  String       { '"' (![\\"\n] | "\\" _)* '"' }
  Number     { "-"? @digit+ ("." @digit+)? }
  EdgeOp     { "->" | "<-" | "<->" | "--" }
  // Fan-out over children (*) or descendants (**), optionally narrowed by a name
  // glob with one star: `cam*`, `*-db`, `cam*hd`. Legal only in an edge endpoint,
  // because `Path` appears only in `Endpoint`. `*` and globs are valid in any
  // segment; only `**` must be last, and that is a compile-stage concern, not a
  // syntax one (SGL3004) — the grammar stays permissive so a mid-path `**`
  // still yields a usable partial tree.
  Wildcard   { "*" "*"? | "*" globSuffix | globPrefix "*" globSuffix? }
  globPrefix { $[A-Za-z_] ($[A-Za-z0-9_] | "-")* }
  globSuffix { ($[A-Za-z0-9_] | "-")* $[A-Za-z0-9_] }
  Parent     { "../" }
  Root       { "/" }

  "{" "}" "[" "]" ":" "."
  @precedence { LineComment, BlockComment, Root }
  @precedence { Parent, "." }
  @precedence { Wildcard, Identifier }
  @precedence { ConfigString, String }
}

@detectDelim
```

The block mirrors `sgl.grammar` without its comments. (Until A9 it had drifted: it lacked Stage A's
`ConfigString` and A8's `Variable`, both of which the grammar file has had since.)

### Design notes on the grammar

- **Commas are skipped tokens.** `a: "x", b` and `a: "x" b` are the same document; `[1 2 3]` is a valid array. This is what makes "optional commas" free instead of a grammar case, and it is why JSON parses unchanged.
- **Root braces are optional.** `@top Document { Block | Entry* }` accepts either a bare entry list or one anonymous root block; `buildAst` flattens the block form so both produce the same `Document` AST. This is the rule that makes any JSON object a valid SGL document (06 §4, pitfall 4).
- **Identifiers may contain `-`** (`order-service`) but not begin or end with one. `a->b` and `a -> b` lex identically.
- **`ConfigKey` is one token** including dots, so `@style.stroke` never fragments during error recovery.
- **`Parent` (`../`) is a distinct token from `.`** so `../x.y` is `Parent PathSegment "." PathSegment` with no ambiguity, and `/x.y` is `Root PathSegment "." PathSegment`.
- **`Object` vs `Block`.** Both are `{ … }`. Which one the parser builds is decided by context — after a `ConfigKey ":"` it is an `Object`; as a `NodeValue` it is a `Block`. There is no ambiguity because the preceding token differs. Class bodies inside `@classes` are `Object`s whose keys are `ConfigKey`s, which is why `PropKey` admits them.
- **The `NodeDecl` / `EdgeStmt` prefix.** Both begin with `Identifier`. LR(1) resolves it on the next token: `->` `<-` `<->` `--` `.` `[` continue a `Path`; anything else closes a `NodeKey`. If `lezer-generator` reports a conflict here, the sanctioned fix is a `~endpoint` ambiguity marker on `NodeKey` and `PathSegment`, not a grammar restructure.
- **Edge label after a chain** (`a -> b -> c: "x"`) applies to every edge in the chain (DD-02 §5).
- **`Wildcard` is confined to endpoints by construction**, not by a rule: `Path` is reachable only from `Endpoint`, so `*` cannot appear in a node key, a config key or a value without a second production existing to allow it.
- **A glob is one token, and it has to be.** `cam *` must not mean `cam*`, and `@skip` would make it so. The token also has to be written so the star is always reachable without swallowing a following `->`: `globPrefix` may end in `-` but is always followed by a required `"*"`, and `globSuffix` must end in a name character. That is what keeps `lane1.*->switch` lexing as `Wildcard(*) EdgeOp(->)` and `lane1.order-*->switch` as `Wildcard(order-*) EdgeOp(->)`. An earlier draft that allowed a bare trailing `-` inside the token ate the dash of the arrow.
- **`@precedence { Wildcard, Identifier }` is required.** `cam*` matches `Identifier` as `cam` and `Wildcard` whole; without the declaration `lezer-generator` refuses the grammar with *"Overlapping tokens Identifier and Wildcard used in same context"*. Wildcard wins, and that is sound because `*` appears nowhere else in the language — any position where a `Wildcard` matches at all is a glob.
- **One star per segment, and no glob on `**`.** Both fall out of the token shape rather than needing a rule: `a*b*c` and `cam**` simply do not lex, and surface as `SGL1002`. The alternatives `"*" "*"?` (bare) and `globPrefix "*" globSuffix?` (glob) cannot combine.
- **A wildcard in a non-final position parses.** `lane1.*.handler` and `store*.api*` are well-formed `Path`s, and since the human decision of 2026-09-24 (language spec §3) they are valid endpoints too: DD-03 §3.1 expands them. `platform.**.api` parses just as well and becomes a faithful AST; DD-03 §3.1 rejects it with `SGL3004` (`**` is final-only), spanning the edge statement. No grammar change was needed for the decision: `PathStep { PathSegment | Wildcard }` already admitted a wildcard in every step. This follows the same line as unknown `@` keys — the grammar describes shape, the later stages describe meaning — and it is what lets the editor keep highlighting the rest of the line while the author is mid-edit.
- **Multi-line strings** (`"""`) are **⟶ v1.0 (A18)**. The `String` token reserves `\` escapes now: `\n \t \" \\ \uXXXX`.
- **Variables need no grammar beyond `Variable`** (A8). `Variable { "$" Identifier }` is a `Value` alternative, so `$name` is legal exactly where a value is and nowhere else: a `$` in a node key, a config key or a path is a syntax error (`SGL1002`), which is how "keys, paths and names are never substituted" (language spec §5) is enforced. `${name}` interpolation, and a string that is exactly `$name` (canonical JSON's spelling), are read by the resolver out of an ordinary `String`'s decoded text (DD-02 §3.5), not by the lexer, so a JSON document needs nothing new either. There is **no escape for `$`**: `\$` is an unknown escape (`SGL1004`, kept as written), so a literal `${name}` cannot be written as text. Adding one (`$$` or `\$`) is a grammar and language-spec decision, left open.
- **Qualified names (A9, I16; human decision 2026-09-25).** `ClassRef` and `Word` are `Identifier ("." Identifier)*` (the shared rule `qualified`), a **production**, so `lambda: aws.Lambda` and `@type: [aws.Lambda, b.c.D]` parse; the `Variable` token is `"$" Identifier ("." Identifier)*`, so `$aws.brand` is one token. `buildAst` joins a `Word`'s or `ClassRef`'s `Identifier` children with `.`: the `@skip` set may sit between the parts, as in a `Path`, so `aws . Lambda` is `aws.Lambda`. A `Variable`'s name is its text after `$`. What a qualified name *means* is DD-02 §10.3; the grammar only lets it be written. There is still no qualified node key, config key or path form (paths already had dots).

### Qualified names: the token audit (A9, I16)

This project has been bitten by Lezer token precedence before (Stage A's `ConfigString`; the glob token eating an arrow's dash). So the I16 change was audited token by token, and then proved against every document that already exists.

**What changed.** No new token. Two productions grew a tail: `ClassRef` and `Word` are both the anonymous rule `qualified { Identifier ("." Identifier)* }`, which puts no node of its own in the tree (so a one-part name is still `ClassRef(Identifier)`, exactly as before) and lets both share one set of LR states. One token grew a tail (`Variable`: `("." Identifier)*`). No `@precedence` was added, because no new overlap between two tokens arises. The one overlap the change newly *exercises* was already declared.

**Cost, and the token that was not added.** The parse tables grew by about 0.35 kB gzipped (core bundle 178 667 → 179 017 B; the `Variable` tail is 2 B of it, the productions the rest). DD-02 §10.9 had estimated under 0.1 kB. Writing the two tails as separate productions cost 27 B more. A single token, `QualifiedName { Identifier ("." Identifier)+ }` with `@precedence { Wildcard, QualifiedName, Identifier }` and `ClassRef`/`Word` as `Identifier | QualifiedName`, measured about 0.11 kB smaller, and was **rejected**: `QualifiedName` shares a token group with `Identifier`, the precedence applies in every state where that group is active, and an edge endpoint `a.b -> c` at the start of a statement lexed as one `QualifiedName` instead of `Identifier "." Identifier`. The parse pins below failed for 23 existing documents (`checkout.sgl`, `nesting-3.sgl`, `wildcard-globs.sgl`, …) before anything else noticed. That is the precedence trap this audit exists for.

**Where `"."` is now valid that it was not before**, and every token that can start at a `.` there:

| After | `"."` newly valid? | Other tokens starting with `.` that are valid there | Resolution |
|---|---|---|---|
| a `ClassRef`'s `Identifier` (the end of a `NodeDecl`) | yes | `Parent` (`../`), which starts the next entry's `Path` | `@precedence { Parent, "." }`, which already existed: `a: Service` then `../b -> c` still lexes `Parent` (pinned by `grammar.test.ts`). A lone `.` there was a syntax error before, and now continues the name. |
| a `Word`'s `Identifier` in a `ConfigEntry` at document or block level | yes | `Parent`, as above | the same precedence |
| a `Word` inside an `Array` or an `Object` | yes | none (`Parent` only starts an `Entry`) | — |
| a `Variable` | no: the token itself now consumes `.ident` | — | see below |

**Every production the shadowed tokens appear in.** The tokens whose reading can change are `"."` and `Parent` (above), and `Identifier`, which the tails consume after a dot.

- **`"."`** appears in `Path` (`PathStep ("." PathStep)*`), and now in `ClassRef` and `Word`. It is also inside the `ConfigKey`, `Number` and `Variable` tokens. Those are single tokens, unaffected by the parser's use of `"."`. `Path` is reachable only from `Endpoint`, and an `Endpoint` never directly follows a `ClassRef` or a `Word`: there is always an entry boundary in between, and an entry never starts with `"."`.
- **`Parent`** appears only at the start of `Path`. Its precedence over `"."` is what keeps a following `../` an edge (the table).
- **`Identifier`** appears in `NodeKey`, `ClassRef`, `Port`, `PathSegment`, `Word` and `PropKey`, and through `@specialize` in `Bool` and `Null`. After `ClassRef "."` or `Word "."` only `Identifier` is valid.
  - `Wildcard` (`@precedence { Wildcard, Identifier }`) is valid only in a `PathStep`. So `a: b.cam*` is `b.cam` then an unexpected `*`, just as `a: b` followed by `.cam*` was an error before.
  - `true`, `false` and `null` lex as `Bool`/`Null` in a value, so `true.x` is not a `Word`, before or after. `resolve()` refuses them as an `as` name (`SGL2011`), so no namespace needs them.
- **`Number`** (`"-"? @digit+ ("." @digit+)?`) starts with a digit or `-`, never with `.`, and an `Identifier` never starts with a digit. So `@x: a.5` is an error, as before.
- **`Variable`'s tail** cannot shadow anything in a valid document. `Variable` is only a `Value`, and nothing that may follow a `Value` (`}`, `]`, another `Value`, a `PropKey`, an `Entry`, the end) starts with `.`, except `Parent`. The token cannot eat that: in `$a../b` it ends at `$a`, because its `.` must be followed by an identifier character. It overlaps no other token, since only `Variable` starts with `$`.

**The proof.** Before the grammar changed, `packages/core/test/grammar-trees.test.ts` pinned every committed corpus document (`malformed/` and the rest, 61 files), the app's example and the e2e fixture. It pins the whole CST, as node names and ranges with error nodes included (`__goldens__/trees/`), and `parse()`'s AST and syntax diagnostics (`__goldens__/ast/`). These were committed on their own, against the old grammar (`e65dda4`). They are byte-identical after the change, as is every other golden in the repository (resolve, compile, layout, render). `lezer-generator` reports no conflict.

---

## 3. AST

`packages/core/src/ast.ts`. Built from the CST by `buildAst(tree, source)`; every node carries `span`.

```ts
type Ast =
  | Document | ConfigEntry | NodeDecl | EdgeStmt
  | Endpoint | PathExpr | Block
  | StringLit | NumberLit | BoolLit | NullLit | Word | ArrayLit | ObjectLit | Property;

interface Document   { kind: 'Document'; entries: readonly Entry[]; span: SourceSpan }
type Entry = ConfigEntry | NodeDecl | EdgeStmt;

interface ConfigEntry { kind: 'ConfigEntry'; key: readonly string[]; value: Value; span; keySpan: SourceSpan }
                         // key: ['style','stroke'] for @style.stroke — the '@' is dropped

interface NodeDecl   { kind: 'NodeDecl'; key: string; keySpan: SourceSpan;
                       value?: Block | StringLit | Word; span }   // Word = class reference

interface EdgeStmt   { kind: 'EdgeStmt'; endpoints: readonly Endpoint[];
                       ops: readonly EdgeOp[];                     // ops.length === endpoints.length - 1
                       value?: StringLit | Block; span }
type EdgeOp = '->' | '<-' | '<->' | '--';

interface Endpoint   { kind: 'Endpoint'; path: PathExpr; port?: string; portSpan?: SourceSpan; span }
interface PathExpr   { kind: 'PathExpr'; root: boolean; parents: number;
                       segments: readonly PathStep[]; span }

type PathStep = NameStep | WildcardStep;
interface NameStep     { kind: 'Name'; value: string; span }
interface WildcardStep { kind: 'Wildcard'; depth: 'children' | 'descendants';
                         prefix: string; suffix: string; span }
                         // '*'      => children,    prefix '',    suffix ''
                         // '**'     => descendants, prefix '',    suffix ''
                         // 'cam*'   => children,    prefix 'cam', suffix ''
                         // '*-db'   => children,    prefix '',    suffix '-db'
                         // 'cam*hd' => children,    prefix 'cam', suffix 'hd'

interface Block      { kind: 'Block'; entries: readonly Entry[]; span }

type Value = StringLit | NumberLit | BoolLit | NullLit | Word | Variable | ArrayLit | ObjectLit;
interface StringLit  { kind: 'String'; value: string; span }   // escapes already decoded
interface NumberLit  { kind: 'Number'; value: number; span }
interface BoolLit    { kind: 'Bool'; value: boolean; span }
interface NullLit    { kind: 'Null'; span }
interface Word       { kind: 'Word'; value: string; span }     // 'aws.Lambda': parts joined by '.' (I16)
interface Variable   { kind: 'Variable'; name: string; span }  // '$aws.brand' => 'aws.brand' (A8, I16)
interface ArrayLit   { kind: 'Array'; items: readonly Value[]; span }
interface ObjectLit  { kind: 'Object'; props: readonly Property[]; span }
interface Property   { kind: 'Property'; key: string; isConfig: boolean; keySpan; value: Value; span }
```

String decoding: `\n \t \" \\ \/` and `\uXXXX`; any other escape yields `SGL1004` and the backslash is kept literally.

Quoted keys: `"order service": {}` → `NodeDecl.key = 'order service'`. Key text is the decoded string; the resolver is responsible for path escaping (DD-02 §3).

---

## 4. Error recovery and diagnostics

Lezer inserts `⚠` error nodes and continues. `buildAst` walks the tree and:

1. For an `⚠` node that is a **missing** token (zero-length), emits `SGL1001` at that offset and continues building the parent as if the token were present.
2. For an `⚠` node that **wraps skipped input**, emits `SGL1002` over that span and drops the skipped input.
3. For a structurally incomplete parent (e.g. a `NodeDecl` whose `Block` never closed), builds the node from whatever children exist. An unclosed block therefore still yields a `Block` with its entries — this is what keeps the diagram on screen while a brace is missing (FR-E4).

| Code | Severity | Message template |
|---|---|---|
| `SGL1001` | error | Expected `{token}` here. |
| `SGL1002` | error | Unexpected `{text}` — skipped. |
| `SGL1003` | error | Unterminated string. |
| `SGL1004` | warning | Unknown escape `\{c}` in string; kept as written. |
| `SGL1005` | error | Unterminated block comment. |

At most one `SGL1001`/`SGL1002` is emitted per contiguous error region, so a single missing brace does not produce a cascade of diagnostics down the rest of the file. Lezer's recovery already batches this; `buildAst` de-duplicates diagnostics with identical `from`.

---

## 5. Incremental parsing (editor path)

The editor uses `@codemirror/language`'s `LRLanguage.define({ parser })` and gets incremental reparse for free. The pipeline's `parse(source)` is the non-incremental entry point and is what the CLI and tests call.

To avoid parsing twice per keystroke, the application (DD-08 §4) reads the editor's already-parsed `syntaxTree(state)` and calls `buildAst(tree, source)` directly. `parse()` is therefore `buildAst(parser.parse(source), source)`, and the two paths share everything after the tree.

---

## 6. Editor language support (same package, `core/src/editor/`)

Ships alongside the grammar because it is the grammar's other consumer, and keeping them together means they cannot drift.

- **Highlighting**: `styleTags` mapping — `ConfigKey` → `tags.propertyName`, `NodeKey/PathSegment` → `tags.variableName`, `EdgeOp` → `tags.operator`, `String` → `tags.string`, `Number` → `tags.number`, `Word` → `tags.atom`, comments → `tags.comment`, `Port` → `tags.attributeName`.
- **Folding**: `foldNodeProp` on `Block`, `Object`, `Array`.
- **Indentation**: `indentNodeProp` — one level inside `Block`/`Object`/`Array`.
- **Bracket matching**: from `@detectDelim`.
- **Autocomplete**: **⟶ v1.x (E6)**; the hook is a `CompletionSource` that reads the current `DocumentModel` from the app store — nothing in the grammar changes.

---

## 7. Performance

Lezer parses at well over 1 MB/s; a 2 000-node document is ~60 kB and parses in a few milliseconds. `buildAst` is a single pass allocating one object per CST node. The budget for stages 1–3 on a 500-node document is 15 ms (DD-00 §4); parsing is expected to be under 2 ms of it.

---

## 8. Tests (see DD-09 §3)

- **Grammar corpus**: every `.sgl` in `corpus/` parses with zero `⚠` nodes.
- **JSON subset**: every `.sgl.json` in the corpus parses under the *same* grammar with zero diagnostics.
- **Malformed corpus**: each file has an expected diagnostics list (code + span) and an expected *partial AST shape* — the test that guards FR-E4.
- **Property**: for random ASTs printed by the formatter's printer, `buildAst(parse(print(x))) ≡ x` modulo spans. (Formatter is A14/Should; the printer needed here is small and ships with the tests.)
- **Conflict check**: `lezer-generator` fails on an unresolved conflict. The installed 1.x has no `--strict` option, contrary to what this line used to say. CI runs `pnpm grammar` and fails if the regenerated parser differs from the committed one (`.github/workflows/ci.yml`).
- **Parse pins** (A9, I16): `grammar-trees.test.ts` holds every committed document's CST and AST (§2, "Qualified names: the token audit").
