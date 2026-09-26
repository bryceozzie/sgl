# DD-11 — Text: markdown labels and `@sgl/text`

**Feature:** A18 (markdown in labels), Must. **Packages:** `@sgl/text` (new), `@sgl/core` (grammar,
`"""` strings, the inline parser), `@sgl/measure`, `@sgl/render-svg`, `apps/web`.
**Inputs:** a label's string. **Outputs:** styled `TextRun`s in the IR, a wrapped `TextLayout` in the
measure table, nested `<tspan>`s in the SVG.

**Status: Phase 2 in progress.** Branch 1, `feat/a18-grammar` (2026-09-26), implements T10's decoder
half, T11 and T15–T20. Branch 2, `feat/a18-text` (2026-09-26), implements T1–T10, T12–T14, T21–T41
(T26 as metrics only), T51–T54, T58 and T59, and fixes §19 items 1, 2, 6 and 7. Each carries an
*Implemented* note with its deviations. T42–T50, T55–T57 and the rest of T26 are the render
branch's, and still design. Phase 1 (2026-09-25) was design only. The decisions are numbered
**T1–T60**. Each carries a one-line reason in italics. Decisions marked **⚑** go to the human before
Phase 2 starts; each has options and a recommendation (§18). Where this document changes a type or a
rule in DD-01…DD-10, the change is listed in §17 and made in those documents in the Phase 2 branch
that implements it, not here.

**The human's decision (2026-09-25), which this document implements:**

- `**bold**`, `*italic*` and `` `code` ``.
- Explicit line breaks: `\n` in strings, and the `"""` multi-line strings DD-01 §2 reserves.
- Automatic wrapping at a node's `@size.maxWidth`.
- No links, headings, lists or images. Anything outside the subset stays literal text.

---

## 1. Responsibilities and where the code lives

| Does | Does not |
|---|---|
| Parse the inline subset of a `@label` into styled runs (§2) | Links, headings, lists, images, HTML, underscores (§2, T9) |
| Lex and dedent `"""` strings (§4) | Change what any other string means (§3) |
| Give each run its font face (§6) | Let a theme choose the code font or the bold weight in v1.0 (T27) |
| Break lines greedily at `maxWidth`, keeping run boundaries (§7) | Hyphenate, shape, reorder bidi text or apply kinsoku (T37) |
| Emit one `<tspan>` per styled run inside each line's `<tspan>` (§9) | Draw code-span background plates (T46) |
| Embed the bold, italic and mono faces an export uses (§10) | Subset fonts (DD-07 §9 unchanged) |

- **T1. The inline parser lives in `@sgl/core`, in a new entry `@sgl/core/inline`
  (`src/inline.ts`). `compile()` runs it when a caller hands it in.** The signature becomes
  `compile(model, view?, options?: { inline?: (text: string) => readonly TextRun[] })`. Without
  `inline`, `compile()` builds the plain runs it builds today, but with the new representation (T21).
  *The IR must carry styled runs (DD-03 §6), `@sgl/core` may import nothing from the workspace
  (07 §1), and a separate entry lets the app load the parser lazily (T53), as A8 did with
  `@sgl/core/json`.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `compile(model, view?, options?)` with `CompileOptions { inline? }` (`compile.ts`); `compileImports` passes the options through. `packages/core/src/inline.ts` is the `@sgl/core/inline` entry.
- **T2. `@sgl/text` is a new package that sits between `@sgl/theme` and its two consumers:
  `core, theme ← text ← measure, render-svg`.** It holds the run and layout types (moved out of
  `@sgl/measure`, which re-exports them), the run faces (T25), the table key (`hashRuns`, moved
  out of `@sgl/measure`), `labelRuns`/`labelBox`/`labelRunKey`, and the line models. It needs
  `@sgl/theme` only for the `StyledGraph` type that `labelRuns` reads. *The measure table key has to
  be computed in two places, `premeasure` and now `render()` (T42). One function in a package both
  can import is how the two stay in step. Today it lives in `@sgl/measure`, which `render-svg` may
  not import.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `packages/text` (`@sgl/text`); `eslint.config.js` has the boundary (`core, theme ← text ← measure, render-svg`), and DD-00 §2 and 07 §1 show it. `@sgl/measure` re-exports every moved name. `labelRuns` also moved (with `textStyleOf` and `DEFAULT_TEXT_STYLE`), since `labelRunKey` needs it.
