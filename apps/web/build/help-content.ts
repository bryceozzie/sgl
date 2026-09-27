import { sglLanguage } from '@sgl/core/editor';
import type { TextRun } from '@sgl/core';
import { parseInline } from '@sgl/core/inline';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { HELP_KINDS, type Block, type ExampleSpec, type HelpContent, type HelpEntry, type HelpKind, type List, type ListItem, type Run, type Token } from '../src/help/content.js';

/**
 * The build-time help compiler (DD-13 P10–P14): Markdown in `apps/web/help/`
 * to the typed tree the help chunks render (`src/help/content.ts`). It runs
 * in Node, at build time (`help-plugin.ts`) and under the unit tests. Nothing
 * of it reaches the browser: the output is data.
 *
 * **The subset.** Inline runs are A18's `parseInline` as is (bold, italic,
 * code), so help follows exactly the rules users learn for labels. On top of
 * it, this adds headings `#` to `###`, paragraphs (single newlines joined into
 * spaces first, since for `parseInline` a newline is a break), `-` and `1.`
 * lists two levels deep, fenced code, GFM pipe tables, `>` notes, and links
 * `[text](#help/<id>)` only, split out before `parseInline` sees the text.
 *
 * **Everything else fails the build**, with every problem reported at once as
 * `file:line: message`: raw HTML, images, external or bare URLs, a heading
 * deeper than `###`, an unclosed fence, an unknown fence language or
 * attribute, a duplicate or unknown-kind id. Nothing is ever passed through
 * as literal markup (DD-13 P12, §11).
 */

export interface HelpFile {
  /** Relative to `apps/web/help/`, with `/`: `keys/pin.md`. */
  readonly path: string;
  readonly text: string;
}

export interface CompileOptions {
  /**
   * Every id the build knows besides the content's own: the reference's
   * facts and their aliases (`referenceIds`, `src/help/join.ts`). Given, a
   * link, a `See also:` target, or an entry of a generated kind that names
   * none of them fails the build. Absent, only links to topics are checked.
   */
  readonly knownIds?: ReadonlySet<string>;
}

export class HelpBuildError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`help content: ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.join('\n')}`);
    this.name = 'HelpBuildError';
  }
}

const ID_HEADING = /^(#{1,6})\s+(.*?)\s*\{#([^}\s]*)\}\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE = /^```(.*)$/;
const LIST_ITEM = /^( *)(-|\d+\.)\s+(.*)$/;
const CODE = /^SGL\d{4}$/;
const ENGINE_NAME = /^[a-z][a-z0-9-]*$/;
const LANGUAGES = new Set(['sgl', 'json', 'text']);
const EXAMPLE_ATTRS = new Set(['title', 'engine', 'expect', 'contains', 'preview']);
const SNIPPET_ATTRS = new Set(['title']);

/** Every help id is `<kind>/<name>` (DD-13 P3). */
export function splitId(id: string): { readonly kind: string; readonly name: string } | undefined {
  const slash = id.indexOf('/');
  return slash <= 0 || slash === id.length - 1 ? undefined : { kind: id.slice(0, slash), name: id.slice(slash + 1) };
}

interface Line {
  readonly text: string;
  readonly no: number;
}

interface Ctx {
  readonly file: string;
  readonly problems: string[];
  /** Links to check once every entry is known: [target, where]. */
  readonly links: [string, string][];
  /** The entry being compiled, for example ids. */
  entryId: string;
  examples: number;
}

const fail = (ctx: Ctx, line: number, message: string): void => {
  ctx.problems.push(`${ctx.file}:${line}: ${message}`);
};

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** Code spans, as `parseInline` finds them: `[from, to)` over the text. */
function codeRanges(text: string): readonly (readonly [number, number])[] {
  const out: [number, number][] = [];
  const runAt = (i: number): number => {
    let j = i;
    while (text[j] === '`') j += 1;
    return j - i;
  };
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\\' && (text[i + 1] === '*' || text[i + 1] === '`')) i += 2;
    else if (text[i] === '`') {
      const n = runAt(i);
      let close = -1;
      for (let j = i + n; j < text.length; ) {
        const m = text[j] === '`' ? runAt(j) : 0;
        if (m === n) {
          close = j;
          break;
        }
        j += Math.max(m, 1);
      }
      if (close < 0) i += n;
      else {
        out.push([i, close + n]);
        i = close + n;
      }
    } else i += 1;
  }
  return out;
}

