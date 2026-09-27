import { parseInline } from '@sgl/core/inline';
import { describe, expect, it } from 'vitest';
import { compileHelp, HelpBuildError, type HelpFile } from '../build/help-content.js';
import type { Block, HelpEntry } from '../src/help/content.js';

/**
 * DD-13 P10–P14, §12 (help branch 2): the build-time help compiler. Each
 * case compiles a small Markdown file; the error cases must fail the build
 * with a message naming the file and line.
 */

const file = (text: string, path = 'keys/x.md'): HelpFile => ({ path, text });
const one = (text: string, knownIds?: ReadonlySet<string>): HelpEntry => {
  const content = compileHelp([file(text)], knownIds === undefined ? {} : { knownIds });
  expect(content.entries).toHaveLength(1);
  return content.entries[0]!;
};
const blocks = (body: string): readonly Block[] => one(`# T {#topic/t}\n\nSummary.\n\n${body}\n`).blocks;

/** The compile's problems, or `[]` if it compiled. */
function problems(text: string | readonly HelpFile[], knownIds?: ReadonlySet<string>): readonly string[] {
  try {
    compileHelp(typeof text === 'string' ? [file(text)] : text, knownIds === undefined ? {} : { knownIds });
    return [];
  } catch (err) {
    if (err instanceof HelpBuildError) return err.problems;
    throw err;
  }
}

describe('entries (DD-13 P10)', () => {
  it('a heading carrying its id starts an entry: kind, name, title, file and summary', () => {
    const e = one('# Pin a node {#key/pin}\n\nPlaces a node at\nfixed coordinates.\n\nMore prose.\n');
    expect(e).toMatchObject({ id: 'key/pin', kind: 'key', name: 'pin', title: 'Pin a node', file: 'keys/x.md' });
    // Soft line breaks join into spaces before `parseInline` sees them.
    expect(e.summary).toEqual([{ text: 'Places a node at fixed coordinates.' }]);
    expect(e.blocks).toEqual([{ type: 'paragraph', runs: [{ text: 'More prose.' }] }]);
  });

  it('a body runs to the next heading with an id, of any level; headings without an id stay in the body', () => {
    const { entries } = compileHelp([file('# Size {#key/size}\n\nS.\n\n## Notes\n\nN.\n\n## Max {#key/size.maxWidth}\n\nM.\n')]);
    expect(entries.map((e) => e.id)).toEqual(['key/size', 'key/size.maxWidth']);
    expect(entries[0]!.blocks).toEqual([
      { type: 'heading', level: 2, runs: [{ text: 'Notes' }] },
      { type: 'paragraph', runs: [{ text: 'N.' }] },
    ]);
    expect(entries[1]!.summary).toEqual([{ text: 'M.' }]);
  });

  it('Aliases:, See also: and Diagnostics: lines become fields, not prose', () => {
    const e = one(
      '# P {#key/pin}\n\nSummary.\n\nAliases: position, x y\n\nSee also: [Size](#help/key/size), [Style](#help/key/style)\n\nDiagnostics: SGL2011, SGL4021\n\nBody.\n',
    );
    expect(e.aliases).toEqual(['position', 'x y']);
    expect(e.seeAlso).toEqual(['key/size', 'key/style']);
    expect(e.diagnostics).toEqual(['SGL2011', 'SGL4021']);
    expect(e.blocks).toEqual([{ type: 'paragraph', runs: [{ text: 'Body.' }] }]);
  });

  it('files compile in the order given, entries in file order', () => {
    const { entries } = compileHelp([file('# B {#topic/b}\n\nB.\n', 'b.md'), file('# A {#topic/a}\n\nA.\n', 'a.md')]);
    expect(entries.map((e) => [e.id, e.file])).toEqual([
      ['topic/b', 'b.md'],
      ['topic/a', 'a.md'],
    ]);
  });
});

describe('inline runs (DD-13 P12)', () => {
  it('runs equal parseInline\'s for the same text', () => {
    const text = '**Bold**, *italic*, `code *not em*`, a*b*c and \\*literal\\*';
    expect(blocks(text)).toEqual([{ type: 'paragraph', runs: parseInline(text) }]);
  });

  it('a link is split out first; the text around it and its label go through parseInline', () => {
    expect(blocks('See [**the** pin](#help/key/pin) for *more*.')).toEqual([
      {
        type: 'paragraph',
        runs: [{ text: 'See ' }, { link: 'key/pin', runs: [{ text: 'the', strong: true }, { text: ' pin' }] }, { text: ' for ' }, { text: 'more', em: true }, { text: '.' }],
      },
    ]);
  });

  it('link syntax inside a code span is code, not a link', () => {
    expect(blocks('Write `[a](#help/key/pin)` literally.')).toEqual([
      { type: 'paragraph', runs: [{ text: 'Write ' }, { text: '[a](#help/key/pin)', code: true }, { text: ' literally.' }] },
    ]);
  });
});

