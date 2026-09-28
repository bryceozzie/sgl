import { describe, expect, it } from 'vitest';
import { compileHelpDir } from '../build/help-plugin.js';
import { compileHelp } from '../build/help-content.js';
import { joinHelp } from '../src/help/join.js';
import { explainedBy, helpHref, idFromHref, resolveLink } from '../src/help/links.js';
import { REGISTERED_ENGINES } from '../src/io/app-boot.js';
import { buildReference } from '../src/reference/build.js';

/**
 * DD-13 P12, P42 (help branch 4): internal links between entries. A link is
 * `#help/<id>`; the drawer resolves it against the id table only, aliases
 * included, and never renders the name as markup.
 */

const reference = buildReference(REGISTERED_ENGINES);
const table = joinHelp(reference, compileHelpDir());

describe('help links', () => {
  it('an id round-trips through its href, percent-encoded where it must be', () => {
    for (const id of ['key/size.maxWidth', 'diag/SGL2010', 'topic/quickstart', 'token/surface.sunken', 'key/pin']) {
      expect(helpHref(id).startsWith('#help/')).toBe(true);
      expect(idFromHref(helpHref(id))).toBe(id);
    }
    expect(helpHref('key/a b')).toBe('#help/key/a%20b');
    expect(idFromHref('#help/key/a%20b')).toBe('key/a b');
  });

  it('only a #help/ href is a help link; a malformed escape is not', () => {
    expect(idFromHref('#s=abc')).toBeUndefined();
    expect(idFromHref('https://example.com/#help/key/pin')).toBeUndefined();
    expect(idFromHref('#help/')).toBeUndefined();
    expect(idFromHref('#help/key/%E0%A4%A')).toBeUndefined();
  });

  it('resolves an id, or an alias, to its entry; an unknown id to nothing', () => {
    expect(resolveLink(table, 'key/pin')?.id).toBe('key/pin');
    expect(resolveLink(table, 'key/style.fill')?.id).toBe('style/fill');
    expect(resolveLink(table, 'key/nope')).toBeUndefined();
    expect(resolveLink(table, '<script>')).toBeUndefined();
  });

  it('every link in the real content resolves (the build checked them; the drawer agrees)', () => {
    const targets: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        if ('link' in value && typeof (value as { link: unknown }).link === 'string') targets.push((value as { link: string }).link);
        Object.values(value).forEach(walk);
      }
    };
    walk(table.entries.map((e) => e.content));
    const seeAlso = table.entries.flatMap((e) => e.content?.seeAlso ?? []);
    // Today's content links only through `See also:` lines; inline links are
    // exercised by the renderer's test.
    expect(targets.length + seeAlso.length).toBeGreaterThan(10);
    for (const t of [...targets, ...seeAlso]) expect(resolveLink(table, t), t).toBeDefined();
  });

  it('a code is explained by the entries whose Diagnostics line names it (HD3, until the diag entries exist)', () => {
    const small = joinHelp(
      reference,
      compileHelp([
        { path: 'quickstart.md', text: '# Quick start {#topic/quickstart}\n\nStart.\n' },
        { path: 'keys/style.md', text: '# Style {#key/style}\n\nStyles.\n\nDiagnostics: SGL2011\n' },
      ]),
    );
    expect(explainedBy(small, 'SGL2011').map((e) => e.id)).toEqual(['key/style']);
    expect(explainedBy(small, 'SGL1001')).toEqual([]);
    // On the real content: SGL2011 is on several keys' lines.
    expect(explainedBy(table, 'SGL2011').length).toBeGreaterThan(1);
    expect(explainedBy(table, 'SGL2011').every((e) => e.content?.diagnostics.includes('SGL2011'))).toBe(true);
  });
});
