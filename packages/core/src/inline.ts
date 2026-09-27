import type { TextRun } from './graph.js';

/**
 * The inline markdown subset (DD-11 §2): `**strong**`, `*em*`, `` `code` ``, and the
 * escapes `\*` and `` \` ``. Everything else is literal text (T12).
 *
 * `@sgl/core/inline`: a separate entry so the app can load it lazily (the
 * `rich-text` chunk, T53). `compile(model, view, { inline: parseInline })` runs it
 * on every `@label` value, after variable substitution (T1, T13, T14).
 *
 * Two passes, both linear:
 *
 * 1. **Scan** (T5, T8, T10). Left to right: `\*` and `` \` `` are literal
 *    characters; a run of N backticks opens a code span when a run of exactly N
 *    backticks follows before the next `\n`, and its content is taken as it is;
 *    a maximal run of unescaped `*` is a delimiter run, with its flanking decided
 *    from the characters on either side (T6); anything else is text.
 * 2. **Match** (T7), with a stack holding at most one `strong` and one `em`. A run
 *    that can close does so first; otherwise one that can open does; otherwise it
 *    is literal. Closing an outer mark turns the inner mark's opener into literal
 *    text, and every opener still open at the end is literal.
 *
 * The output is canonical (T21): maximal runs, none empty, flags `true` or absent.
 * An unmatched marker stays literal silently (T59).
 */

type Mark = 'strong' | 'em';
/** A piece of a delimiter run, in text order: literal stars, or a mark opening or
 *  closing. */
type Part = { readonly lit: number } | { readonly mark: Mark; readonly open: boolean };

interface Stars {
  readonly n: number;
  readonly open: boolean;
  readonly close: boolean;
  readonly parts: Part[];
}
type Item = string | { readonly code: string } | Stars;

const WHITE_SPACE = /\p{White_Space}/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** Runs of 1, 2 or 3 stars mean something (T5); 4 or more are literal. */
const MAX_DELIMITER = 3;

export function parseInline(text: string): readonly TextRun[] {
  const items: Item[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') items.push(buf);
    buf = '';
  };
  const runAt = (i: number, ch: string): number => {
    let j = i;
    while (text[j] === ch) j += 1;
    return j - i;
  };

  for (let i = 0; i < text.length; ) {
    const c = text[i] as string;
    const after = text[i + 1];
    if (c === '\\' && (after === '*' || after === '`')) {
      buf += after;
      i += 2;
    } else if (c === '`') {
      const n = runAt(i, '`');
      let close = -1;
      for (let j = i + n; j < text.length && text[j] !== '\n'; ) {
        const m = text[j] === '`' ? runAt(j, '`') : 0;
        if (m === n) {
          close = j;
          break;
        }
        j += Math.max(m, 1);
      }
      if (close < 0) buf += text.slice(i, i + n);
      else {
        let code = text.slice(i + n, close);
        if (code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) code = code.slice(1, -1);
        flush();
        items.push({ code });
      }
      i = close < 0 ? i + n : close + n;
    } else if (c === '*') {
      const n = runAt(i, '*');
      // The code points on either side of the run (T6): `[...]` keeps a
      // surrogate pair whole.
      const prev = [...text.slice(Math.max(0, i - 2), i)].pop();
      const next = i + n < text.length ? String.fromCodePoint(text.codePointAt(i + n) as number) : undefined;
      const flanks = (ch: string | undefined): boolean => ch === undefined || WHITE_SPACE.test(ch) || PUNCTUATION.test(ch);
      const meaningful = n <= MAX_DELIMITER;
      flush();
      items.push({
        n,
        open: meaningful && next !== undefined && !WHITE_SPACE.test(next) && flanks(prev),
        close: meaningful && prev !== undefined && !WHITE_SPACE.test(prev) && flanks(next),
        parts: [],
      });
      i += n;
    } else {
      buf += c;
      i += 1;
    }
  }
  flush();

  // Match (T7). `stack` is the open marks, outermost first.
  const stack: { readonly mark: Mark; readonly stars: Stars; readonly part: number }[] = [];
  const indexOf = (mark: Mark): number => stack.findIndex((o) => o.mark === mark);
  const demote = (o: (typeof stack)[number]): void => {
    o.stars.parts[o.part] = { lit: o.mark === 'strong' ? 2 : 1 };
  };
  for (const item of items) {
    if (typeof item === 'string' || 'code' in item) continue;
    const { n } = item;
    const closing: Mark[] = [];
    if (item.close) {
      if (n === 1 && indexOf('em') >= 0) closing.push('em');
      else if (n === 2 && indexOf('strong') >= 0) closing.push('strong');
      else if (n === 3) for (let k = stack.length - 1; k >= 0; k -= 1) closing.push((stack[k] as (typeof stack)[number]).mark);
    }
    if (closing.length > 0) {
      let used = 0;
      for (const mark of closing) {
        const k = indexOf(mark);
        // An inner mark still open loses its opener: its content is the outer's.
        for (const inner of stack.splice(k + 1)) demote(inner);
        stack.pop();
        item.parts.push({ mark, open: false });
        used += mark === 'strong' ? 2 : 1;
      }
      if (n > used) item.parts.push({ lit: n - used });
      continue;
    }
    const opening: Mark[] = n === 1 ? ['em'] : n === 2 ? ['strong'] : ['strong', 'em'];
    if (item.open && opening.every((m) => indexOf(m) < 0)) {
      for (const mark of opening) {
        item.parts.push({ mark, open: true });
        stack.push({ mark, stars: item, part: item.parts.length - 1 });
      }
    } else item.parts.push({ lit: n });
  }
  for (const o of stack) demote(o);

  // Emit canonical runs (T21).
  const out: TextRun[] = [];
  const on = { strong: false, em: false };
  const emit = (s: string, code: boolean): void => {
    if (s === '') return;
    const last = out[out.length - 1];
    if (last !== undefined && !!last.strong === on.strong && !!last.em === on.em && !!last.code === code) {
      out[out.length - 1] = { ...last, text: last.text + s };
      return;
    }
    out.push({ text: s, ...(on.strong && { strong: true as const }), ...(on.em && { em: true as const }), ...(code && { code: true as const }) });
  };
  for (const item of items) {
    if (typeof item === 'string') emit(item, false);
    else if ('code' in item) emit(item.code, true);
    else
      for (const part of item.parts) {
        if ('lit' in part) emit('*'.repeat(part.lit), false);
        else on[part.mark] = part.open;
      }
  }
  return out;
}