describe('blocks (DD-13 P12)', () => {
  it('headings # to ### without an id', () => {
    expect(blocks('# One\n\n## Two\n\n### Three *em*')).toEqual([
      { type: 'heading', level: 1, runs: [{ text: 'One' }] },
      { type: 'heading', level: 2, runs: [{ text: 'Two' }] },
      { type: 'heading', level: 3, runs: [{ text: 'Three ' }, { text: 'em', em: true }] },
    ]);
  });

  it('unordered and ordered lists, two levels deep, with continuation lines', () => {
    expect(blocks('- one\n  more\n- two\n  1. a\n  2. b\n- three')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          { runs: [{ text: 'one more' }] },
          { runs: [{ text: 'two' }], sub: { ordered: true, items: [{ runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }] } },
          { runs: [{ text: 'three' }] },
        ],
      },
    ]);
    expect(blocks('1. first\n2. second')).toEqual([{ type: 'list', ordered: true, items: [{ runs: [{ text: 'first' }] }, { runs: [{ text: 'second' }] }] }]);
  });

  it('a GFM pipe table: a header, a separator and rows; a `|` inside code does not split a cell', () => {
    expect(blocks('| Key | Means |\n|---|:---:|\n| `a|b` | **yes** |\n| c | d |')).toEqual([
      {
        type: 'table',
        head: [[{ text: 'Key' }], [{ text: 'Means' }]],
        rows: [
          [[{ text: 'a|b', code: true }], [{ text: 'yes', strong: true }]],
          [[{ text: 'c' }], [{ text: 'd' }]],
        ],
      },
    ]);
  });

  it('a > block is a note holding blocks', () => {
    expect(blocks('> **Note.** First\n> line.\n>\n> - item')).toEqual([
      {
        type: 'note',
        blocks: [
          { type: 'paragraph', runs: [{ text: 'Note.', strong: true }, { text: ' First line.' }] },
          { type: 'list', ordered: false, items: [{ runs: [{ text: 'item' }] }] },
        ],
      },
    ]);
  });

  it('fenced code of another language is one plain token per line run', () => {
    expect(blocks('```json\n{ "a": 1 }\n```')).toEqual([{ type: 'code', lang: 'json', tokens: [['', '{ "a": 1 }']] }]);
  });

  it('an sgl example: attributes, its id, its source and highlight tokens with the editor\'s tags', () => {
    const [b] = blocks('```sgl example title="Wrap a title" engine=grid expect=SGL3006,SGL3006 contains="<tspan"\na: { @shape: cloud } // c\na -> b: "x"\n```');
    expect(b).toMatchObject({
      type: 'example',
      example: { id: 'topic/t#1', mode: 'example', title: 'Wrap a title', engine: 'grid', expect: ['SGL3006', 'SGL3006'], contains: '<tspan', preview: true, source: 'a: { @shape: cloud } // c\na -> b: "x"' },
    });
    const tokens = (b as Extract<Block, { type: 'example' }>).example.tokens;
    // The tokens spell the source exactly, adjacent plain text merged.
    expect(tokens.map((t) => t[1]).join('')).toBe('a: { @shape: cloud } // c\na -> b: "x"');
    expect(tokens).toEqual([
      ['', 'a: { '],
      ['tok-propertyName', '@shape'],
      ['', ': cloud } '],
      ['tok-comment', '// c'],
      ['', '\na '],
      ['tok-operator', '->'],
      ['', ' b: '],
      ['tok-string', '"x"'],
    ]);
  });

  it('a snippet, and preview=false with an expect; ids count every sgl block in the entry', () => {
    const b = blocks('```sgl snippet\n@pin: { x: 0, y: 0 }\n```\n\n```sgl example title="Bad" expect=SGL2013 preview=false\na: { @label: $nope }\n```');
    expect(b.map((x) => (x.type === 'example' ? [x.example.id, x.example.mode, x.example.preview, x.example.expect] : x.type))).toEqual([
      ['topic/t#1', 'snippet', true, []],
      ['topic/t#2', 'example', false, ['SGL2013']],
    ]);
  });
});

