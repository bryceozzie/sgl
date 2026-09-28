/**
 * The drawer's eight categories (DD-13 P1), in drawer order, and which one an
 * entry belongs to. DOM-free; part of the lazy `help` chunk.
 */

import type { HelpTableEntry } from './join.js';
import { QUICKSTART_ID } from './join.js';

export const CATEGORIES = [
  { id: 'quickstart', title: 'Quick start' },
  { id: 'topics', title: 'Language topics' },
  { id: 'keys', title: '@ keys' },
  { id: 'styles', title: 'Style properties' },
  { id: 'shapes', title: 'Shapes' },
  { id: 'engines', title: 'Layout engines' },
  { id: 'themes', title: 'Themes and tokens' },
  { id: 'diagnostics', title: 'Diagnostics' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];

const BY_KIND: Readonly<Record<HelpTableEntry['kind'], CategoryId>> = {
  topic: 'topics',
  key: 'keys',
  style: 'styles',
  shape: 'shapes',
  engine: 'engines',
  option: 'engines',
  hint: 'engines',
  theme: 'themes',
  token: 'themes',
  diag: 'diagnostics',
};

export function categoryOf(entry: HelpTableEntry): CategoryId {
  return entry.id === QUICKSTART_ID ? 'quickstart' : BY_KIND[entry.kind];
}

/** Kinds the home lists; options and hints are listed in their engine's
 *  entry, tokens in their theme's (DD-13 P17), and all are searched. */
const LISTED = new Set<HelpTableEntry['kind']>(['topic', 'key', 'style', 'shape', 'engine', 'theme', 'diag']);

export interface CategoryGroup {
  readonly category: CategoryId;
  readonly title: string;
  readonly entries: readonly HelpTableEntry[];
}

/** The home view's sections (DD-13 P35), in drawer order, each in the table's order; empty ones left out. */
export function homeCategories(entries: readonly HelpTableEntry[]): readonly CategoryGroup[] {
  return CATEGORIES.map((c) => ({ category: c.id, title: c.title, entries: entries.filter((e) => LISTED.has(e.kind) && categoryOf(e) === c.id) })).filter((g) => g.entries.length > 0);
}

export function categoryTitle(id: CategoryId): string {
  return CATEGORIES.find((c) => c.id === id)!.title;
}
