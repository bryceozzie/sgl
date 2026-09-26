import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import type { TextRun } from '../src/graph.js';
import { parseInline } from '../src/inline.js';
import { parse } from '../src/parse.js';
import { resolve } from '../src/resolve.js';

/**
 * The inline markdown subset (DD-11 §2, T5–T14): `**strong**`, `*em*`, `` `code` ``,
 * `\*` and `` \` ``. Everything else is literal text.
 *
 * Runs are written in the §2.2 notation: `s` strong, `e` em, `c` code.
 */

type Spec = string | readonly [string, string];
/** `['bold', 's']` is `{ text: 'bold', strong: true }`; a bare string is plain. */
function runs(...spec: readonly Spec[]): TextRun[] {
  return spec.map((r) => {
    if (typeof r === 'string') return { text: r };
    const [text, marks] = r;
    return { text, ...(marks.includes('s') && { strong: true as const }), ...(marks.includes('e') && { em: true as const }), ...(marks.includes('c') && { code: true as const }) };
  });
}
const literal = (text: string): TextRun[] => [{ text }];

describe('DD-11 §2.2, row by row', () => {
  const TABLE: readonly (readonly [string, TextRun[]])[] = [
    ['**bold**', runs(['bold', 's'])],
    ['*it*', runs(['it', 'e'])],
    ['***both***', runs(['both', 'se'])],
    ['**bold *and it***', runs(['bold ', 's'], ['and it', 'se'])],
    ['*it **and bold***', runs(['it ', 'e'], ['and bold', 'se'])],
    ['a*b*c', literal('a*b*c')],
    ['2*3*4', literal('2*3*4')],
    ['2 * 3 * 4', literal('2 * 3 * 4')],
    ['*', literal('*')],
    ['**a**b', literal('**a**b')],
    ['**a**.', runs(['a', 's'], '.')],
    ['(**a**)', runs('(', ['a', 's'], ')')],
    ['**unclosed', literal('**unclosed')],
    ['*a**', literal('*a**')],
    ['**a*', literal('**a*')],
    ['**a *b** c*', runs(['a *b', 's'], ' c*')],
    ['*a *b* c*', runs(['a *b', 'e'], ' c*')],
    ['`a*b*`', runs(['a*b*', 'c'])],
    ['*see `x`*', runs(['see ', 'e'], ['x', 'ec'])],
    ['``a`b``', runs(['a`b', 'c'])],
    ['` x `', runs(['x', 'c'])],
    ['`open', literal('`open')],
    ['\\*not\\*', literal('*not*')],
    ['C:\\temp\\*.log', literal('C:\\temp*.log')],
    ['snake_case', literal('snake_case')],
    ['_x_', literal('_x_')],
    ['Line one\nLine two', literal('Line one\nLine two')],
  ];
  it.each(TABLE)('%j', (text, expected) => {
    expect(parseInline(text)).toEqual(expected);
  });
});

describe('T5, T6: delimiter runs and flanking, without intraword emphasis', () => {
  it('a run of four or more stars is literal', () => {
    expect(parseInline('****a****')).toEqual(literal('****a****'));
    expect(parseInline('*****')).toEqual(literal('*****'));
  });
  it('opens only before a non-space, after the start, a space or punctuation', () => {
    expect(parseInline('* a*')).toEqual(literal('* a*'));
    expect(parseInline('x*a*')).toEqual(literal('x*a*'));
    expect(parseInline('"*a*"')).toEqual(runs('"', ['a', 'e'], '"'));
    expect(parseInline('\t*a*\n')).toEqual(runs('\t', ['a', 'e'], '\n'));
  });
  it('closes only after a non-space, before the end, a space or punctuation', () => {
    expect(parseInline('*a *')).toEqual(literal('*a *'));
    expect(parseInline('*a*x')).toEqual(literal('*a*x'));
    expect(parseInline('*a*!')).toEqual(runs(['a', 'e'], '!'));
  });
  it('no letter or digit may touch the outside of a run: operators, wildcards and footnotes stay literal (T13)', () => {
    for (const text of ['a*b', 'x**2**y', 'un*frigging*believable', '5*6', '*.log and *.txt', 'note*', 'f(x)*g(x)', 'Café*s*']) {
      expect(parseInline(text), text).toEqual(literal(text));
    }
  });
  it('whitespace is Unicode White_Space, and punctuation is \\p{P} or \\p{S}, emoji included', () => {
    expect(parseInline('\u00a0*a*\u00a0')).toEqual(runs('\u00a0', ['a', 'e'], '\u00a0'));
    expect(parseInline('\u{1f680}*a*\u{1f680}')).toEqual(runs('\u{1f680}', ['a', 'e'], '\u{1f680}'));
    expect(parseInline('\u6771*a*')).toEqual(literal('\u6771*a*'));
  });
});