const HTML = /<[A-Za-z!/?]/;
const URL_LIKE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i;

/** `parseInline`'s runs, with the text outside code spans checked. */
function textRuns(ctx: Ctx, line: number, text: string): readonly TextRun[] {
  const runs = parseInline(text);
  for (const r of runs) {
    if (r.code === true) continue;
    if (HTML.test(r.text)) fail(ctx, line, `raw HTML (\`${HTML.exec(r.text)![0]}\`) is not allowed; write it in a code span if it is an example`);
    else if (URL_LIKE.test(r.text)) fail(ctx, line, 'a URL is not allowed in help: links are internal only (DD-13 §11)');
    else if (r.text.includes('](')) fail(ctx, line, 'a malformed link: a link must be [text](#help/<kind>/<name>)');
  }
  return runs;
}

const LINK = /(!?)\[([^\]]*)\]\(([^)]*)\)/g;

/** Inline text: links split out first, then `parseInline` on the rest (DD-13 P12). */
function inline(ctx: Ctx, line: number, text: string): readonly Run[] {
  const codes = codeRanges(text);
  const inCode = (i: number): boolean => codes.some(([a, b]) => i >= a && i < b);
  const out: Run[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    if (inCode(m.index)) continue;
    const [whole, bang, label, target] = m as unknown as [string, string, string, string];
    const id = /^#help\/(.+)$/.exec(target)?.[1];
    if (bang === '!') fail(ctx, line, 'an image is not allowed in help');
    else if (id === undefined || splitId(id) === undefined) fail(ctx, line, `a link must be [text](#help/<kind>/<name>), not to \`${target}\``);
    out.push(...textRuns(ctx, line, text.slice(at, m.index)));
    at = m.index + whole.length;
    if (bang === '!' || id === undefined || splitId(id) === undefined) continue;
    out.push({ link: id, runs: textRuns(ctx, line, label) });
    ctx.links.push([id, `${ctx.file}:${line}`]);
  }
  out.push(...textRuns(ctx, line, text.slice(at)));
  return out;
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/** `sgl` code highlighted with the editor's own tags (DD-13 P14), as `tok-*` classes. */
function highlight(lang: string, source: string): readonly Token[] {
  const tokens: [string, string][] = [];
  const put = (text: string, cls: string): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last[0] === cls) last[1] += text;
    else if (text !== '') tokens.push([cls, text]);
  };
  if (lang !== 'sgl') put(source, '');
  else
    highlightCode(
      source,
      sglLanguage.parser.parse(source),
      classHighlighter,
      (text, cls) => put(text, cls),
      () => put('\n', ''),
    );
  return tokens;
}

