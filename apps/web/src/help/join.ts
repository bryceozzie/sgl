/**
 * `joinHelp` (DD-13 P15): the generated reference facts (`buildReference`,
 * help branch 1) joined by id to the hand-written entries (`compileHelp`,
 * `build/help-content.ts`). Pure and DOM-free; it runs in the lazy help chunk
 * and under the Node drift tests, which call exactly this.
 *
 * - **Generated only:** a fact with no hand-written entry. For a kind whose
 *   prose is required, that fails `help-drift.test.ts`, so it never ships.
 * - **Hand-written only:** a topic, the quick start (`topic/quickstart`)
 *   among them.
 * - **Both:** a fact with its prose.
 *
 * A hand-written entry of a generated kind that names no fact is kept aside in
 * `unmatched`, for the drift test to report (DD-13 P17 item 2).
 *
 * **Aliases.** `@style`'s sub-keys are the style facts: `key/style.fill` is
 * the entry `style/fill` under a second id (DD-13 P6; help branch 1's note),
 * so `get('key/style.fill')` returns `style/fill`'s entry, whose `aliases`
 * list the second id.
 *
 * **Only the help chunks may import this module** (`test/reference-boot.test.ts`).
 */

import type { DiagFact, EngineFact, KeyFact, OptionFact, Reference, ShapeFact, StyleFact, ThemeFact, TokenFact } from '../reference/types.js';
import type { HelpContent, HelpEntry, HelpKind } from './content.js';

/** A fact, tagged with its kind. Hints (`hint/grid.columns`) are facts with no prose of their own. */
export type HelpFact =
  | { readonly kind: 'key'; readonly fact: KeyFact }
  | { readonly kind: 'style'; readonly fact: StyleFact }
  | { readonly kind: 'shape'; readonly fact: ShapeFact }
  | { readonly kind: 'engine'; readonly fact: EngineFact }
  | { readonly kind: 'option'; readonly fact: OptionFact }
  | { readonly kind: 'hint'; readonly fact: OptionFact }
  | { readonly kind: 'theme'; readonly fact: ThemeFact }
  | { readonly kind: 'token'; readonly fact: TokenFact }
  | { readonly kind: 'diag'; readonly fact: DiagFact };

export interface HelpTableEntry {
  readonly id: string;
  readonly kind: HelpKind | 'hint';
  /** The hand-written title, or the fact's written form (`@size.maxWidth`, `SGL2010`). */
  readonly title: string;
  readonly fact?: HelpFact;
  readonly content?: HelpEntry;
  /** Other ids that resolve to this entry: `key/style.fill` for `style/fill`. */
  readonly aliases: readonly string[];
}

export interface HelpTable {
  /** The quick start, then the other topics, then the facts in the reference's order by kind. */
  readonly entries: readonly HelpTableEntry[];
  /** Hand-written entries of a generated kind that name no fact. Empty in a build that passed its tests. */
  readonly unmatched: readonly HelpEntry[];
  /** The entry an id, or an alias, names. */
  get(id: string): HelpTableEntry | undefined;
}

export const QUICKSTART_ID = 'topic/quickstart';

/** The alias `@style`'s sub-key ids give a style fact (DD-13 P6). */
const styleAlias = (name: string): string => `key/style.${name}`;

/** Every fact of the reference, in its order by kind (DD-13 P1's categories). */
export function referenceFacts(reference: Reference): readonly HelpFact[] {
  return [
    ...reference.keys.map((fact) => ({ kind: 'key' as const, fact })),
    ...reference.styles.map((fact) => ({ kind: 'style' as const, fact })),
    ...reference.shapes.map((fact) => ({ kind: 'shape' as const, fact })),
    ...reference.engines.map((fact) => ({ kind: 'engine' as const, fact })),
    ...reference.engines.flatMap((e) => e.options.map((fact) => ({ kind: 'option' as const, fact }))),
    ...reference.engines.flatMap((e) => e.hints.map((fact) => ({ kind: 'hint' as const, fact }))),
    ...reference.themes.map((fact) => ({ kind: 'theme' as const, fact })),
    ...reference.tokens.map((fact) => ({ kind: 'token' as const, fact })),
    ...reference.diagnostics.map((fact) => ({ kind: 'diag' as const, fact })),
  ];
}

/** Every id the reference answers to, aliases included: what a link may name besides a topic. */
export function referenceIds(reference: Reference): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const f of referenceFacts(reference)) ids.add(f.fact.id);
  for (const s of reference.styles) ids.add(styleAlias(s.name));
  return ids;
}

function factTitle(f: HelpFact): string {
  switch (f.kind) {
    case 'key':
    case 'style':
    case 'option':
    case 'hint':
    case 'token':
      return f.fact.written;
    case 'shape':
    case 'engine':
    case 'theme':
      return f.fact.name;
    case 'diag':
      return f.fact.code;
  }
}

export function joinHelp(reference: Reference, content: HelpContent): HelpTable {
  const written = new Map(content.entries.map((e) => [e.id, e]));
  const facts = referenceFacts(reference);
  const factIds = new Set(facts.map((f) => f.fact.id));

  const topics = content.entries.filter((e) => e.kind === 'topic');
  topics.sort((a, b) => Number(b.id === QUICKSTART_ID) - Number(a.id === QUICKSTART_ID));
  const entries: HelpTableEntry[] = [
    ...topics.map((e) => ({ id: e.id, kind: e.kind, title: e.title, content: e, aliases: [] })),
    ...facts.map((f) => {
      const prose = written.get(f.fact.id);
      return {
        id: f.fact.id,
        kind: f.kind,
        title: prose?.title ?? factTitle(f),
        fact: f,
        ...(prose !== undefined && { content: prose }),
        aliases: f.kind === 'style' ? [styleAlias(f.fact.name)] : [],
      };
    }),
  ];
  const unmatched = content.entries.filter((e) => e.kind !== 'topic' && !factIds.has(e.id));

  const byId = new Map<string, HelpTableEntry>();
  for (const e of entries) {
    byId.set(e.id, e);
    for (const a of e.aliases) byId.set(a, e);
  }
  return { entries, unmatched, get: (id) => byId.get(id) };
}
