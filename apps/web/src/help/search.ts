/**
 * The drawer's search (DD-13 P36): fuzzy, in-house, no dependency. DOM-free;
 * part of the lazy `help` chunk.
 *
 * The index is built once from the joined entries. Each entry is searched by
 * its id's name (`size.maxWidth`, `SGL2010`), its written form
 * (`@size.maxWidth`), its title, its aliases (the `Aliases:` line, and a
 * second id such as `key/style.fill`), and, weighing less, the words of its
 * summary (or, for a code with no prose yet, of its message template).
 *
 * A field matches when every query character appears in it, in order,
 * ignoring case. Its score counts each character, with bonuses for a
 * character at a word boundary (the start, after `.`, `@`, `-`, `_`, `/` or a
 * space, a camelCase hump, or the edge of a digit run), for consecutive
 * characters, for a prefix (of the text, or of one of its dotted segments),
 * for an exact match and for matching a whole word. An entry scores its best
 * field; equal scores are ordered by id. A leading `@` in the query is
 * ignored, so `maxw` and `@maxw` both find `@size.maxWidth`, and `2010` finds
 * `SGL2010`.
 */

import { categoryOf, categoryTitle, type CategoryGroup, type CategoryId } from './categories.js';
import { runsText } from './content.js';
import type { HelpTableEntry } from './join.js';

/** At most this many results are shown (DD-13 P36). */
export const MAX_RESULTS = 50;

const NAME_WEIGHT = 1;
const TITLE_WEIGHT = 0.9;
const ALIAS_WEIGHT = 0.7;
const SUMMARY_WEIGHT = 0.3;

interface Field {
  readonly text: string;
  readonly lower: string;
  readonly weight: number;
}

interface Doc {
  readonly entry: HelpTableEntry;
  readonly fields: readonly Field[];
}

export interface SearchIndex {
  readonly docs: readonly Doc[];
}

export interface SearchResult {
  /** The shown results, in display order: grouped by category, best group first, best first within a group. */
  readonly results: readonly HelpTableEntry[];
  readonly groups: readonly CategoryGroup[];
  /** Every matching entry, shown or not. */
  readonly total: number;
}

/** The query as matched: trimmed, lower-cased, without a leading `@`. */
export function normaliseQuery(query: string): string {
  return query.trim().replace(/^@+/, '').trim().toLowerCase();
}

const SEPARATOR = /[.@\-_/\s:#]/;
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

/** Whether a word starts at `i` of `text`. */
function boundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  if (SEPARATOR.test(prev)) return true;
  if (isUpper(cur) && !isUpper(prev)) return true;
  return isDigit(cur) !== isDigit(prev);
}

/** Whether a word ends at `i` (exclusive) of `text`. */
function wordEnd(text: string, i: number): boolean {
  return i === text.length || boundary(text, i);
}

/**
 * How well `query` (already normalised) matches `text`, or `null` when it
 * does not: some character of the query is missing, or out of order.
 */
export function fieldScore(query: string, text: string): number | null {
  const n = query.length;
  const m = text.length;
  if (n === 0 || n > m) return null;
  const lower = text.toLowerCase();
  // best[j]: the best score for the query so far with its last character at j.
  let prev: number[] = new Array<number>(m).fill(-Infinity);
  for (let j = 0; j < m; j += 1) if (lower[j] === query[0]) prev[j] = 1 + (boundary(text, j) ? 3 : 0);
  for (let i = 1; i < n; i += 1) {
    const next = new Array<number>(m).fill(-Infinity);
    let bestBefore = -Infinity; // max of prev[k] for k < j - 1
    for (let j = 1; j < m; j += 1) {
      if (j >= 2) bestBefore = Math.max(bestBefore, prev[j - 2]!);
      if (lower[j] !== query[i]) continue;
      const base = 1 + (boundary(text, j) ? 3 : 0);
      next[j] = Math.max(prev[j - 1]! + base + 2, bestBefore + base);
    }
    prev = next;
  }
  let score = Math.max(...prev);
  if (score === -Infinity) return null;
  if (lower === query) score += 15;
  // A prefix of the text, or of one of its dotted segments: `maxw` in
  // `size.maxWidth` as in `maxWidth`.
  else if (lower.split('.').some((segment) => segment.replace(/^@/, '').startsWith(query))) score += 5;
  // The query is a whole word of the text: `dash` in `strokeDash`, `2010` in `SGL2010`.
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, at + 1)) {
    if (boundary(text, at) && wordEnd(text, at + n)) {
      score += 4;
      break;
    }
  }
  return score;
}

function field(text: string, weight: number): Field {
  return { text, lower: text.toLowerCase(), weight };
}

function fieldsOf(entry: HelpTableEntry): Field[] {
  const name = entry.id.slice(entry.id.indexOf('/') + 1);
  const fields = [field(name, NAME_WEIGHT), field(entry.title, TITLE_WEIGHT)];
  const fact = entry.fact?.fact;
  if (fact !== undefined && 'written' in fact) fields.push(field(fact.written, NAME_WEIGHT));
  for (const a of entry.aliases) fields.push(field(a.slice(a.indexOf('/') + 1), NAME_WEIGHT));
  for (const a of entry.content?.aliases ?? []) fields.push(field(a, ALIAS_WEIGHT));
  const summary = entry.content !== undefined ? runsText(entry.content.summary) : entry.fact?.kind === 'diag' ? entry.fact.fact.template : '';
  for (const word of new Set(summary.split(/[^\p{L}\p{N}@.]+/u))) if (word.length > 1) fields.push(field(word.replace(/\.$/, ''), SUMMARY_WEIGHT));
  return fields;
}

export function buildSearchIndex(entries: readonly HelpTableEntry[]): SearchIndex {
  return { docs: entries.map((entry) => ({ entry, fields: fieldsOf(entry) })) };
}

function docScore(doc: Doc, query: string): number | null {
  let best: number | null = null;
  for (const f of doc.fields) {
    const s = fieldScore(query, f.text);
    if (s !== null && (best === null || s * f.weight > best)) best = s * f.weight;
  }
  return best;
}

/** The results for `query`, or `undefined` for a blank one: the drawer then shows the categories (DD-13 P35). */
export function searchHelp(index: SearchIndex, query: string): SearchResult | undefined {
  const q = normaliseQuery(query);
  if (q === '') return undefined;
  const scored: { readonly entry: HelpTableEntry; readonly score: number }[] = [];
  for (const doc of index.docs) {
    const score = docScore(doc, q);
    if (score !== null) scored.push({ entry: doc.entry, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
  const shown = scored.slice(0, MAX_RESULTS);
  const byCategory = new Map<CategoryId, HelpTableEntry[]>();
  for (const { entry } of shown) {
    const c = categoryOf(entry);
    const list = byCategory.get(c);
    if (list === undefined) byCategory.set(c, [entry]);
    else list.push(entry);
  }
  const groups = [...byCategory].map(([category, entries]) => ({ category, title: categoryTitle(category), entries }));
  return { results: groups.flatMap((g) => g.entries), groups, total: scored.length };
}