describe('what fails the build (DD-13 P12, §11)', () => {
  const body = (text: string): readonly string[] => problems(`# T {#topic/t}\n\nSummary.\n\n${text}\n`);

  it('raw HTML, in prose, a list, a table or a heading', () => {
    expect(body('Some <b>bold</b> text.')).toEqual([expect.stringMatching(/^keys\/x\.md:5: raw HTML/)]);
    expect(body('- an <img src=x> item')[0]).toMatch(/raw HTML/);
    expect(body('| a |\n|---|\n| <br> |')[0]).toMatch(/raw HTML/);
    expect(body('## A <em>heading</em>')[0]).toMatch(/raw HTML/);
    expect(body('<!-- a comment -->')[0]).toMatch(/raw HTML/);
    // Not HTML: arrows and comparisons, and anything inside a code span.
    expect(body('Write `a <b> c`, `a <- b` or a <-> b, and x < y.')).toEqual([]);
  });

  it('images', () => {
    expect(body('An ![alt](#help/key/pin) image.')).toEqual([expect.stringMatching(/^keys\/x\.md:5: an image/)]);
  });

  it('external or bare URLs, and links that are not #help/<id>', () => {
    expect(body('See [the site](https://example.com).')[0]).toMatch(/^keys\/x\.md:5: a link must be \[text\]\(#help\/<kind>\/<name>\)/);
    expect(body('See [x](key/pin).')[0]).toMatch(/a link must be/);
    expect(body('See https://example.com for more.')[0]).toMatch(/a URL/);
    expect(body('See www.example.com.')[0]).toMatch(/a URL/);
    expect(body('Mail mailto:a@b.c.')[0]).toMatch(/a URL/);
    // A URL in a code span or a code block is code.
    expect(body('`@link: "https://example.com"`')).toEqual([]);
    expect(body('```sgl snippet\na: { @link: "https://example.com" }\n```')).toEqual([]);
  });

  it('a heading deeper than ###, and text outside any entry', () => {
    expect(body('#### Deep')[0]).toMatch(/^keys\/x\.md:5: a heading deeper than ###/);
    expect(problems('Loose text.\n\n# T {#topic/t}\n\nS.\n')[0]).toMatch(/^keys\/x\.md:1: text outside an entry/);
  });

  it('an unknown kind, a duplicate id, and an entry with no summary', () => {
    expect(problems('# T {#nope/t}\n\nS.\n')[0]).toMatch(/^keys\/x\.md:1: unknown kind `nope`/);
    expect(problems([file('# A {#topic/a}\n\nS.\n', 'a.md'), file('# A again {#topic/a}\n\nS.\n', 'b.md')])).toEqual([expect.stringMatching(/^b\.md:1: duplicate id `topic\/a` \(first at a\.md:1\)/)]);
    expect(problems('# T {#topic/t}\n\n- a list first\n')[0]).toMatch(/^keys\/x\.md:1: `topic\/t` has no summary/);
  });

  it('an unclosed fence, an unknown fence attribute or language, and bad attribute values', () => {
    expect(body('```sgl example title="T"\na')[0]).toMatch(/^keys\/x\.md:5: unclosed fence/);
    expect(body('```sgl example title="T" colour=red\na\n```')[0]).toMatch(/unknown attribute `colour`/);
    expect(body('```sgl snippet engine=elk\na\n```')[0]).toMatch(/unknown attribute `engine` on a snippet/);
    expect(body('```sgl\na\n```')[0]).toMatch(/an sgl block must be `example` or `snippet`/);
    expect(body('```python\na\n```')[0]).toMatch(/unknown language `python`/);
    expect(body('```json title="x"\n{}\n```')[0]).toMatch(/unknown attribute `title`/);
    expect(body('```sgl example\na\n```')[0]).toMatch(/an example needs a title/);
    expect(body('```sgl example title="T" expect=E1\na\n```')[0]).toMatch(/`E1` is not a diagnostic code/);
    expect(body('```sgl example title="T" preview=false\na\n```')[0]).toMatch(/preview=false needs an expect/);
    expect(body('```sgl example title="T" engine=Elk!\na\n```')[0]).toMatch(/`Elk!` is not an engine name/);
  });

  it('a malformed table, list or special line', () => {
    expect(body('| a | b |\n|---|---|\n| only one |')[0]).toMatch(/2 cells expected, 1 found/);
    expect(body('| a | b |\n| c | d |')[0]).toMatch(/a table needs a separator row/);
    expect(body('- a\n    - too deep')[0]).toMatch(/lists are two levels deep/);
    expect(body('- a\n1. b')[0]).toMatch(/mixes ordered and unordered/);
    expect(body('See also: key/pin')[0]).toMatch(/See also: holds only links/);
    expect(body('Diagnostics: SGL20')[0]).toMatch(/`SGL20` is not a diagnostic code/);
    expect(body('> # Heading')[0]).toMatch(/a note cannot hold a heading/);
  });

  it('with the ids the build knows: a link, See also target or entry naming no fact fails', () => {
    const known = new Set(['key/pin', 'key/size']);
    expect(problems('# P {#key/pin}\n\nS, see [size](#help/key/size) and [t](#help/topic/t).\n\n# T {#topic/t}\n\nT.\n', known)).toEqual([]);
    expect(problems('# P {#key/pin}\n\nSee [x](#help/key/nope).\n', known)).toEqual([expect.stringMatching(/^keys\/x\.md:3: no help entry `key\/nope`/)]);
    expect(problems('# P {#key/pin}\n\nS.\n\nSee also: [x](#help/topic/nope)\n', known)[0]).toMatch(/no help entry `topic\/nope`/);
    expect(problems('# Icon {#key/icon}\n\nS.\n', known)).toEqual([expect.stringMatching(/^keys\/x\.md:1: `key\/icon` names no fact of this build/)]);
    // Without the known ids, only links to topics (hand-written only) are checked.
    expect(problems('# P {#key/pin}\n\nSee [x](#help/key/nope).\n')).toEqual([]);
  });

  it('reports every problem at once, each with its file and line', () => {
    expect(problems('# T {#topic/t}\n\nS <b>.\n\n#### Deep\n')).toHaveLength(2);
  });
});