describe('T7: matching, nesting and overlap', () => {
  it('nests strong in em and em in strong', () => {
    expect(parseInline('*a **b** c*')).toEqual(runs(['a ', 'e'], ['b', 'es'], [' c', 'e']));
    expect(parseInline('**a *b* c**')).toEqual(runs(['a ', 's'], ['b', 'se'], [' c', 's']));
  });
  it('a mark cannot nest inside itself: the inner opener is literal', () => {
    expect(parseInline('**a **b** c**')).toEqual(runs(['a **b', 's'], ' c**'));
  });
  it('closing an outer mark demotes the inner opener to literal text in the outer mark', () => {
    expect(parseInline('*a **b* c**')).toEqual(runs(['a **b', 'e'], ' c**'));
  });
  it('three stars close whichever marks are open, innermost first; unused stars are literal after the close', () => {
    expect(parseInline('***a* b**')).toEqual(runs(['a', 'se'], [' b', 's']));
    // `***` opens strong, then em; closing strong first demotes em's opener
    // (T7's fixed order, where CommonMark would nest the other way round).
    expect(parseInline('***a** b*')).toEqual(runs(['*a', 's'], ' b*'));
    expect(parseInline('*a***')).toEqual(runs(['a', 'e'], '**'));
    expect(parseInline('**a***')).toEqual(runs(['a', 's'], '*'));
  });
  it('a three-star opener opens nothing if either mark is already open', () => {
    expect(parseInline('*a ***b*')).toEqual(runs(['a ***b', 'e']));
    // Found by mutation testing: the guard is "none of its marks is open", not
    // "one of them is not"; a three-star closer then closes only the em.
    expect(parseInline('*a ***b***')).toEqual(runs(['a ***b', 'e'], '**'));
    expect(parseInline('**a ***b***')).toEqual(runs(['a ***b', 's'], '*'));
  });
  it('a hard break does not close a mark', () => {
    expect(parseInline('**Line one\nLine two**')).toEqual(runs(['Line one\nLine two', 's']));
  });
  it('every opener still open at the end is literal', () => {
    expect(parseInline('**a *b')).toEqual(literal('**a *b'));
    expect(parseInline('*a **b* c')).toEqual(runs(['a **b', 'e'], ' c'));
  });
});

describe('T8: code spans', () => {
  it('bind first, and nothing inside them is parsed', () => {
    expect(parseInline('`**x**`')).toEqual(runs(['**x**', 'c']));
    expect(parseInline('`\\*`')).toEqual(runs(['\\*', 'c']));
    expect(parseInline('*a `b*` c*')).toEqual(runs(['a ', 'e'], ['b*', 'ec'], [' c', 'e']));
  });
  it('need a closing run of exactly the same length on the same line', () => {
    expect(parseInline('``a`')).toEqual(literal('``a`'));
    expect(parseInline('`a``b`')).toEqual(runs(['a``b', 'c']));
    expect(parseInline('`a\nb`')).toEqual(literal('`a\nb`'));
    expect(parseInline('`a` `b`')).toEqual(runs(['a', 'c'], ' ', ['b', 'c']));
  });
  it('strip one space from each end only when both ends have one and it is not all spaces', () => {
    expect(parseInline('`  a  `')).toEqual(runs([' a ', 'c']));
    expect(parseInline('` a`')).toEqual(runs([' a', 'c']));
    expect(parseInline('`   `')).toEqual(runs(['   ', 'c']));
  });
  it('carry strong and em from around them', () => {
    expect(parseInline('***`x`***')).toEqual(runs(['x', 'sec']));
  });
  it('an escaped backtick opens nothing', () => {
    expect(parseInline('\\`a`')).toEqual(literal('`a`'));
  });
});

describe('T9–T12: escapes, underscores and everything else', () => {
  it('only \\* and \\` are escapes; every other backslash is literal, \\\\ included', () => {
    // `\\` is not an escape, so the second backslash escapes the star.
    expect(parseInline('\\\\*a*')).toEqual(literal('\\*a*'));
    expect(parseInline('a\\b \\n \\_x\\_')).toEqual(literal('a\\b \\n \\_x\\_'));
    expect(parseInline('**\\*x\\***')).toEqual(runs(['*x*', 's']));
  });
  it('underscores are literal, single or double', () => {
    for (const text of ['_x_', '__x__', 'snake_case_name', '_id_']) expect(parseInline(text)).toEqual(literal(text));
  });
  it('links, headings, lists, images, HTML, entities, strikethrough and autolinks are literal', () => {
    for (const text of ['~~x~~', '[a](b)', '# h', '- item', '1. item', '![i](u)', '<b>x</b>', '&amp;', '<https://x.y>', 'two  \nspaces']) {
      expect(parseInline(text), text).toEqual(literal(text));
    }
  });
});

