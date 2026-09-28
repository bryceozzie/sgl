import { describe, expect, it } from 'vitest';
import { compileHelpDir } from '../build/help-plugin.js';
import { compileHelp } from '../build/help-content.js';
import { CATEGORIES, categoryOf, homeCategories } from '../src/help/categories.js';
import { joinHelp } from '../src/help/join.js';
import { buildSearchIndex, fieldScore, normaliseQuery, searchHelp } from '../src/help/search.js';
import { REGISTERED_ENGINES } from '../src/io/app-boot.js';
import { buildReference } from '../src/reference/build.js';

/**
 * DD-13 P36 (help branch 4): the drawer's search, over the entries the app
 * joins (`joinHelp(buildReference(REGISTERED_ENGINES), content)`), with the
 * real content compiled as the build compiles it.
 */

const reference = buildReference(REGISTERED_ENGINES);
const table = joinHelp(reference, compileHelpDir());
const index = buildSearchIndex(table.entries);
const ids = (query: string): readonly string[] => searchHelp(index, query)?.results.map((e) => e.id) ?? [];

describe('help search (DD-13 P36)', () => {
  it('`pin` puts key/pin first', () => {
    expect(ids('pin')[0]).toBe('key/pin');
  });

  it('`maxw` gives key/size.maxWidth first', () => {
    expect(ids('maxw')[0]).toBe('key/size.maxWidth');
  });

  it('`2010` gives diag/SGL2010 first', () => {
    expect(ids('2010')[0]).toBe('diag/SGL2010');
  });

  it('`dash` gives style/strokeDash first', () => {
    expect(ids('dash')[0]).toBe('style/strokeDash');
  });

  it('a leading `@` is ignored', () => {
    expect(ids('@pin')).toEqual(ids('pin'));
    expect(ids('@size.maxWidth')[0]).toBe('key/size.maxWidth');
    expect(normaliseQuery('  @Pin ')).toBe('pin');
  });

  it('an empty query (or only `@` and spaces) shows the categories: no result list', () => {
    expect(searchHelp(index, '')).toBeUndefined();
    expect(searchHelp(index, '  @ ')).toBeUndefined();
  });

  it('is case-insensitive, and needs every query character in order', () => {
    expect(ids('PIN')).toEqual(ids('pin'));
    expect(fieldScore('pin', 'pin')).not.toBeNull();
    expect(fieldScore('nip', 'pin')).toBeNull();
    expect(ids('zzqqxx')).toEqual([]);
  });

  it('scores an exact match over a prefix, a prefix or a word boundary over a match inside a word, and that over a scattered one', () => {
    const exact = fieldScore('dash', 'dash')!;
    const prefix = fieldScore('dash', 'dashed')!;
    const hump = fieldScore('dash', 'strokeDash')!;
    const scattered = fieldScore('dash', 'dxaxsxhx')!;
    const inside = fieldScore('dash', 'xdashx')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(inside);
    expect(hump).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
    // A digit run starts a word: `2010` in `SGL2010`.
    expect(fieldScore('2010', 'SGL2010')!).toBeGreaterThan(fieldScore('2010', 'x2x0x1x0')!);
    // After `.`: `maxw` in `size.maxWidth`.
    expect(fieldScore('maxw', 'size.maxWidth')!).toBeGreaterThan(fieldScore('maxw', 'smaxxw')!);
  });

  it('summary words weigh less than names: a name match outranks the same match in a summary', () => {
    const content = compileHelp([
      { path: 'quickstart.md', text: '# Quick start {#topic/quickstart}\n\nStart.\n' },
      { path: 'topics/a.md', text: '# Widgets {#topic/widgets}\n\nAbout gizmo things.\n' },
      { path: 'topics/b.md', text: '# Gizmo {#topic/gizmo}\n\nAbout things.\n' },
    ]);
    const small = buildSearchIndex(joinHelp(reference, content).entries.filter((e) => e.kind === 'topic'));
    expect(searchHelp(small, 'gizmo')!.results.map((e) => e.id)).toEqual(['topic/gizmo', 'topic/widgets']);
  });

  it('aliases are searched', () => {
    expect(ids('getting started')).toContain('topic/quickstart');
    // `key/style.fill` is `style/fill` under a second id.
    expect(ids('style.fill')[0]).toBe('style/fill');
  });

  it('equal scores are sorted by id, so results are stable', () => {
    const content = compileHelp([
      { path: 'quickstart.md', text: '# Quick start {#topic/quickstart}\n\nStart.\n' },
      { path: 'topics/b.md', text: '# Same {#topic/b}\n\nText.\n' },
      { path: 'topics/a.md', text: '# Same {#topic/a}\n\nText.\n' },
    ]);
    const small = buildSearchIndex(joinHelp(reference, content).entries);
    expect(searchHelp(small, 'same')!.results.map((e) => e.id)).toEqual(['topic/a', 'topic/b']);
    expect(ids('style')).toEqual(ids('style'));
  });

  it('results are grouped by category, best group first, at most 50, with a count', () => {
    const found = searchHelp(index, 'e')!;
    expect(found.results.length).toBeLessThanOrEqual(50);
    expect(found.total).toBeGreaterThan(50);
    // Each category appears as one contiguous run, in the order of the groups.
    const order = found.groups.map((g) => g.category);
    expect(new Set(order).size).toBe(order.length);
    expect(found.groups.flatMap((g) => g.entries)).toEqual(found.results);
    for (const g of found.groups) for (const e of g.entries) expect(categoryOf(e)).toBe(g.category);
    // The group holding the best result comes first.
    const pin = searchHelp(index, 'pin')!;
    expect(pin.groups[0]!.category).toBe('keys');
  });
});

describe('the categories (DD-13 P1, P35)', () => {
  it('are the eight of P1, in drawer order, the quick start first', () => {
    expect(CATEGORIES.map((c) => c.title)).toEqual(['Quick start', 'Language topics', '@ keys', 'Style properties', 'Shapes', 'Layout engines', 'Themes and tokens', 'Diagnostics']);
  });

  it('every entry has one; the home lists the quick start alone first, keys, engines and themes (not their options, hints or tokens), and every code', () => {
    const home = homeCategories(table.entries);
    expect(home.map((c) => c.category)).toEqual(CATEGORIES.map((c) => c.id).filter((id) => home.some((h) => h.category === id)));
    expect(home[0]!.entries.map((e) => e.id)).toEqual(['topic/quickstart']);
    const listed = new Set(home.flatMap((c) => c.entries.map((e) => e.id)));
    for (const k of reference.keys) expect(listed).toContain(k.id);
    for (const e of reference.engines) expect(listed).toContain(e.id);
    for (const d of reference.diagnostics) expect(listed).toContain(d.id);
    expect(listed).not.toContain('option/elk.direction');
    expect(listed).not.toContain('hint/grid.columns');
    expect(listed).not.toContain('token/accent');
    expect(categoryOf(table.get('option/elk.direction')!)).toBe('engines');
    expect(categoryOf(table.get('hint/grid.columns')!)).toBe('engines');
    expect(categoryOf(table.get('token/accent')!)).toBe('themes');
    expect(categoryOf(table.get('topic/quickstart')!)).toBe('quickstart');
  });
});
