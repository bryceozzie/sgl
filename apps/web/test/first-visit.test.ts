import { describe, expect, it } from 'vitest';
import { firstVisitHelp, HELP_SHOWN_KEY, type FlagStorage } from '../src/state/first-visit.js';

/**
 * HD6 (DD-13 §14): on a first visit only — no stored document, so boot made
 * the example — the drawer opens at the quick start, and that it was shown
 * is remembered (`localStorage`, `sgl-help-shown`). Storage that fails is
 * tolerated: nothing throws, and a first visit still gets its help.
 */

function memory(seed: Record<string, string> = {}): FlagStorage & { readonly data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const example = { created: true, notices: [] } as const;

describe('the first-visit flag (HD6)', () => {
  it('a first visit (boot created the example) opens help once, and remembers it', () => {
    const storage = memory();
    expect(firstVisitHelp(example, () => storage)).toBe(true);
    expect(storage.data[HELP_SHOWN_KEY]).toBe('1');
    expect(firstVisitHelp(example, () => storage)).toBe(false);
  });

  it('a stored document (not a first visit) never opens it, and sets nothing', () => {
    const storage = memory();
    expect(firstVisitHelp({ created: false, notices: [] }, () => storage)).toBe(false);
    expect(storage.data).toEqual({});
  });

  it('a share link that made the document is not a first visit to help', () => {
    const storage = memory();
    expect(firstVisitHelp({ created: true, notices: ['share-opened'] }, () => storage)).toBe(false);
    expect(storage.data).toEqual({});
  });

  it('an invalid share link that fell back to the example is still a first visit', () => {
    expect(firstVisitHelp({ created: true, notices: ['share-invalid'] }, () => memory())).toBe(true);
  });

  it('once shown, never again, even on a later first visit', () => {
    expect(firstVisitHelp(example, () => memory({ [HELP_SHOWN_KEY]: '1' }))).toBe(false);
  });

  it('storage that throws, or is missing, is tolerated: a first visit still opens help, and nothing throws', () => {
    const throwing: FlagStorage = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(firstVisitHelp(example, () => throwing)).toBe(true);
    expect(
      firstVisitHelp(example, () => {
        throw new DOMException('denied', 'SecurityError');
      }),
    ).toBe(true);
    expect(firstVisitHelp(example, () => undefined)).toBe(true);
    // A write that fails leaves a readable store unchanged.
    const readOnly = { ...memory(), setItem: () => {
      throw new DOMException('full', 'QuotaExceededError');
    } };
    expect(firstVisitHelp(example, () => readOnly)).toBe(true);
    expect(firstVisitHelp({ created: false, notices: [] }, () => throwing)).toBe(false);
  });
});