/** `name`, `name=value` and `name="value with spaces"`. */
function parseAttrs(ctx: Ctx, line: number, info: string): Map<string, string> | undefined {
  const attrs = new Map<string, string>();
  const re = /\s*([A-Za-z]+)(?:=(?:"([^"]*)"|(\S+)))?/y;
  let at = 0;
  while (at < info.length) {
    if (/^\s*$/.test(info.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(info);
    if (m === null) {
      fail(ctx, line, `cannot read the fence's attributes at \`${info.slice(at).trim()}\``);
      return undefined;
    }
    attrs.set(m[1]!, m[2] ?? m[3] ?? '');
    at = re.lastIndex;
  }
  return attrs;
}

function fence(ctx: Ctx, line: number, info: string, source: string): Block | undefined {
  const [lang = '', ...rest] = info.trim().split(/\s+/);
  if (!LANGUAGES.has(lang)) {
    fail(ctx, line, `unknown language \`${lang}\`; a fence is \`sgl\`, \`json\` or \`text\``);
    return undefined;
  }
  let attrText = rest.join(' ');
  let mode: ExampleSpec['mode'] | undefined;
  if (lang === 'sgl') {
    mode = rest[0] === 'example' || rest[0] === 'snippet' ? rest[0] : undefined;
    if (mode === undefined) {
      fail(ctx, line, 'an sgl block must be `example` or `snippet`');
      return undefined;
    }
    attrText = rest.slice(1).join(' ');
  }
  const attrs = parseAttrs(ctx, line, attrText);
  if (attrs === undefined) return undefined;
  const allowed = mode === 'example' ? EXAMPLE_ATTRS : mode === 'snippet' ? SNIPPET_ATTRS : new Set<string>();
  let ok = true;
  for (const name of attrs.keys()) {
    if (!allowed.has(name)) {
      fail(ctx, line, `unknown attribute \`${name}\`${mode === 'snippet' ? ' on a snippet' : ''}`);
      ok = false;
    }
  }
  const tokens = highlight(lang, source);
  if (mode === undefined) return ok ? { type: 'code', lang, tokens } : undefined;

  const title = attrs.get('title');
  const engine = attrs.get('engine');
  const expectText = attrs.get('expect');
  const expected = expectText === undefined ? [] : expectText.split(/[,\s]+/).filter((c) => c !== '');
  const previewText = attrs.get('preview');
  const contains = attrs.get('contains');
  const bad = (message: string): void => {
    ok = false;
    fail(ctx, line, message);
  };
  const preview = previewText !== 'false';
  if (mode === 'example' && (title === undefined || title.trim() === '')) bad('an example needs a title');
  if (engine !== undefined && !ENGINE_NAME.test(engine)) bad(`\`${engine}\` is not an engine name (a bare name: \`elk\`, \`grid\`)`);
  for (const c of expected) if (!CODE.test(c)) bad(`\`${c}\` is not a diagnostic code`);
  if (previewText !== undefined && previewText !== 'false') bad('preview takes only `preview=false`');
  if (!preview && expected.length === 0) bad('preview=false needs an expect that says why there is no preview');
  if (!ok) return undefined;
  ctx.examples += 1;
  const example: ExampleSpec = {
    id: `${ctx.entryId}#${ctx.examples}`,
    mode,
    ...(title !== undefined && { title }),
    ...(engine !== undefined && { engine }),
    expect: expected,
    ...(contains !== undefined && { contains }),
    preview,
    source,
    tokens,
  };
  return { type: 'example', example };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const isBlank = (l: Line): boolean => l.text.trim() === '';
const startsBlock = (text: string): boolean => /^#/.test(text) || text.startsWith('```') || text.startsWith('>') || text.startsWith('|') || LIST_ITEM.test(text);

function splitCells(text: string): readonly string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const codes = codeRanges(t);
  const cells: string[] = [];
  let at = 0;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '|' && !codes.some(([a, b]) => i >= a && i < b)) {
      cells.push(t.slice(at, i));
      at = i + 1;
    }
  }
  cells.push(t.slice(at));
  return cells.map((c) => c.trim());
}

function list(ctx: Ctx, lines: readonly Line[]): List | undefined {
  interface Draft {
    text: string;
    no: number;
    sub?: { ordered: boolean; items: { text: string; no: number }[] };
  }
  const items: Draft[] = [];
  let ordered: boolean | undefined;
  let lastIndent = 0;
  for (const l of lines) {
    const m = LIST_ITEM.exec(l.text);
    if (m === null) {
      // A continuation line of the last item (or of its last sub-item).
      const last = items[items.length - 1]!;
      const target = lastIndent > 0 ? last.sub!.items[last.sub!.items.length - 1]! : last;
      target.text += ` ${l.text.trim()}`;
      continue;
    }
    const indent = m[1]!.length;
    const isOrdered = m[2] !== '-';
    if (indent === 0) {
      if (ordered !== undefined && ordered !== isOrdered) {
        fail(ctx, l.no, 'a list mixes ordered and unordered items');
        return undefined;
      }
      ordered = isOrdered;
      items.push({ text: m[3]!, no: l.no });
    } else if (indent <= 3 && items.length > 0) {
      const last = items[items.length - 1]!;
      last.sub ??= { ordered: isOrdered, items: [] };
      if (last.sub.ordered !== isOrdered) {
        fail(ctx, l.no, 'a list mixes ordered and unordered items');
        return undefined;
      }
      last.sub.items.push({ text: m[3]!, no: l.no });
    } else {
      fail(ctx, l.no, 'lists are two levels deep: a sub-item is indented 2 or 3 spaces under its item');
      return undefined;
    }
    lastIndent = indent;
  }
  const toItem = (d: Draft): ListItem => ({
    runs: inline(ctx, d.no, d.text),
    ...(d.sub !== undefined && { sub: { ordered: d.sub.ordered, items: d.sub.items.map((s) => ({ runs: inline(ctx, s.no, s.text) })) } }),
  });
  return { ordered: ordered ?? false, items: items.map(toItem) };
}