describe('properties', () => {
  const alphabet = fc.constantFrom('a', 'b', ' ', '*', '*', '**', '`', '\\', '\n', '.', '_', '\u6771', '\u{1f642}', '\u00a0');
  const text = fc.array(alphabet, { maxLength: 24 }).map((a) => a.join(''));

  it('never throws', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), (s) => void parseInline(s)));
    fc.assert(fc.property(text, (s) => void parseInline(s)));
  });

  it('text without * or ` is one plain run, or none when empty', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }).filter((s) => !/[*`]/.test(s)), (s) => {
      expect(parseInline(s)).toEqual(s === '' ? [] : [{ text: s }]);
    }));
  });

  it('escaping every * and ` gives back the literal text', () => {
    fc.assert(fc.property(text, (s) => {
      const escaped = s.replace(/[*`]/g, (c) => `\\${c}`);
      // A backslash already before a star would make `\\*`: that pair is not an escape of the star.
      if (/\\\\[*`]/.test(escaped)) return;
      expect(parseInline(escaped)).toEqual(s === '' ? [] : [{ text: s }]);
    }));
  });

  it('the output is canonical: maximal runs, none empty, flags true or absent, code never spans \\n', () => {
    fc.assert(fc.property(text, (s) => {
      const out = parseInline(s);
      out.forEach((run, i) => {
        expect(run.text).not.toBe('');
        for (const k of Object.keys(run)) expect(['text', 'strong', 'em', 'code']).toContain(k);
        for (const k of ['strong', 'em', 'code'] as const) if (k in run) expect(run[k]).toBe(true);
        if (run.code) expect(run.text).not.toContain('\n');
        const prev = out[i - 1];
        if (prev !== undefined) expect([!!prev.strong, !!prev.em, !!prev.code]).not.toEqual([!!run.strong, !!run.em, !!run.code]);
      });
    }));
  });

  it('removing markers is the only change to the text: the plain text is the source less some *, `, \\ and code-span spaces', () => {
    fc.assert(fc.property(text, (s) => {
      const plain = parseInline(s).map((r) => r.text).join('');
      let i = 0;
      for (const ch of s) {
        if (plain.startsWith(ch, i)) i += ch.length;
        else expect('*`\\ ', JSON.stringify(s)).toContain(ch);
      }
      expect(i, JSON.stringify(s)).toBe(plain.length);
    }));
  });

  it('is deterministic: two runs give byte-identical JSON (DD-00 §3)', () => {
    fc.assert(fc.property(text, (s) => {
      expect(JSON.stringify(parseInline(s))).toBe(JSON.stringify(parseInline(s)));
    }));
  });
});

describe('T13, T14: which strings are markdown', () => {
  const compileWith = (src: string) => compile(resolve(parse(src).ast).model, undefined, { inline: parseInline }).graph;

  it('markdown runs on the text after variable substitution (T14)', () => {
    const graph = compileWith('@vars: { name: "*Payments*", tick: "`v2`", lit: "\\\\*x\\\\*" }\na: { @label: "${name} API ${tick}" }\nb: { @label: $name }\nc: { @label: "${lit}" }\n');
    expect(graph.labels['l:a']?.runs).toEqual(runs(['Payments', 'e'], ' API ', ['v2', 'c']));
    expect(graph.labels['l:b']?.runs).toEqual(runs(['Payments', 'e']));
    // To keep a variable's text literal, escape it inside the value.
    expect(graph.labels['l:c']?.runs).toEqual(literal('*x*'));
  });

  it('node, container and edge labels and the string shorthands are markdown', () => {
    const graph = compileWith('@classes: { K: { @label: "**k**" } }\nbox: { @label: "*box*", inner: "`i`" }\nk: K\nn: "**n**"\nbox.inner -> n: "*e*"\n');
    expect(graph.labels['l:box']?.runs).toEqual(runs(['box', 'e']));
    expect(graph.labels['l:box.inner']?.runs).toEqual(runs(['i', 'c']));
    // A class's @label never reaches a node's title (DD-03 §6 reads the node's
    // own config), with or without A18: T13's "set by a class" has nothing to
    // apply to. The title is the key, which is never parsed.
    expect(graph.labels['l:k']?.runs).toEqual(literal('k'));
    expect(graph.labels['l:n']?.runs).toEqual(runs(['n', 's']));
    expect(Object.values(graph.labels).find((l) => l.role === 'edge')?.runs).toEqual(runs(['e', 'e']));
  });

  it('a node\'s key used as its title, @title and @tooltip are not', () => {
    const graph = compileWith('@title: "**T**"\n"*key*": { @tooltip: "**t**" }\n');
    expect(graph.labels['l:*key*']?.runs).toEqual(literal('*key*'));
    expect(graph.title).toBe('**T**');
  });

  it('a """ label is markdown after its dedent', () => {
    const graph = compileWith('api: {\n  @label: """\n    **Payments API**\n    handles `POST /pay`\n    """\n}\n');
    expect(graph.labels['l:api']?.runs).toEqual(runs(['Payments API', 's'], '\nhandles ', ['POST /pay', 'c']));
  });
});