- **T3. `@sgl/text` has two entries.** `@sgl/text` holds the types, faces, keys and the non-wrapping
  line model `layoutLines`, and is on the boot path. `@sgl/text/wrap` holds the word breaker
  `layoutWrapped` and is lazy (T53). *Wrapping is the heavy half, and only documents that set
  `@size.maxWidth` need it.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `src/index.ts` (boot) and `src/wrap.ts` (`@sgl/text/wrap`, in the app's lazy `rich-text` chunk).
- **T4. `contentInsets` moves to `@sgl/core` (`src/shape-insets.ts`), together with its inverse,
  `labelMaxWidth` (T35).** `@sgl/layout-api` and `@sgl/render-svg` import it from there instead of
  keeping their two copies. *The wrap width needs the inverse of the shape insets, and
  `@sgl/measure` can import neither of today's copies. A third copy of a formula that DD-07 §4
  already warns has drifted once would be worse.*

`eslint.config.js`'s boundary rules, DD-00 §2 and 07 §1 change to match T2 in Phase 2 (§17).
  - *Implemented (branch 2, `feat/a18-text`), as written, and one step further:* `packages/core/src/shape-insets.ts` holds `contentInsets` and `labelMaxWidth`. `@sgl/layout-api`'s copy is deleted and `sizing.ts` imports core's; render-svg's `Shape` interface loses its `contentInsets` method (it had no caller outside tests), so there is one copy, not a shared import of two. DD-07 §4 records the interface change.

---

## 2. The inline subset

### 2.1 The rules

- **T5. Delimiters.** `*` delimits emphasis (`em`) and `**` delimits strong emphasis (`strong`). A
  delimiter run is a maximal sequence of unescaped `*` outside a code span. A run of 1, 2 or 3 stars
  is meaningful. Three stars are `**` and `*` together. A run of 4 or more is literal. *These are the
  `*` spellings of the styles a label needs, with the fewest rules.*
  - *Implemented (branch 2, `feat/a18-text`), as written* (`inline.ts`); every rule is in `core/test/inline.test.ts`.
- **T6. Flanking, without intraword emphasis.** `prev` and `next` are the characters on either side of
  the run, or the start or end of the label. *Whitespace* is Unicode `White_Space`, `\n` included.
  *Punctuation* is `\p{P}` or `\p{S}`.
  - A run **can open** when `next` exists and is not whitespace, and `prev` is the start, whitespace
    or punctuation.
  - A run **can close** when `prev` exists and is not whitespace, and `next` is the end, whitespace
    or punctuation.

  This is CommonMark's left-flanking and right-flanking rule for `*`, with one extra condition: a
  letter or digit may not touch the outside of the run. *`a*b*c`, `2*3*4` and `**a**b` stay literal.
  Pre-A18 labels that use `*` as an operator, a wildcard or a footnote mark keep their meaning (T13).
  The cost is that intraword emphasis, `un*frigging*believable`, is not available.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* whitespace is `\p{White_Space}`, punctuation `[\p{P}\p{S}]`, both on code points (an emoji is a symbol).
  - *Fix round 1, item 7:* those property escapes use the **JavaScript engine's own Unicode tables**. A symbol or punctuation mark assigned in a newer Unicode version than an older engine knows is, there, neither punctuation nor whitespace, so a `*` beside it flanks differently: `🫨*x*` could be italic in one browser and literal in another. This is the same class of concern as T37's refusal of `Intl.Segmenter`, much narrower (only newly assigned characters directly beside a delimiter run), and accepted; a pinned table would remove it.
- **T7. Matching, left to right with a stack.** At most one `strong` and one `em` can be open at a
  time.
  - A run that can close does so first. Length 1 closes an open `em`. Length 2 closes an open
    `strong`. Length 3 closes whichever of the two are open, innermost first, and any star it does
    not use is literal text after the close.
  - If the mark being closed is not the innermost open mark, the inner mark's opener becomes literal
    text. Its content belongs to the outer mark only.
  - Otherwise, a run that can open does so: length 1 opens `em`, length 2 opens `strong`, and
    length 3 opens `strong` and then `em`. It opens only if none of the marks it names is already
    open. If one is, the whole run is literal.
  - Anything else is literal.
  - At the end of the label, every opener still open becomes literal text.
  - A hard break (`\n`) does not close anything, so `**Line one\nLine two**` is bold on both lines.

  *It is linear and deterministic, and it cannot nest a mark inside itself. On the common spellings
  (the first rows of §2.2) it agrees with CommonMark. Where marks overlap, or a mark nests in itself,
  it deliberately gives a simpler, predictable answer instead of CommonMark's delimiter
  arithmetic.*
  - *Implemented (branch 2, `feat/a18-text`), as written.* One consequence the §2.2 rows do not show, pinned in the tests: `***` always opens `strong` then `em`, so `***a** b*` demotes the `em` opener and gives `*a`ˢ ` b*`, where CommonMark nests the other way round.
- **T8. Code spans bind first, and nothing is parsed inside them.** A run of N backticks opens a
  code span if a run of *exactly* N backticks follows later on the same line, that is, before the
  next `\n`. Otherwise the N backticks are literal. The content is literal: stars and backslashes
  inside mean nothing. If the content both starts and ends with a space and is not all spaces, one
  space is removed from each end. Code spans are found in a first pass, before T7, and a delimiter
  run never spans one. A code span may sit inside `strong` or `em`, and then carries those marks
  too (T21). *These are CommonMark's code-span rules, minus spanning a line break. Double backticks
  let a label hold a literal backtick (``` ``a`b`` ```).*
  - *Implemented (branch 2, `feat/a18-text`), as written.*
- **T9. Underscores are out.** `_x_` and `__x__` are literal. *Snake_case identifiers are common in
  diagram labels, and CommonMark's intraword exception for `_` still italicises `_id_`. Leaving
  underscores out removes a whole class of surprises for no loss: the subset already has one
  spelling of each style.*
  - *Implemented (branch 2, `feat/a18-text`), as written.*
- **T10. Backslash escapes: only `\*` and `` \` ``.** Outside a code span, `\*` is a literal `*` and
  `` \` `` a literal backtick. Any other backslash is literal, `\\` included. *Pre-A18 labels that
  contain backslashes, such as Windows paths or regexes, keep every one. The only cost is that a
  label cannot put a literal backslash directly before an emphasis delimiter.*
  - *Implemented (branch 1), the decoder's half:* `\*` and `` \` `` reach the model with their
    backslash (T11). The inline parser that consumes it is branch 2.
  - *Implemented (branch 2, `feat/a18-text`), the parser's half, as written:* `\\*` in the model (two backslashes and a star) is a literal backslash and then an escaped star.
- **T11. How the escape gets past the string decoder.** Today `\*` in a `"…"` string is `SGL1004`
  and the decoder keeps it as written. From A18, `\*` and `` \` `` are *recognised* string escapes
  that decode **to themselves**, backslash included, with no diagnostic. The inline parser then
  consumes the backslash. `"\\*"` decodes to the same two characters, and so means the same. In a
  string that is not a label (§3), the backslash stays visible, exactly as it does today, but
  without the warning. *The model keeps plain text, so `.sgl.json` round-trips. `toJson` writes
  `"\\*"`, which is valid JSON. The only visible change for a non-label string is that a warning
  goes away.*
  - *Implemented (branch 1, T11), as written:* `SIMPLE_ESCAPES` maps `*` and `` ` `` to themselves
    with the backslash, in `"…"`, `ConfigString`, quoted keys and `"""` alike, with no `SGL1004`.
    Tested through parse, resolve, `toJson` and `fromJson` (`multiline-string.test.ts`).
- **T12. Nothing else is markup.** `~~x~~`, `[a](b)`, `# h`, `- item`, `1. item`, `![i](u)`,
  `<b>`, `&amp;`, autolinks and trailing-double-space line breaks are all literal text, escaped on
  output like any text (DD-07 §8). *This is the human's decision. Each item left out also removes
  a way for a pre-A18 label to change meaning.*
  - *Implemented (branch 2, `feat/a18-text`), as written* (tested for each construct listed).

### 2.2 Examples (Phase 2 turns each row into a test)

| Label text | Runs (`s` strong, `e` em, `c` code) |
|---|---|
| `**bold**` | `bold`ˢ |
| `*it*` | `it`ᵉ |
| `***both***` | `both`ˢᵉ |
| `**bold *and it***` | `bold `ˢ `and it`ˢᵉ |
| `*it **and bold***` | `it `ᵉ `and bold`ᵉˢ |
| `a*b*c`, `2*3*4`, `2 * 3 * 4`, `*` | literal |
| `**a**b` | literal (the closer touches `b`) |
| `**a**.` · `(**a**)` | `a`ˢ with `.` · `(`, `a`ˢ, `)` |
| `**unclosed` · `*a**` · `**a*` | literal |
| `**a *b** c*` | `a *b`ˢ ` c*` (the inner `*` becomes literal, then the last `*` is unmatched) |
| `*a *b* c*` | `a *b`ᵉ ` c*` (`em` cannot nest in `em`) |
| `` `a*b*` `` | `a*b*`ᶜ |
| `` *see `x`* `` | `see `ᵉ `x`ᵉᶜ |
| ``` ``a`b`` ``` · `` ` x ` `` | `` a`b ``ᶜ · `x`ᶜ |
| `` `open `` | literal |
| `\*not\*` (decoded) | `*not*` |
| `C:\temp\*.log` (decoded) | `C:\temp*.log` (only `\*` is an escape) |
| `snake_case`, `_x_` | literal |
| `Line one\nLine two` | one run, `Line one\nLine two` (T21) |

---

## 3. Which strings are markdown

- **T13. ⚑ Markdown is always on for `@label` values, under the conservative rules of T6–T12, with
  no opt-in.** That covers node, container and edge labels, the string shorthands `api: "…"` and
  `a -> b: "…"`, and `@label` set by a class or through a variable. Everything else stays literal:
  a node's key used as its title when it has no `@label`, `@title`, `@tooltip`, `@a11y.*`, `@link`,
  `@meta`, class names and ports.

  *The language spec already says a label is "text or inline-markup string" (§4). Markup that works
  in every label, with no switch, is what users of any markdown-aware tool will try first.*

  **What can change silently.** A pre-A18 label changes meaning only if it contains a
  space-delimited or punctuation-delimited pair of `*` or `**`, or a pair of backtick runs of the
  same length on one line. T6 keeps `a*b`, `a*b*c`, `2 * 3`, `*.log and *.txt` and a lone `*`
  literal. In a label, a pair like that almost always meant emphasis or code in the first place. A
  scan of all 60 corpus documents, the app's example and the generated scale documents finds **no
  label that changes**. The `*` characters in the corpus are in wildcard endpoints and comments,
  which are not labels. The installed base is small: Gate 3 cleared on 2026-09-24. The options, and
  the reasons this one is recommended, are in §18.
  - *Implemented (branch 2, `feat/a18-text`), as written, with one correction:* the T13 scan is a test (`render-svg/test/markdown-scan.test.ts`): every corpus document, the app's example and the generated n50/n500/n2000 compile byte-identically with and without the parser, except the three documents that hold markdown (`multiline.sgl`, `text/markdown.sgl`, `text/wrap.sgl`). **Correction:** "`@label` set by a class" has nothing to apply to: a class's `@label` never reaches a node's title (DD-03 §6 reads the node's own `config`), before or after A18.
- **T14. Markdown runs on the text after variable substitution.** `${x}` whose value is `"*x*"`
  gives italics. To keep a variable's text literal, escape it inside the value. *A variable is
  text substitution. A label assembled from variables should mean what it would mean written out,
  and the escape rule is the same everywhere.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* compile reads the substituted `config.label`, so nothing was needed; `inline.test.ts` covers `${}`, a whole `$name`, and an escaped value.

---

## 4. `"""` multi-line strings

### 4.1 The token

- **T15. One new token, `MultilineString`, accepted wherever an ordinary string value is:** in
  `Value`, `NodeValue` and `EdgeValue`, and not in `NodeKey`, `PathSegment` or `PropKey`. *A key or
  a path containing a newline has no meaning, and a key is an identity (DD-03 §2.1).*

  ```lezer
  NodeValue { Block | String | ConfigString | MultilineString | ClassRef }
  EdgeValue { String | ConfigString | MultilineString | Block }
  Value     { String | ConfigString | MultilineString | Number | Bool | Null | Word | Variable | Array | Object }

  @tokens {
    // The body never contains an unescaped `"""`: a quote, or two, must be followed by a
    // character that is not a quote. `![\\"]` includes newlines. An unterminated string runs to
    // the end of the input, so the editor shows the rest of the file as a string and buildAst
    // reports SGL1003 (T19).
    MultilineString { '"""' mlBody ('"""' | '"'? '"'? @eof) }
    mlBody { (mlChar | '"' mlChar | '""' mlChar)* }
    mlChar { ![\\"] | "\\" _ }
    …
    @precedence { MultilineString, ConfigString, String }
  }
  ```

  A quote that would otherwise close the string is written `\"`. To put `"""` inside, escape the
  quotes (`\"\"\"`).
  - *Implemented (branch 1), as written.* The token and the three productions are exactly the block
    above. One correction to the reasoning, not the rule: a key position does not reject `"""`
    because the lexer never offers the token there (it does, see T16), but because no key or path
    production accepts it, so it is an error node and `SGL1002`.
- **T16. The precedence audit.** Three tokens start with `"`: `String`, `ConfigString` and
  `MultilineString`. The table below lists every overlap, and each row becomes a lexer test in
  Phase 2. *This project has been burned by token precedence twice before: `Wildcard` against
  `Identifier`, and `ConfigString` against `String`.*

  | Input | Before A18 | After A18 | Why |
  |---|---|---|---|
  | `""` then space, `,`, `}`, `]` or `:` | `String` (empty) | same | `MultilineString` needs a third `"` |
  | `"""a"""` | `""`, `"a"`, `""`: three adjacent strings | one `MultilineString` | the longest match wins |
  | `""""""` | three adjacent empty strings | an empty `MultilineString` | |
  | `"""@x"""` | a syntax error | `MultilineString` (a label that starts with `@`) | `ConfigString` needs `"@` right after the first quote |
  | `"@style.stroke"` | `ConfigString` | same | `MultilineString` cannot match it |
  | `"""` in a key or path position | a syntax error | still a syntax error (`SGL1002`) | the token is not valid there (T15) |
  | `""""` (4 quotes) | two adjacent empty strings | the start of a `MultilineString` | |
  | `/*`, `//` or `"` inside `"""…"""` | n/a | part of the string | the token owns its body. `scanLexicalErrors` must mirror this (T19) |

  **The pre-A18 inputs that change** are three or more quotes in a row. Before A18 these could only
  be adjacent strings with nothing between them, which is valid only inside an array (`[""""]`,
  `["""a"""]`). In a value, key or edge position they were already a syntax error. No corpus, JSON
  or example document contains one.

  The explicit `@precedence` line changes nothing on these inputs: no input is matched in full by
  two of the three tokens. It is there to say which token wins, so the next token that starts with
  `"` gets audited against it. Lezer only considers tokens that are valid in the current parse
  state, and uses `@precedence` to break ties. The "key position" row therefore depends on
  `MultilineString` being absent from key contexts, and is tested, not assumed.

  **Fallback:** if `lezer-generator --strict` refuses `@eof` inside a token, drop the
  `'"'? '"'? @eof` alternative. An unterminated `"""` then lexes as `""` followed by an unterminated
  `"…`, and `scanLexicalErrors` recognises the three quotes and reports one `SGL1003` from them to
  the end of the input.
  - *Implemented (branch 1), with two corrections to the table* (DD-01 §2, "The `"""` token audit",
    has the full, measured version):
    - **"Lezer only considers tokens that are valid in the current parse state" is wrong** for
      tokens in one token group. `String` and `MultilineString` overlap and are ranked, so they
      share a group, and `"""` lexes as a `MultilineString` wherever a `String` could start, keys
      included. The "key or path position" row still holds (a syntax error), but as `SGL1002` over
      the whole `"""…"""`, and it is tested, not assumed.
    - **More pre-A18 inputs change than the table says.** Three or more quotes in a row after a
      node or edge `:` were *not* errors: `a: """a"""` was node `a` with label `""` plus nodes
      `"a"` and `""`. At an entry start or after `->` they were valid adjacent keys:
      `"""k""": v` was three nodes, and is now `SGL1002`. No committed document contains any of
      them (the CST/AST pins prove it).
    - `lezer-generator` accepted `@eof` inside the token, so the fallback was not needed. The
      explicit `@precedence` entry changes the generated precedence data but no audited input.
- **T17. Dedent rules** (Java text blocks, which lean on the closing delimiter). They are applied to
  the raw body, **before** escapes are decoded:
  1. `\r\n` and a lone `\r` become `\n`. *A document saved with CRLF must not put `\r` into
     labels.*
  2. Split the body into lines.
  3. If the first line, the rest of the line after the opening `"""`, is empty or only whitespace,
     drop it. Otherwise keep it as written, and leave it out of step 5.
  4. If the last line, the text before the closing `"""`, is only whitespace, drop it, but keep its
     whitespace as a candidate in step 5. The closing delimiter's position can then set the indent.
  5. The common indent is the longest leading run of spaces and tabs that every non-blank line
     after the first shares, character for character, together with the step 4 candidate.
     Characters are compared exactly, so a tab never matches a space.
  6. Remove the common indent from every line. Lines that are only whitespace become empty.
  7. Remove trailing spaces and tabs from every line.
  8. Join the lines with `\n`, then decode escapes exactly as `String` does, with T11's additions.
     Diagnostics such as `SGL1004` point at their source offsets, not at offsets in the dedented
     text.

  ```sgl
  api: {
    @label: """
      **Payments API**
      handles `POST /pay`
      """
  }
  ```
  gives ``` **Payments API**\nhandles `POST /pay` ```. `@label: """one line"""` gives `one line`. *Escapes
  are decoded after dedenting, so `\t` or `\u0020` can put back whitespace that steps 6 and 7 would
  remove. Trailing whitespace is invisible in source and should not decide what a label measures.*
  - *Implemented (branch 1), as written*, with two clarifications. "Whitespace" in steps 3–7 is
    spaces and tabs only; other Unicode spaces are text. Step 8 decodes each kept line in place in
    the source rather than the joined text, which gives the same value and keeps every `SGL1004`
    offset a source offset without a mapping table.
- **T18. Newlines inside `"""` are hard breaks.** CommonMark's soft break, where a single newline
  becomes a space, is **not** used. A `\` at the end of a line is reserved for a later
  line-continuation rule. Until then it is `SGL1004` and kept as written, which is today's
  behaviour. *The human asked for explicit breaks, and what you see in the source is what the
  label shows. Long lines are what `maxWidth` wrapping is for.*
  - *Implemented (branch 1), as written.* A `\` that ends a line (after T17 step 7) is `SGL1004`
    over the backslash and the next source character, and is kept.
- **T19. Diagnostics and the AST.** An unterminated `"""` is **`SGL1003`** ("Unterminated
  string."), from the opening `"""` to the end of the input. `decodeString` reports it when the
  token does not end in `"""`. `scanLexicalErrors` learns to skip a `"""…"""` body, so that a `"`,
  `//` or `/*` inside one is not reported. `StringLit` is unchanged: `value` is the decoded,
  dedented text, and a triple-quoted string is not flagged in the AST. The CST node type
  (`MultilineString`) says which form was used, for highlighting and for a future formatter.
  `styleTags` maps it to `tags.string`, and `foldNodeProp` folds it. *No new code: the existing
  message says exactly what is wrong. And no AST consumer needs to know the spelling.*
  - *Implemented (branch 1), with one deviation:* the `SGL1003` for an unterminated `"""` comes
    from `scanLexicalErrors`, not `decodeString`. The scanner has to find the string anyway, to skip
    closed bodies and to explain the rest of the input, and one place reporting it is what keeps it
    to exactly one. The error Lezer leaves at the end of the input (a `}` never reached) falls in
    the `SGL1003`'s region and is not reported again. `StringLit` is unchanged. Highlighting
    (`tags.string`), folding and a `"""` entry in the editor's `closeBrackets` list (so typing the
    third quote closes the string) are in `@sgl/core/editor`.
- **T20. Interpolation (A8) works inside `"""` unchanged.** The resolver reads `${name}` and a
  whole-string `$name` out of `StringLit.value` (DD-02 §3.5), and that value is already dedented,
  so an interpolated value's own newlines are inserted as they are and are not re-indented. The
  I16 qualified forms that `feat/imports` adds (`${ns.name}`) apply the same way. *Interpolation
  reads the decoded value, so it cannot tell which spelling the author used, and it does not need
  to.*

  - *Implemented (branch 1): nothing to change.* `multiline-string.test.ts` covers `${name}` in the
    dedented text, a value's own newlines inserted as they are, a whole `"""$n"""` keeping its
    type, the label shorthands, and `SGL2013`. `corpus/multiline.sgl` uses it.

### 4.2 What changes in the corpus

*Branch 1 added `corpus/multiline.sgl` and `corpus/malformed/unterminated-triple-string.sgl`, the
first documents with `"""`. Before it:* no corpus document, `.sgl.json` document, app example or
generated scale document contained `"""`,
`""""`, `\*` or `` \` ``. Strict JSON cannot contain three quotes in a row outside a string. No
existing golden changes because of §4.

### 4.3 Sequencing with `feat/imports` (A9)

A9's I16 (⚑, awaiting the human) changes the same grammar file: `ClassRef` and `Word` become
`Identifier ("." Identifier)*`, and the `Variable` token becomes `"$" Identifier ("." Identifier)*`.

- **Order:** A9's grammar commit lands on `main` first, and A18's grammar branch (§16, branch 1)
  starts from that `main`. A9 is further along and its phase 2 starts with the F20 bundle trim
  that A18 also depends on (T55). If the human rejects I16, A9 does not change the grammar at all, and branch
  1 can start at once.
- **Never merge two branches' generated parsers.** `sgl.parser.js` and `sgl.parser.terms.js` are
  generated and committed. Whichever branch merges second resolves any conflict in them by merging
  `sgl.grammar` and running `pnpm grammar`, never by hand, and runs the grammar corpus and DD-01
  §8's conflict check again. Term IDs shift, and code that refers to terms by name is unaffected.
- **Shared files that will conflict:** `sgl.grammar`, `build-ast.ts` (A9 builds qualified names;
  A18 adds dedent, the new escapes and `scanLexicalErrors`), `compile.ts` (A9's I17 rules; A18's
  `inline` option), DD-01 §2 and §3, language spec §2 and §5, and `apps/web/src/state/pipeline.ts`
  (each adds a lazy-chunk gate). A18 adds no diagnostic codes (T59), so the catalogue does not
  conflict. A9 takes `SGL2017`–`SGL2026`.
- **Their interaction:** none at the token level. `$` and `.` never start a string. `${ns.name}`
  inside a `"""` string is resolved exactly as inside `"…"` (T20).

---

## 5. Types

- **T21. `TextRun` holds three flags in place of `style`, and a hard break is a `\n` inside `text`.**
  `LabelSpec` keeps its shape: `id`, `owner`, `role` and `runs`.

  ```ts
  interface LabelSpec {                       // DD-03 §2, shape unchanged
    readonly id: LabelId;
    readonly owner: { kind: 'node'; id: NodeId } | { kind: 'edge'; id: EdgeId };
    readonly role: 'title' | 'edge';
    readonly runs: readonly TextRun[];        // canonical: see below
  }

  interface TextRun {                         // replaces `style?: 'code' | 'strong' | 'em'`
    readonly text: string;                    // non-empty; '\n' is a hard break
    readonly strong?: true;
    readonly em?: true;
    readonly code?: true;                     // a code run never contains '\n' (T8)
  }
  ```

  **Canonical form:** runs are maximal. Two neighbours never carry the same three flags, no run is
  empty, and a flag is either `true` or absent. So a plain label is **one** run, `\n` included:
  `"Line one\nLine two"` is `[{ text: 'Line one\nLine two' }]`, where the MVP gave one run per line.

  *A single `style` value cannot say "bold and italic". Flags are plain JSON, readable in goldens,
  and `structuredClone`-safe. With one-run-per-line, two neighbouring runs on the same line could
  not be told apart from two runs on separate lines without a second marker. With `\n` in the text,
  the markdown parser's output needs no post-processing. The MVP never read `style`, so nothing
  depends on the old field.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `graph.ts`; `compile()` without `inline` gives one plain run, `\n` included. The unicode.sgl and multiline.sgl compile goldens changed accordingly (T58).
- **T22. `plainText(runs)`** (`@sgl/text`) concatenates the runs' text. The accessibility label
  replaces `\n` with a space, as today's `labelLines(...).join(' ')` does. *Screen readers read
  words, not markers. For every pre-A18 label the result is byte-identical.*
  - *Implemented (branch 2, `feat/a18-text`):* `plainText` is in `@sgl/text`; the renderer's `labelLines` is `plainText(runs).split('\n')` and its `aria-label` joins those lines with a space, byte-identical for every pre-A18 label.
- **T23. The measurement types move to `@sgl/text`, and grow by one optional field.**

  ```ts
  interface RunMarks { readonly strong?: true; readonly em?: true; readonly code?: true }

  interface StyledRun {                       // DD-05 §2, plus `marks`
    readonly text: string;                    // may contain '\n'
    readonly style: TextStyle;                // already the run's face (T25)
    readonly marks?: RunMarks;                // for the renderer's classes; absent on plain runs
  }

  interface TextLayout {                      // DD-05 §2, unchanged except `marks`
    readonly width: number; readonly height: number; readonly ascent: number;
    readonly lines: readonly {
      readonly y: number; readonly width: number;
      readonly runs: readonly { readonly x: number; readonly text: string;
                                readonly style: TextStyle; readonly marks?: RunMarks }[];
    }[];
  }

  interface BoxConstraints { readonly maxWidth?: number }   // unchanged: the *label's* max width (T35)
  type LineModel = (measureRun: MeasureRun, runs: readonly StyledRun[], box: BoxConstraints) => TextLayout;
  ```

  `TextStyle`, `MeasureRun`, `MeasureTable`, `Measurer` and `MeasureMiss` keep their shapes.
  `@sgl/measure` re-exports everything that moved. *DD-05 says "`TextLayout` does not change". An
  optional field keeps that promise for every reader. The renderer needs the marks, because a strong
  run whose weight equals its base weight has the same `TextStyle` as a plain run.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `packages/text/src/types.ts`, plus `LaidRun` and `TextLine` names for the layout's parts.
- **T24. Architecture §6's sketch (`kind?: 'text' | 'code' | 'link'`, `size`, `baseline`,
  `PositionedRun`) is superseded by DD-05 plus T21 and T23.** *DD-05 is the normative one and the
  code matches it. There are no links (T12).*
  - *Implemented (branch 2, `feat/a18-text`):* architecture §6 now carries a superseded-sketch note (§19 item 2).

---

## 6. Measurement

- **T25. A run's face is its label's style with at most three changes**, made by
  `runStyle(base, run)` (`@sgl/text`):
  - `strong` → `fontWeight: 700`.
  - `em` → `fontStyle: 'italic'`.
  - `code` → `fontFamily: CODE_FONT_FAMILY`, `fontStyle: 'normal'`, and `fontWeight: 400`, or `700`
    when the run is also `strong`.

  `fontSize`, `lineHeight` and `letterSpacing` never change, so every run of a label has the same
  line height (T31). *Only a small set of faces is ever needed (T26). Uniform line height keeps
  DD-05 §3's vertical model exact. Code is conventionally upright and regular. A label whose base
  weight is already 700 shows no difference for strong, and is documented as such.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `runStyle` in `packages/text/src/faces.ts`; a plain run keeps the base style object.
- **T26. Fonts.** There is no monospace font today, and only Inter 400, 500 and 600 roman. **⚑**
  Recommended, all from `@fontsource/*` 5.3.0, Latin subset only, under OFL-1.1:

  | Face | File | Size | Needed for |
  |---|---|---|---|
  | Inter 700 normal | `inter-latin-700-normal.woff2` | 24.4 kB | `strong` |
  | Inter 400/500/600 italic | `inter-latin-{400,500,600}-italic.woff2` | 25.0 / 25.6 / 25.8 kB | `em` at each role's base weight (edge 400, node 500, container 600) |
  | Inter 700 italic | `inter-latin-700-italic.woff2` | 25.9 kB | `strong` + `em` |
  | IBM Plex Mono 400 normal | `ibm-plex-mono-latin-400-normal.woff2` | 14.7 kB | `code` |
  | IBM Plex Mono 700 normal | `ibm-plex-mono-latin-700-normal.woff2` | 14.9 kB | `code` + `strong` |

  That is eight new faces, about 156 kB, **none of it on the boot path.** Each gets an `@font-face`
  rule in `fonts.css` (`font-display: block`), is fetched only when a document first uses it, is
  precached by the service worker (`globPatterns` already takes `*.woff2`, so a PWA install grows
  from 72 kB to about 228 kB of fonts), and ships its licence (`public/fonts/OFL-IBM-Plex-Mono.txt`,
  plus attribution in the README). `CODE_FONT_FAMILY` is
  `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. *Inter ships real
  italics, so no slant is synthesised. IBM Plex Mono is the smallest OFL monospace in `@fontsource`
  with both weights: JetBrains Mono's 400 is 21.2 kB. Mono italic is never needed, because of T25.
  Without a shipped mono face, measurement and export would depend on each viewer's system font.*
  - *Branch 2 (metrics only):* `CODE_FONT_FAMILY` is the stack above; measurement needs nothing more (`StaticMetricsMeasurer` classifies it as mono, T30). The font files, `@font-face` rules, licence and precache are the render branch's. Until then `CanvasMeasurer` measures bold, italic and mono runs in whatever face the browser synthesises or falls back to, and so draws the same.
- **T27. The code font and the strong weight are constants of `@sgl/text` in v1.0, not theme
  tokens or style properties.** *The run classes stay theme-invariant by construction (T44), and no
  registry row, cascade step or `geometryHash` input is added. A future `font.mono` token is an
  additive change, and it must then enter `geometryHash`, because it changes measurement.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `CODE_FONT_FAMILY` and `STRONG_WEIGHT` are constants of `@sgl/text`.
- **T28. Fonts load before the first layout that needs them.** `distinctTextStyles` (the app's
  `measure-styles.ts`) iterates `labelRuns`, which now applies `runStyle`, so `measurer.ready(...)`
  already receives the bold, italic and mono faces a document uses, and `document.fonts.load`
  fetches them. Until they arrive, the canvas keeps showing the last good picture (or the J6 stored
  one). *DD-05 §4 already makes readiness a precondition. The only change is that the set of styles
  is larger.*
  - *Implemented (branch 2, `feat/a18-text`):* nothing to change: `distinctTextStyles` iterates `labelRuns`, which now applies `runStyle`.
- **T29. The table key extends `hashRuns` (DD-05 §2) without changing any plain key.**
  - Per run: `text ␟ family ␟ size ␟ weight ␟ style ␟ lh ␟ ls`, then `␟` and the marks as the
    letters `s`, `e`, `c` in that order, **only when the run has marks**.
  - Runs are joined by `␞`. Then `␝` and the box: `maxWidth` as a numeral, or `*`.
  - `labelBox(styled, labelId)` (`@sgl/text`) returns the box: `{ maxWidth: labelMaxWidth(...) }`
    (T35) for a label whose owner node has a finite positive `geometry.maxWidth` (or `width`, if
    T36 is accepted), and `{}` otherwise. `labelRunKey` is `hashRuns(labelRuns(...), labelBox(...))`.
  - `premeasure`, the app's `labelSizes` join and `render()` (T42) all use `labelRunKey`.

  *A plain single-line label keeps its key. A multi-line plain label's key changes, from several
  runs to one run containing `\n`. Keys appear in no golden, so this is invisible outside the
  table.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* a plain key is byte-identical to the MVP's (`text/test/label.test.ts` checks against the old function). **Correction:** the "(or `width`, if T36 is accepted)" is accepted: the smaller of the two.
- **T30. Determinism.**
  - In the browser, `CanvasMeasurer` measures each run's own face through the `ctx.font` shorthand
    (`italic 500 13px Inter…`), so italic advances are Inter Italic's real ones. Within a browser
    session, measurement, and therefore every line break, is deterministic.
  - Across browsers it is not, exactly as label sizes are not today (ADR-0003's canvas-first
    amendment). A label within a sub-pixel of its wrap width can break differently in Chromium and
    in Firefox.
  - In Node, `StaticMetricsMeasurer` classifies `IBM Plex Mono` as `mono` (Courier's 0.6 em, which
    Plex's 600-unit advance matches) and applies its bold scalar at weight 700. Italic costs nothing
    (`ITALIC_SCALE = 1`). Goldens are therefore byte-stable.
  - Breaks become identical across environments only with `FontMetricsMeasurer` (phase 3). Its
    metrics tables must then include the eight faces of T26: ADR-0003's "adding a font is a
    build-time step".

  *This follows ADR-0003 as amended. A18 adds no new source of non-determinism, only a second
  number, line breaks, that depends on the same measurements.*
  - *Implemented (branch 2, `feat/a18-text`):* the breaker is a pure function of the measurements, so breaks are deterministic per session and in Node; `wrap.test.ts` and `rich-corpus.test.ts` run twice and compare bytes.
- **T31. The line model's vertical metrics.** Every label has one line height,
  `lineHeightPx = fontSize × lineHeight`, identical for all of its runs by T25. Line `i` sits at
  `y_i = A + i × lineHeightPx`, where `A` is the largest measured ascent of the label's runs, and
  `A` is reported as `ascent`. `height = lines × lineHeightPx`. For a label in one face, this is
  DD-05 §3's formula exactly. *Line spacing stays even, and every existing layout number is
  unchanged.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* the baselines accumulate line by line (`advanceY + A`), as the MVP's did, so a plain label's `y`s are bit-identical; `line-model.test.ts` checks every corpus label against the MVP model under two measurers.

---

## 7. Line breaking

Two line models, both of type `LineModel`, with the same output type:

- **`layoutLines`** (`@sgl/text`, on the boot path). Hard breaks only, and it ignores `maxWidth`. It
  replaces today's one-run-per-line `line-model.ts`. It splits the runs at `\n` into hard lines.
  Each hard line is a list of fragments, where a fragment is the maximal text on that line that
  shares one style and one set of marks.
- **`layoutWrapped`** (`@sgl/text/wrap`, lazy). The same, plus the greedy breaker below whenever
  `box.maxWidth` is defined. With `maxWidth` undefined it returns exactly `layoutLines`'s result.

`layoutLines` **throws** when it is handed a defined `maxWidth`. That is a violated invariant (DD-00
§3): the caller should have loaded the wrap model (T53). A forgotten gate then fails loudly, instead
of producing a table entry keyed for a wrapped label that holds an unwrapped layout.

The decisions:

- **T32. A line's width** is the sum of its fragments' widths, each measured whole with its own
  style, plus `letterSpacing × (glyphs on the line − 1)`. The line's run `x`s are the running sums.
  *A single-fragment line is measured exactly as it is today, whole, so every plain label keeps its
  width to the bit. Kerning across a style boundary is ignored. It is sub-pixel, and deterministic.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* a fragment's `x` includes the letter spacing of the glyphs before it.
- **T33. The greedy breaker.**
  - **Break opportunities** are runs of U+0020 or U+0009, and U+200B. U+00A0 is not one.
  - A **word** is the maximal text between two opportunities. A word may span several runs, as in
    `` `x`y ``, and keeps their boundaries.
  - For each hard line, a word is added to the current line when the line with the word still fits
    (`width ≤ maxWidth`). Otherwise the current line ends and the word starts the next one.
  - **Whitespace at a soft break is dropped entirely**, from the end of one line and from the start
    of the next.
  - Whitespace at the **start or end of a hard line** is kept and measured, as today (DD-03 §6
    preserves it, and the SVG has `xml:space="preserve"`).
  - Each fit test measures only the growing last fragment. `CanvasMeasurer`'s per-run cache serves
    repeats.

  *This is DD-05 §3's promised "greedy breaker over words with run boundaries preserved", and it
  leaves unwrapped labels byte-identical.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* leading and trailing whitespace of a hard line travel with its first and last word, so they are kept and measured, and a line of only whitespace is one word. Each fit test measures the candidate line through a per-call memo, so a repeat costs a lookup.
- **T34. Explicit breaks always break.** `\n`, from an escape or from a `"""` newline, starts a new
  line whatever the width. Empty lines are kept, and a trailing `\n` gives an empty last line, as
  the MVP's split does. *These are the human's explicit breaks, and they behave as they did before
  A18.*
  - *Implemented (branch 2, `feat/a18-text`), as written.*
- **T35. `maxWidth` comes from the owner node's `@size.maxWidth`**, as resolved into
  `styles[nodeId].geometry.maxWidth` (DD-04 step 6, so a class's `@size` counts). The **wrap
  width** is the widest label that still fits the node:

  ```
  labelMaxWidth(shape, maxWidth, padding):   // @sgl/core, beside contentInsets (T4)
    avail = max(0, maxWidth − padding.left − padding.right)
    rect, round, cylinder, package, and any other shape → avail
    ellipse                          → avail / √2
    diamond, hexagon                 → avail / 2      // hexagon: exact when the label is taller than wide, conservative otherwise
                                                      // (fix round 1, item 3: hexagon → avail, and the breaker keeps L + min(L, H) ≤ avail; see below)
  ```

  Containers wrap their titles the same way. Edge labels have no `@size`, so they never wrap: an
  edge label breaks only at explicit `\n`. **With no `maxWidth`, nothing wraps**, which is the MVP
  behaviour. *This is the human's decision. With no default width, no existing layout changes. The
  inverse insets are what make `intrinsic.w ≤ maxWidth` hold for every shape.*
  - *Implemented (branch 2, `feat/a18-text`), as written, with one correction:* `labelBox` in `@sgl/text`, `labelMaxWidth` in core. **Correction, since reversed:** branch 2 found that a class's `@size` reached no geometry (DD-04 §4 step 6 applies only a node's own `@size`), so it did not wrap. Human decision H2 (fix round 1) makes it count, as T35 said: DD-04 §4 merges a class's size keys at step 4, and a class with `maxWidth` wraps its nodes' labels (tested end to end). And `@size.maxWidth` did not reach geometry at all: the theme registry had no `maxWidth` row, so the cascade dropped it with `SGL5003`. Branch 2 adds the row (DD-04 §2). Containers do not wrap their titles: `@size` keys apply to nodes only.
- **T36. ⚑ A fixed `@size.width` also wraps**, at `labelMaxWidth(shape, width, padding)`. When both
  are set, the smaller wins. *Text that overflows a fixed-width box is never what the author
  wanted. The human's decision names only `maxWidth`, so this is an extension that needs a yes. No
  corpus document sets `@size`, so no golden depends on it.*
  - *Implemented (branch 2, `feat/a18-text`), as accepted by the human:* the smaller of `maxWidth` and `width` wins.
  - **Fix round 1, item 3: hexagons.** `avail / 2` over-wrapped: a 200-wide hexagon wrapped
    "Order fulfilment" (110 px) onto two lines. A hexagon's side insets are `min(L, H)/2`, so a
    label fits when `L + min(L, H) ≤ avail`. `labelMaxWidth('hexagon', …)` now returns `avail`
    and `labelBox` marks the box `hexagon: true` (`␟h` in the key); `layoutWrapped` breaks at
    `max(avail/2, avail − one line height)` and, while the result breaks the rule, again at
    `max(avail/2, avail − H)`. `H` only grows and the width only shrinks, to `avail/2` at worst,
    where the rule always holds. Only `text/wrap.sgl`'s hexagon changed (4 lines → 2), and its two
    rich layout goldens with it.
  - **Human decision H1 (2026-09-26, fix round 1): a fixed `@size.width` breaks only at spaces.** A
    single word too wide for the line overflows, as before A18; T37's mid-word split happens only
    when the author set `@size.maxWidth`, an explicit request to constrain text. With both, the
    narrower width is where lines break, and words may be split. `labelBox` marks a width-only box
    `keepWords: true`, which the key carries (`␟k` after the width, T29), and `layoutWrapped` then
    puts an overlong word on a line of its own, unsplit.
- **T37. Words that are too long, and text without spaces.** A word wider than the wrap width is
  split at the last code-point boundary that fits, repeatedly, and a line always gets at least one
  unit. *(H1: only when `@size.maxWidth` is set; under a fixed `@size.width` alone the word
  overflows, see T36.)* No hyphen is inserted. A split never lands:
  - inside a surrogate pair;
  - before a combining mark (U+0300–036F, U+1AB0–1AFF, U+20D0–20FF, U+FE20–FE2F);
  - before a variation selector (U+FE00–FE0F, U+E0100–E01EF);
  - before an emoji modifier (U+1F3FB–1F3FF);
  - on either side of U+200D (ZWJ);
  - between the two halves of a regional-indicator pair.

  This is also the **minimum acceptable CJK behaviour**: text without spaces fills each line to the
  width and breaks between any two ideographs. There is no kinsoku, so a line may start with `。`.
  Thai, Lao and Khmer break the same way, not at word boundaries. Arabic and Hebrew break at spaces.
  Each line is drawn by the viewer's bidi algorithm, and the widths are logical-order sums, which
  are the same. *The node box never overflows `maxWidth`, which is the property layout relies on.
  `Intl.Segmenter` is not used, because its rules follow each engine's ICU version and so are not
  deterministic across environments. The hand-written boundary rule above is.*
  - *Implemented (branch 2, `feat/a18-text`), as written:* `breakUnits` in `wrap.ts`. A word too wide for the current line first moves to a line of its own, then splits; a split unit never goes back to fill the previous line. "The last boundary that fits" is found by adding units until the next one does not fit.
- **T38. There is no hyphenation and no break after `-` or `/` in v1.0.** *UAX #14 is a later,
  additive refinement. Until then `order-service` wraps only by T37's emergency split, and only when
  it does not fit on a line of its own.*
  - *Implemented (branch 2, `feat/a18-text`), as written.*

---

## 8. Node sizing and layout (DD-06)

- **T39. Nothing in the engine contract changes.** `buildLayoutInput` still takes
  `labelSizes[labelId] = { w: layout.width, h: layout.height }` from the table. A wrapped label is
  simply narrower and taller. The existing rule `intrinsic = label + padding + contentInsets(shape,
  label)` gives `intrinsic.w ≤ maxWidth` by T35. The one exception is a single unsplittable unit
  wider than the wrap width, such as one glyph in a 10 px box, which overflows as today. `min`,
  `max`, `fixed` and `aspectRatio` reach engines exactly as they do now. *Engines never see text
  (DD-06 §2). The label box is the entire interface, and it already accounts for any number of
  lines.*
  - *Implemented (branch 2, `feat/a18-text`):* nothing in the contract changed; `render-svg/test/wrap-pipeline.test.ts` checks, for every shape under both engines, that the table entry, `LayoutInput.labelSizes`, the node's intrinsic width and frame, and the label placement agree, and `apps/web/test/rich-text.test.ts` checks the same through the app's pipeline.
- **T40. `elk` and `grid` need no change.** `elk` receives the node size and the label size (K4),
  and `grid` packs sized boxes. A container's title band grows with its line count
  (`titleHeight = label.h + titleGap`), which pushes its children down. *Both engines already handle
  multi-line labels through their sizes.*
  - *Implemented (branch 2, `feat/a18-text`):* no engine change; tested (a two-line container title pushes its child down, under both engines). One elk pin gained an entry: `text/wrap.sgl` has one title crossing, F16's known case.
- **T41. Label placement is unchanged.** The host fallbacks size the frame to the label. The
  renderer aligns each line on its own (`text-anchor` applies per line chunk, T43), so a wrapped
  node title is centred line by line. *This is the same mechanism a `\n` label uses today.*
  - *Implemented (branch 2, `feat/a18-text`):* the fallbacks are unchanged. The renderer does not draw soft breaks until the render branch (T42), so a wrapped label is laid out wrapped but drawn on its hard lines, overflowing its node.

---

## 9. Rendering (DD-07)

- **T42. `render()` gains an optional fourth argument, the measure table:**
  `render(styled, layout, theme, text?: Readonly<Record<string, TextLayoutView>>)`.
  - For each label it looks up `text[labelRunKey(styled, labelId)]` and takes **which fragments sit
    on which line**, with their marks.
  - With no table, or on a miss, it splits the label's runs at `\n`, which is today's behaviour.
  - Vertical positions stay the renderer's own, computed as today: `fontSize × 0.8` for the ascent
    and `fontSize × lineHeight` per line. The measured `ascent` and `y` are not read.
  - `renderPaintOnly(previous, styled, layout, text?)` also requires `text` to be the same object
    the plan was drawn with.
  - `LabelPlacementView.text` is removed in favour of this argument. Neither the app nor the test
    pipeline supplies it; only a `textBlock` unit test passes one.

  *The renderer cannot recompute breaks without measuring, and it must draw exactly the breaks that
  sized the node. Keeping the vertical model is what keeps every existing render golden
  byte-identical. DD-07 §5's measured-ascent rule has never been exercised: `render()` has never
  been given a `TextLayout`. Adopting it would move every label by about 2 px, and that is a
  separate decision (§19, item 5). The app already holds the table, and on a theme switch it keeps
  the same table object (DD-08 §3's measure-effect skip), so the paint-only guard holds.*
- **T43. The markup: one nested `<tspan>` per marked fragment, inside the line's `<tspan>`.**

  ```svg
  <text class="n-title g-… t-…" x="120" y="44.4" text-anchor="middle" xml:space="preserve">
    <tspan x="120" dy="0">Plain <tspan class="r-strong">bold</tspan> and <tspan class="r-code">code</tspan></tspan>
    <tspan x="120" dy="16.9"><tspan class="r-strong r-em">both</tspan></tspan>
  </text>
  ```
  (Line breaks between the tags above are for reading only. The emitter writes none, because
  `xml:space="preserve"` would render them.)
  - A plain fragment is bare text. A marked one gets `class` with `r-strong`, `r-em` and `r-code`,
    in that order, for the marks it carries.
  - Nested tspans carry no `x`, `dy` or `dx`. The viewer flows them, so a line is one text chunk and
    `text-anchor` centres the whole line.
  - A label with no marks produces exactly today's output: one `<tspan x dy>` per line, containing
    text.

  *This is DD-07 §5's "nested `<tspan class="r-code">`". Per-run `x` values from our measurement
  would fight the viewer's own shaping in exported files. Inkscape, resvg and every browser flow
  unpositioned tspans.*
- **T44. Run classes are constants, and so are their rules**, appended to the one `<style>` only
  when some label uses them, always in this order:

  ```css
  .r-em{font-style:italic}
  .r-code{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:400;font-style:normal}
  .r-strong{font-weight:700}
  ```

  All three selectors have equal specificity, so source order decides: code is never italic, and
  strong code is bold (T25). The names are neither hashes nor theme-derived, and the rules come
  from no theme. `PaintPlan` records which of the three rules were emitted, and `renderPaintOnly`
  emits the same ones. *A theme switch changes no run class and no run rule, which keeps F7's
  paint-only contract by construction. A rule on the tspan itself beats the value the tspan
  inherits from `<text>`'s `g-` class, whatever the order.*
- **T45. `structureHash` includes the marks.** Its label-text field becomes the runs' text with each
  marked run prefixed by its mark letters and a separator that text cannot contain. For unmarked
  labels it is exactly today's string. The guarantee becomes: for the same `LayoutResult` **and
  the same table**, equal `structureHash` implies the output outside `<style>`/`<defs>` is
  byte-identical. *Two labels with the same text and different marks render different tspans. F9's
  guard must see that.*
- **T46. There are no code-span background plates in v1.0.** *A plate needs per-run `x` and width
  from our measurement, which will not match the viewer's own glyphs in an exported file. It would
  also add a paint rule per label to the paint plan. Monospace alone distinguishes code.*
- **T47. Escaping.** Each fragment's text goes through `escapeXml`, once, like any text (DD-07 §8).
  Class names are the three constants, never document text. The injection corpus gains
  `injection/markdown-in-label.sgl` with `**<script>…**`, `` `</tspan><script>` ``, `*" onload=*`
  and `` `]]>` ``. *Markdown moves no document text into any context it did not already reach.*
- **T48. Accessibility is unchanged.** `aria-label` is `plainText` with `\n` replaced by a space, and
  `<text>` stays `aria-hidden`. *Marks are visual, and the group's label already carries the
  words.*

---

## 10. Export font embedding (D2, DD-07 §9)

- **T49. The app's `SHIPPED` faces grow by T26's eight**, fetched only when used, from the precache
  when offline. *D2 embeds "the weights the file uses", and an exported rich label uses these.*
- **T50. `usedFontFaces` selects faces per element, not as a cross product.**
  - Today it collects families, weights and styles across all the rules and combines them. With run
    rules, a single `em` anywhere would pull in an italic for every weight any rule names, and a
    single `code` both Plex faces: up to ten faces, about 300 kB of base64.
  - It will instead read each `<text>`'s base face from the rules its classes name, then apply the
    `r-` rules for each nested tspan, and select the face CSS matching would draw each combination
    with.
  - The result stays sorted and deterministic, and an SVG without `r-` classes gets exactly today's
    selection.
  - The work lives in the lazy `@sgl/render-svg/fonts` entry.

  *"Exactly the used faces" is D2's promise (human decision, 2026-09-25). Scanning elements is
  string work in an export-time chunk, and costs the boot path nothing.*

---

## 11. Canonical JSON and `.sgl.json`

- **T51. Nothing changes in `toJson` or `fromJson`.**
  - Labels are strings in the model. A `"""` label is stored as its decoded, dedented value and
    written as an ordinary JSON string with `\n`.
  - `\*` is stored as two characters, `\` and `*`, and written `"\\*"`.
  - `fromJson(toJson(m)) ≡ m` still holds, and a `.sgl.json` label means exactly what its `.sgl`
    source meant, because compile parses the same value.
  - A8's `authored` bag keeps a `${}` template's dedented text.
  - The `"""` spelling is not preserved through JSON, which has none.

  *The model is canonical and the spelling is not semantic.*
  - *Implemented (branch 2, `feat/a18-text`):* nothing changed, as designed.
- **T52. A hand-written `.sgl.json` label is markdown too.** `"@label": "**API**"` is bold. *JSON is
  the same language (spec §1), not a literal-text escape hatch. §18's option (b) would add one, if
  wanted.*
  - *Implemented (branch 2, `feat/a18-text`):* true without a change: compile parses `.sgl.json` label values like any other.

---

## 12. Bundle budget (F20: 178.91 of 180 kB, 1.09 kB headroom)

- **T53. The inline parser and the word breaker are one lazy chunk, `rich-text`**
  (`@sgl/core/inline` and `@sgl/text/wrap`). It loads only for a document that needs it:
  - **Markup gate:** after a compile without the parser, `needsInline(graph)` (`@sgl/core`, boot)
    is true when any label's text contains `*` or `` ` ``. A node whose key-derived title contains
    one only costs a needless load.
  - **Wrap gate:** after `styleGraph`, `needsWrap(styled)` (`@sgl/text`, boot) is true when any
    labelled node has a finite positive `maxWidth` (or `width` under T36).

  While the chunk loads, the pipeline holds the measure and layout effects, as `hasMeasuredOnce`
  does, so nothing is laid out with literal runs or unwrapped labels. The canvas keeps showing the
  last good or stored picture. Once the chunk is loaded:
  - compile runs again with `{ inline: parseInline }`;
  - the app replaces its `CanvasMeasurer` with `new CanvasMeasurer({ lineModel: layoutWrapped })`
    (the per-run cache is rebuilt once);
  - every later keystroke is synchronous, as today.

  **Offline:** the chunk is precached like `share`, `file-actions` and `elk`, and
  `e2e/offline.spec.ts` gains a markdown document booted offline. F12 (a stale lazy chunk in a
  second tab after an update) applies to it as it does to the others.

  Node, the CLI and every test import both modules statically. `.size-limit.js` excludes
  `rich-text-*.js` by name, and `check-core-chunks.mjs` checks that the entry does not import it
  statically. *The parser and the breaker are most of A18's code, and a document without markup or
  `maxWidth` needs neither. This follows A9's pattern: a gate on the boot path, the work lazy.*
  - *Implemented (branch 2, `feat/a18-text`), with two deviations:* both gates are in `pipeline.ts`, the chunk is `state/rich-text.ts`, `.size-limit.js` excludes `rich-text-*.js`, and `check-core-chunks.mjs`'s existing sweep fails if the entry reaches it. **Deviation 1:** the app does not replace its `CanvasMeasurer`; `lineModel` is a writable property it sets once the chunk loads, so the worker host keeps the measurer it holds and the per-run cache (which caches runs, not lines) is kept. **Deviation 2:** the measure effect no longer measures the boot-time fallback (the empty document) while a stage is held: laying that out made an empty layout the one a held document's first render was drawn with (A9's gate had the same latent case). A failed load is retried on the next change of the document. **Fix round 1, item 2:** a failed load used to hold the stages until then, freezing the picture for any label with `*` or a backtick; it now degrades like A9's gate (plain runs, the box ignored, one `SGL6002` warning, a new boot-catalogue code approved by the orchestrator, listed with `SGL2027` as unreachable from a document). Tests: `apps/web/test/rich-text.test.ts`, `e2e/rich-text.spec.ts` (never fetched without markup or a box), `e2e/offline.spec.ts` (from the precache).
- **T54. What stays on the boot path, estimated gzipped:**

  | Item | Estimate |
  |---|---|
  | `MultilineString` in the parser tables, the dedent and the two escapes (`build-ast.ts`) | 0.20–0.25 kB |
  | `needsInline`, `needsWrap`, the `compile` option | 0.05 kB |
  | `layoutLines` with fragments, `runStyle`, marks in the key, `labelBox` | 0.15–0.20 kB |
  | `labelMaxWidth`, net of removing one `contentInsets` copy (T4) | 0.00–0.05 kB |
  | Renderer: nested tspans, run rules, table lookup, `structureHash` marks, paint-plan bits | 0.20–0.25 kB |
  | App: the gate, the lazy import, the measurer swap; `fonts.css` rules for 8 faces (CSS is counted) | 0.20–0.25 kB |
  | **Total** | **≈ 0.80–1.05 kB** |

  The lazy `rich-text` chunk is about 1.2 kB gzipped: the parser about 0.55 kB, the breaker about
  0.65 kB. With it on the boot path, A18 would cost about 2.0–2.3 kB.
  - *Measured (branch 2):* the boot path grew **+0.84 kB** (180.38 → 181.22 kB): the `@sgl/text` boot half with `labelBox`, `runStyle` and the fragment line model, `labelMaxWidth`, the marks in the key, and the app's two gates and lazy import, net of render-svg's per-shape insets removed. The lazy chunk is **2.01 kB** gzipped (estimated 1.2). 0.78 kB is left for the render branch. *Fix round 1* (H1, the hexagon flag, H2, the container check, `SGL6002`'s degraded path, less a compaction) brings the boot path to **181.47 kB**: 0.53 kB left.
- **T55. ⚑ A18 and A9 together do not fit the current headroom without the F20 trim, and fit only
  narrowly with it.**
  - Headroom today is 1.09 kB. A9 estimates its boot cost at 0.8–1.0 kB (DD-02 §10.9 on
    `feat/imports`), and A18 at 0.8–1.05 kB, so the two need 1.6–2.05 kB.
  - F20's next candidate, a lazy `DocumentsMenu` (about 1.75 kB minified, roughly 0.7 kB gzipped),
    is A9's planned first phase 2 commit. It would bring headroom to about 1.8 kB. That just covers
    the two features at the low end, and misses at the high end.
  - **Sequencing:** DocumentsMenu first, then A9, then A18's rendering branch (§16, branch 3) with
    a fresh measurement.
  - If A18 does not fit then, the next trims are those listed in §18. The 180 kB limit is the
    human's to move, not this design's.

---

## 13. Performance

- **T56. Measurement cost at n2000, with every label rich** (estimates, to be measured in Phase 2):
  - The inline parse is linear, about 1–2 µs per label: under 5 ms.
  - `layoutLines` makes one `measureText` per fragment, about 2–3 per rich label, so 4–6 k calls,
    about 5–15 ms cold. Warm, it is cache hits.
  - With `maxWidth` on every node, `layoutWrapped` makes one call per candidate fragment, about 1–2
    per word. At about 6 words per label that is 12–24 k calls, about 20–50 ms cold. A keystroke
    re-measures only the labels whose key changed.
  - The first use of a face adds one font fetch (about 25 kB, from the precache offline) before the
    pre-measure.
  - `labelRunKey` is memoised per `StyledGraph` object (a `WeakMap` in `@sgl/text`), so `render()`'s
    per-label lookup does not rehash 2 000 keys on every render.
  - Budget: the pre-measure for `n2000-rich` stays under 100 ms in Chromium, inside DD-09 §2's 3 s
    full-pipeline budget.
  - `bench/scale-document.js` gains a `{ rich: true }` variant: ``` **Node** `n${i}` ``` labels,
    `@size.maxWidth: 90` on every tenth node. It is measured and reported, not gated.

  *The expensive part, canvas calls, is bounded by words and cached by fragment. Nothing new runs
  on a keystroke for an unchanged label.*
  - *Branch 2:* not measured. The `labelRunKey` memo is for `render()`'s per-label lookup (T42), so it comes with the render branch, as do the `{ rich: true }` scale variant and its bench. The breaker memoises measurements within a call.
  - **Fix round 1, item 5: the estimates above do not hold; the real numbers.** In Node, with static metrics, `premeasure` at n2000 with long labels is 11.7 ms unwrapped and **20.5 ms with every node wrapped** (about 1.75×; branch 2's quadratic breaker made it 30.8 ms here, and the review measured 17 → 87–98 ms, about 5×, on its document). A keystroke re-runs `premeasure` over every label, so wrapped labels are re-broken each time: the per-run cache makes it cache hits, not canvas calls, until the cache overflows. `CanvasMeasurer`'s 20 000-entry clear-all cache holds about three entries per wrapped label and thrashes from about 7 000 wrapped labels (every pass misses); an LRU was tried and does not help. Recorded as execution plan §2.1 **F24**, with the remedy (reuse the previous table's entries by key) and the browser measurement to take with F15.
- **T57. F9's paint-only theme switch stays paint-only.**
  - A theme switch between themes of equal geometry does not re-measure (the table and every break
    are unchanged) and takes the paint-only path. `renderPaintOnly` swaps the `<style>` text, and
    the run rules in it are the same constants (T44).
  - `structureHash` and the table identity guard it (T42, T45).
  - The gated bench documents (`n50`, `n500`, `n2000`) contain no markup, so the F9 gate measures
    exactly what it does today.
  - One real cost: nested tspans add elements, and at 2 000 nodes Chromium's style recalculation is
    already about 40 ms of a 50 ms budget. A rich document with about two marked runs per label
    could therefore cost several more milliseconds on a theme switch. `pnpm bench:theme` gains the
    `n2000-rich` variant, printed and not gated. If it misses, F9's row records it, and the response
    is DD-09 §2's second column, not a change to T43.

  *Nothing on the switch path does more work per element than it did. There are simply more
  elements.*

---

## 14. Goldens

- **T58. Exactly one existing golden changes: `packages/core/test/__goldens__/compile/unicode.sgl.json`.**
  Its `l:multiline` label goes from
  `[{ "text": "Line one" }, { "text": "Line two" }]` to `[{ "text": "Line one\nLine two" }]` (T21).
  - Its label is the corpus's only `\n`.
  - Its layout and render goldens do not change: same sizes (T31, T32), same tspans (T43).
  - No resolve golden changes, because model strings are unchanged.
  - No layout golden changes (`grid`, `elk` input and result), because label sizes are unchanged
    and no layout golden contains `runs`.
  - No render golden changes under any of the four themes or either engine: no corpus label has
    marks or `maxWidth`, the fallback vertical model is kept, and there are no run rules.

  **New goldens** come with new corpus documents:
  - `markdown.sgl`: every §2.2 row, nesting, adjacency, escapes, code containing `*`.
  - `multiline.sgl`: `"""` with the dedent cases, `${}` inside, and `\n` beside it.
  - `wrap.sgl`: `maxWidth` on `rect`, `round`, `ellipse`, `diamond`, `hexagon` and `cylinder`, a
    container title, an overlong word, CJK, emoji with ZWJ, mixed runs across a soft break.
  - `malformed/unterminated-triple-string.sgl`: `SGL1003`.
  - `injection/markdown-in-label.sgl`.

  Each gets compile, layout and render goldens (four themes, both engines where the corpus has
  them).

  *A plain label's IR representation changes, and nothing downstream of it does. That is the
  property Phase 2 must prove before it updates the one golden.*

  *Note from branch 1:* `corpus/multiline.sgl` now exists, with compile, resolve, layout and render
  goldens written under the MVP's one-run-per-line form. Its compile golden changes in branch 2
  the same way as `unicode.sgl`'s (four labels with `\n`), and nothing downstream of it should.
  The `unicode.sgl` change itself is branch 2's (it comes with the `TextRun` flags), so branch 1
  changed no existing golden.
  - *Implemented (branch 2, `feat/a18-text`):* exactly the two compile goldens changed, as listed. The new documents are `corpus/text/markdown.sgl` and `corpus/text/wrap.sgl` (in a subdirectory, so the suites over `CLEAN_DOCS` leave them out); `render-svg/test/rich-corpus.test.ts` gives them, and `multiline.sgl`, compile, `grid` and `elk` goldens through the rich pipeline, under `render-svg/test/__goldens__/rich/`. Their render goldens, and `injection/markdown-in-label.sgl`, are the render branch's. The suites over `CLEAN_DOCS` compile without the parser, as every existing golden always has; the T13 scan proves the two agree on every other document.

---

## 15. Diagnostics

- **T59. No new codes.**
  - An unterminated `"""` is `SGL1003` (T19).
  - `\*` and `` \` `` stop being `SGL1004` (T11). Every other unknown escape still is.
  - An unclosed or unmatched marker stays literal **silently**, as it does in CommonMark. A warning
    on `a*b` or `2 * 3` would fire on legitimate text, and DD-09 §3.4 would need a fixture for
    noise.
  - Overflow is not reported. It can only come from a single unit wider than the wrap width
    (T37), and the label is still drawn in full, as an overflowing label is today.
  - If §18's option (b) or (c) is chosen, `@markdown`'s type and scope use the existing `SGL2011`
    and `SGL2012`.

  *Each case either already has a code whose message fits, or should not be a diagnostic at all.
  That keeps A18 off the catalogue A9 is also growing.*
  - *Implemented (branch 2, `feat/a18-text`):* no new code.

---

## 16. Phase 2: branches and tests

- **T60. Three branches, each with its own T1+T2 gate, and `main` green after each.**
  - **Branch 0 is someone else's:** F20's lazy `DocumentsMenu`, A9's first commit. Branch 3 depends
    on it for bytes. Branch 1 depends on A9's grammar commit (§4.3).

  1. **`feat/a18-grammar`**, from `main` after A9's grammar lands. It contains the `MultilineString`
     token, dedent, CRLF, the `\*` and `` \` `` escapes, `SGL1003` for an unterminated `"""`,
     `scanLexicalErrors`, editor tags and folding, and DD-01 and language-spec updates. Labels
     still render as literal text.
     - Tests:
       - the T16 table as lexer tests;
       - a T17 dedent table: first line, closing-line indent, tabs against spaces, blank lines,
         CRLF, escapes after dedent, `SGL1004` offsets;
       - the whole corpus parses unchanged, and every `.sgl.json` has zero diagnostics;
       - `lezer-generator --strict`;
       - the malformed fixture;
       - CodeMirror closing `"""` (checked in the e2e editor);
       - a double-run test.
  2. **`feat/a18-text`**. It contains:
     - the `@sgl/text` package, its boundaries and the moved types and keys;
     - `@sgl/core/inline` and `compile`'s `inline` option;
     - the `TextRun` flags, and the `unicode.sgl` golden with the T58 proof;
     - `contentInsets` and `labelMaxWidth` in core;
     - `layoutLines`, `layoutWrapped`, `runStyle` and `labelBox`;
     - the renderer's hard-break split of runs containing `\n`, needed to keep `main` green.

     The app does not pass the parser yet, so users see no change.
     - Tests:
       - a §2.2 table test;
       - fast-check properties:
         - `parseInline` never throws;
         - text without `*` or `` ` `` gives one run;
         - escaping every `*` and `` ` `` gives back the literal text;
         - output is canonical (T21);
         - removing markers is the only change to `plainText`;
       - `layoutWrapped(maxWidth undefined) ≡ layoutLines`, and for every corpus label
         `layoutLines` equals the MVP line model output;
       - for random text and widths: every line fits unless it is one unit, and the lines plus the
         dropped break whitespace rebuild the text;
       - T37 boundary cases;
       - the `labelMaxWidth` containment property against `contentInsets`, per shape;
       - premeasure 100 % coverage on the corpus including the new documents (DD-00 §6);
       - a double-run test.
  3. **`feat/a18-render`**. It contains:
     - `render(…, text)`, nested tspans, run rules, `structureHash` marks, the paint plan and
       `renderPaintOnly`'s guard;
     - the `rich-text` lazy chunk and both gates in `pipeline.ts`;
     - the fonts (`fonts.css`, `SHIPPED`, licence, precache);
     - T50's per-element face selection;
     - `size-limit` and `check-core-chunks`;
     - DD-05, DD-07, DD-08, DD-09 and DD-10 updates, and the §2 and F20 figures in the execution
       plan.
     - Tests:
       - render goldens for the new documents × 4 themes;
       - `paint-only.test.ts` and `paint-only-path.test.ts` over the new documents;
       - `structureHash` changing on a marks-only edit;
       - the injection corpus;
       - `CanvasMeasurer` in Chromium and Firefox with the new faces: `ready()` loads them, and a
         wrapped line's `getComputedTextLength()` is within 0.5 px of its measured width and at
         most the wrap width;
       - e2e:
         - typing `**x**` gives a tspan with computed `font-weight: 700`;
         - DD-08 §14 test 8's font gate repeated with an italic label, so cold and warm widths are
           equal;
         - a markdown document booted offline, with the chunk and the faces coming from the
           service worker;
         - Save ▾ SVG embeds exactly the used faces, and its base64 decodes to the shipped bytes;
         - PNG export draws the italic face;
       - `pnpm size` and `check-core-chunks`;
       - `pnpm bench:theme` with the rich variant, reported.

  *This follows the order the brief suggested: grammar, then the text model, then pixels. Each
  branch is reviewable alone, and only the third touches the boot bundle.*
  - *Branch 2 as built (`feat/a18-text`), by the orchestrator's brief:* everything listed for branch 2, **plus** the app half of T53 that was listed for branch 3 — the `rich-text` chunk, both gates in `pipeline.ts`, `size-limit` and `check-core-chunks` — with the offline e2e case and the never-fetched case. The app therefore passes the parser and the wrap model now: a markdown label is drawn as its runs' plain text (markers removed), and a wrapped label is laid out wrapped but drawn on its hard lines, until branch 3 draws marks and soft breaks. Branch 3 keeps T42–T50, the fonts, T57 and the rest of T54's figures.

---

## 17. Documents Phase 2 changes

Each change is made in the branch that implements it (§16).

| Document | Change |
|---|---|
| DD-00 §2 | `@sgl/text` in the module map. Rule 2 becomes the real graph (T2; also §19, item 1) |
| DD-01 §2, §3, §4, §6 | `MultilineString` and its precedence line. Dedent. `\*` and `` \` `` in the escape set. `SGL1003` for `"""`. Highlighting and folding |
| DD-02 §6 | One sentence: `"""` is not preserved in JSON (T51) |
| DD-03 §2, §6 | `TextRun` flags, the canonical form, `compile(…, options)`. The label rule: which strings are markdown (T13) |
| DD-05 §2, §3, §4 | Types moved to `@sgl/text`. `marks`. The key rule (T29). The two line models and the breaker. The measurer `lineModel` option |
| DD-06 §2 | The wrap width comes from `maxWidth` through `labelMaxWidth`. `contentInsets` now lives in core |
| DD-07 §5, §6, §9 | `render(…, text)`. Nested tspans. Run rules. `structureHash`. T50 |
| DD-08 §3, §5, §7, §12 | The `rich-text` gate and chunk. Fonts. Export faces. The precache list |
| DD-09 §1.1, §2, §3.2 | The injection row. The rich bench variant. The new corpus documents |
| DD-10 §2 | The `rich-text` chunk. The `@sgl/text` entries. The `@sgl/core/inline` entry |
| Language spec §2, §4, §9 | The subset, escapes and `"""`. Which keys are markdown |
| Architecture §3, §6 | `@sgl/text`'s real scope. The §6 sketch points to DD-05 and DD-11 (T24) |
| Execution plan §1, §2, §2.1 | The dependency graph. The branch paragraphs. F20's figures |

---

## 18. ⚑ Decisions for the human

**⚑1 (T13): how markdown is switched on.**

| Option | For | Against |
|---|---|---|
| **(a) Always on for `@label`, with the no-intraword rule (T6) and the two escapes. Recommended.** | What users expect. The language spec already says it. No switch to learn. The corpus scan changes nothing. | A pre-A18 label containing `word *x* word` or a backtick pair changes, silently. |
| (b) (a), plus a root opt-out `@markdown: false` | An escape hatch for documents with many literal stars. About 40 B. | Another key to learn, and one more registry row. |
| (c) Opt-in per document, `@markdown: true` | Nothing changes unless asked. | First-time users type `**x**` and see asterisks. Every document needs the key forever. |
| (d) Only inside `"""` strings | Nothing old changes. | A bold word in a one-line label needs `"""**x**"""`. JSON has no `"""`, so `.sgl.json` would need a flag in the model to keep meaning. |
| (e) Always on, strict CommonMark (intraword `*` allowed) | Matches other tools on every input. | `a*b*c` and `2*3*4` become italic: exactly the silent change the human asked to avoid. |

**⚑2 (T36): does a fixed `@size.width` also wrap?** Options: (a) yes, and the smaller of `width` and
`maxWidth` wins. **Recommended**, because text overflowing a fixed box is never wanted. (b) No, only
`maxWidth`, which is the decision as worded.

**⚑3 (T26): which fonts to add.**

| Option | Cost |
|---|---|
| **(a) Recommended: Inter 700, Inter 400/500/600/700 italic, IBM Plex Mono 400/700.** | About 156 kB added to the precache, and a second OFL licence file. |
| (b) As (a), with Inter italic at 400 and 700 only. | About 51 kB less. CSS font matching draws `em` in a node title (500) at 400 and in a container title (600) at 700, the same in measurement and in drawing, so it stays consistent but is less faithful. |
| (c) As (a), with JetBrains Mono instead of Plex. | About 13 kB more. |
| (d) No mono file: a system `monospace` stack. | Code measures and draws differently on every OS, and D2 cannot embed it. Not recommended. |

**⚑4 (T55): the boot budget.**

| Option | Notes |
|---|---|
| **(a) Recommended: the lazy `rich-text` chunk (T53), after F20's lazy `DocumentsMenu`.** | If A9 plus A18 still exceed 180 kB, a further trim comes first. Candidates to measure: the Theme ▾/Engine ▾ menus' bodies, and the diagnostics panel's list, as lazy chunks. |
| (b) Put A18 whole on the boot path and raise the limit, to about 182 kB. | The simplest pipeline: no gates and no chunk. It costs about 2.0–2.3 kB, and the limit in `.size-limit.js` is the human's decision. |
| (c) Ship the markup and `"""` first, and wrapping in a later release. | Under (a) this saves no boot bytes, because the breaker is lazy anyway. It only makes Phase 2 smaller. |

---

## 19. Contradictions found while designing this

1. *(Resolved by branch 2: DD-00 §2 now has the real graph and `@sgl/text`.)* **DD-00 §2, rule 2** says `theme`, `measure`, `layout-api` and `render-svg` "import only core".
   07 §1 and the code have `measure` and `render-svg` importing `theme`. DD-00 is stale.
2. *(Resolved by branch 2: architecture §6 and the backlog point to DD-05 and DD-11.)* **Architecture §6** (`TextRun.kind` with `'link'`, `TextLayout.size`, `baseline`,
   `PositionedRun`) and the **backlog's** `measureRuns(runs, box)` disagree with DD-05's
   normative `layoutRuns` and `TextLayout`, which the code implements (T24).
3. **Architecture §7** says exported fonts are "embedded as subsetted base64 WOFF2". DD-07 §9 (D2)
   says there is no subsetting.
4. *(Resolved: A9 had already brought the block in line; branch 1 re-checked it and added
   `MultilineString`.)* **DD-01 §2's grammar block** omits the `ConfigString` token, its `@precedence`, and `Variable`,
   all of which the real `sgl.grammar` has. The design notes mention `Variable`, but the block does
   not include it.
5. **DD-07 §5** positions the `<text>` at `frame.y + layout.ascent` from the label's `TextLayout`.
   `render()` has never been given one: `layout-view.ts` says so, and neither the app nor the test
   pipeline supplies `placement.text`. The shipped renderer, and so the live app and every golden,
   uses `0.8 × fontSize`, while the measured `TextLayout` carries Inter's real ascent, about 0.97 em. T42 keeps
   today's behaviour. Adopting the measured ascent would move every label by about 2 px and change
   every render golden. That is worth a finding of its own (owner: whoever next touches DD-07 §5),
   not a side effect of A18.
6. *(Resolved by branch 2: DD-02 §7 lists exactly `SIZE_KEYS`; DD-06 §2 notes that `max.h` is never set.)* **DD-02 §7's registry** lists `maxHeight` in `@size`. `SIZE_KEYS` (`config-registry.ts`) and
   language spec §4 do not, and DD-06 §2 reads `g.maxHeight` anyway.
7. *(Resolved by branch 2: DD-03 §2 and §6 and DD-05 §2–§3 describe the canonical runs and the two line models.)* **DD-05 §3 and DD-03 §6** say a plain label is "one run per line". T21 changes that, and DD-03 §6
   also says "`LabelSpec` does not change shape". Both documents are updated in branch 2: the
   `LabelSpec` shape holds, and the `TextRun` shape changes.
8. **DD-07 §9** says "an italic with only a normal face embeds the normal one, which the viewer
   slants". That stays true for user fonts, but once T26 ships italics, the Inter case is a real
   italic face.
9. *(Found by branch 2, resolved there.)* **The theme registry had no `maxWidth` row**, although
   language spec §4, `SIZE_KEYS` and DD-04 §4 step 6 all list `@size.maxWidth`: the cascade dropped it
   with `SGL5003`, so no node could have a `maxWidth` and T35 had nothing to read. DD-04 §2 and the
   registry now have the row.
10. *(Found by branch 2; resolved by human decision H2 in fix round 1.)* **DD-02 §7 accepts `@size`
    on a class, and T35 says a class's `@size` counts, but DD-04 §4 step 6 applied only a node's own
    `@size`**: a class's `@size` validated and did nothing. H2: it applies, merged at DD-04 §4 step
    4 in `@type` order, the node's own `@size` overriding per key; DD-02 §7, DD-04 §4 and spec §6
    say so.
11. *(Found by branch 2.)* **T13 says markdown covers "`@label` set by a class"**, but a class's
    `@label` never reaches a node's title (DD-03 §6 reads the node's own `config`). Nothing to
    parse; recorded under T13.