/** Blocks from lines; `inNote` for a `>` note's body. */
function blocks(ctx: Ctx, lines: readonly Line[], inNote: boolean): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const text = l.text;
    const fenceStart = FENCE.exec(text);
    if (fenceStart !== null) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j]!.text.trimEnd() !== '```') body.push(lines[j++]!.text);
      if (j >= lines.length) {
        fail(ctx, l.no, 'unclosed fence: no closing ``` before the next entry or the end of the file');
        return out;
      }
      const b = fence(ctx, l.no, fenceStart[1]!, body.join('\n'));
      if (b !== undefined) out.push(b);
      i = j + 1;
      continue;
    }
    if (text.startsWith('#')) {
      const m = HEADING.exec(text);
      if (inNote) fail(ctx, l.no, 'a note cannot hold a heading');
      else if (m === null || m[1]!.length > 3) fail(ctx, l.no, 'a heading deeper than ### is not allowed');
      else out.push({ type: 'heading', level: m[1]!.length as 1 | 2 | 3, runs: inline(ctx, l.no, m[2]!) });
      i += 1;
      continue;
    }
    if (text.startsWith('>')) {
      const inner: Line[] = [];
      while (i < lines.length && lines[i]!.text.startsWith('>')) {
        const t = lines[i]!.text;
        inner.push({ text: t.slice(t.startsWith('> ') ? 2 : 1), no: lines[i]!.no });
        i += 1;
      }
      out.push({ type: 'note', blocks: blocks(ctx, inner, true) });
      continue;
    }
    if (text.startsWith('|')) {
      const rows: Line[] = [];
      while (i < lines.length && lines[i]!.text.startsWith('|')) rows.push(lines[i++]!);
      const head = splitCells(rows[0]!.text);
      const sep = rows[1] === undefined ? undefined : splitCells(rows[1].text);
      if (sep === undefined || !sep.every((c) => /^:?-{3,}:?$/.test(c))) {
        fail(ctx, l.no, 'a table needs a separator row (`|---|---|`) under its header');
        continue;
      }
      if (sep.length !== head.length) fail(ctx, rows[1]!.no, `${head.length} cells expected, ${sep.length} found`);
      const body = rows.slice(2).map((r) => {
        const cells = splitCells(r.text);
        if (cells.length !== head.length) fail(ctx, r.no, `${head.length} cells expected, ${cells.length} found`);
        return cells.map((c) => inline(ctx, r.no, c));
      });
      out.push({ type: 'table', head: head.map((c) => inline(ctx, l.no, c)), rows: body });
      continue;
    }
    if (LIST_ITEM.test(text)) {
      const items: Line[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const t = lines[i]!.text;
        if (items.length > 0 && !LIST_ITEM.test(t) && startsBlock(t)) break;
        items.push(lines[i++]!);
      }
      const made = list(ctx, items);
      if (made !== undefined) out.push({ type: 'list', ...made });
      continue;
    }
    // A paragraph: its lines joined with spaces (DD-13 P12).
    const para: Line[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (para.length === 0 || !startsBlock(lines[i]!.text))) para.push(lines[i++]!);
    out.push({ type: 'paragraph', runs: inline(ctx, l.no, para.map((p) => p.text.trim()).join(' ')) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** The first paragraph's source line, for the special-line checks. */
function specialLine(ctx: Ctx, block: Block, no: number): { aliases?: string[]; seeAlso?: string[]; diagnostics?: string[] } | undefined {
  if (block.type !== 'paragraph') return undefined;
  const first = block.runs[0];
  if (first === undefined || 'link' in first || first.code === true || first.strong === true || first.em === true) return undefined;
  const m = /^(Aliases|See also|Diagnostics):\s*/.exec(first.text);
  if (m === null) return undefined;
  const rest: Run[] = [{ ...first, text: first.text.slice(m[0].length) }, ...block.runs.slice(1)];
  if (m[1] === 'Aliases') {
    return { aliases: rest.map((r) => ('link' in r ? '' : r.text)).join('').split(',').map((a) => a.trim()).filter((a) => a !== '') };
  }
  if (m[1] === 'See also') {
    const ids: string[] = [];
    for (const r of rest) {
      if ('link' in r) ids.push(r.link);
      else if (r.text.replace(/,/g, '').trim() !== '') {
        fail(ctx, no, 'See also: holds only links, separated by commas');
        return {};
      }
    }
    return { seeAlso: ids };
  }
  const codes = rest.map((r) => ('link' in r ? '' : r.text)).join('').split(/[,\s]+/).filter((c) => c !== '');
  for (const c of codes) if (!CODE.test(c)) fail(ctx, no, `\`${c}\` is not a diagnostic code`);
  return { diagnostics: codes };
}

interface Draft {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly line: number;
  readonly body: Line[];
}

export function compileHelp(files: readonly HelpFile[], options: CompileOptions = {}): HelpContent {
  const problems: string[] = [];
  const links: [string, string][] = [];
  const entries: HelpEntry[] = [];
  const firstAt = new Map<string, string>();

  for (const f of files) {
    const ctx: Ctx = { file: f.path, problems, links, entryId: '', examples: 0 };
    const lines = f.text.replace(/\r\n?/g, '\n').split('\n').map((text, n) => ({ text, no: n + 1 }));
    const drafts: Draft[] = [];
    let inFence = false;
    for (const l of lines) {
      const m = inFence ? null : ID_HEADING.exec(l.text);
      if (m !== null) drafts.push({ id: m[3]!, title: m[2]!, level: m[1]!.length, line: l.no, body: [] });
      else if (drafts.length > 0) drafts[drafts.length - 1]!.body.push(l);
      else if (!isBlank(l)) {
        fail(ctx, l.no, 'text outside an entry: a file starts with a heading carrying its id, `# Title {#kind/name}`');
        break;
      }
      if (l.text.startsWith('```')) inFence = !inFence;
    }
    for (const d of drafts) {
      const parts = splitId(d.id);
      if (parts === undefined) {
        fail(ctx, d.line, `\`${d.id}\` is not an id: an id is \`<kind>/<name>\``);
        continue;
      }
      if (!(HELP_KINDS as readonly string[]).includes(parts.kind)) {
        fail(ctx, d.line, `unknown kind \`${parts.kind}\`; the kinds are ${HELP_KINDS.join(', ')}`);
        continue;
      }
      if (d.level > 3) fail(ctx, d.line, 'a heading deeper than ### is not allowed');
      if (HTML.test(d.title)) fail(ctx, d.line, 'raw HTML is not allowed in a heading');
      const seen = firstAt.get(d.id);
      if (seen !== undefined) {
        fail(ctx, d.line, `duplicate id \`${d.id}\` (first at ${seen})`);
        continue;
      }
      firstAt.set(d.id, `${f.path}:${d.line}`);
      ctx.entryId = d.id;
      ctx.examples = 0;
      const body = blocks(ctx, d.body, false);
      const summary = body[0];
      if (summary === undefined || summary.type !== 'paragraph' || specialLine({ ...ctx, problems: [] }, summary, d.line) !== undefined) {
        fail(ctx, d.line, `\`${d.id}\` has no summary: an entry's body starts with a paragraph (DD-13 P10)`);
        continue;
      }
      const entry = { aliases: [] as string[], seeAlso: [] as string[], diagnostics: [] as string[] };
      const rest: Block[] = [];
      for (const b of body.slice(1)) {
        const special = specialLine(ctx, b, d.line);
        if (special === undefined) rest.push(b);
        else Object.assign(entry, special);
      }
      entries.push({
        id: d.id,
        kind: parts.kind as HelpKind,
        name: parts.name,
        title: d.title,
        file: f.path,
        summary: summary.runs,
        aliases: entry.aliases,
        seeAlso: entry.seeAlso,
        diagnostics: entry.diagnostics,
        blocks: rest,
      });
    }
  }

  // Ids: a link or See also target must exist; with the build's known ids,
  // every generated-kind entry must name a fact (DD-13 P2, P17).
  const own = new Set(entries.map((e) => e.id));
  const known = options.knownIds;
  for (const [target, where] of links) {
    const kind = splitId(target)?.kind;
    if (own.has(target) || known?.has(target) === true || (known === undefined && kind !== 'topic')) continue;
    problems.push(`${where}: no help entry \`${target}\``);
  }
  if (known !== undefined) {
    for (const e of entries) {
      if (e.kind !== 'topic' && !known.has(e.id)) problems.push(`${firstAt.get(e.id)!}: \`${e.id}\` names no fact of this build (DD-13 P2)`);
    }
  }
  if (problems.length > 0) throw new HelpBuildError(problems);
  return { entries };
}
