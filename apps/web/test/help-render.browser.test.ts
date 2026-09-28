import { h, render as mount } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { compileHelp } from '../build/help-content.js';
import type { ExampleSpec, HelpEntry } from '../src/help/content.js';
import { Blocks, Runs } from '../src/help/render.js';

/**
 * DD-13 P13, §11 (help branch 4): the entry view renders the compiled tree
 * with Preact, element by element: each content construct becomes its own
 * elements, and text, however markup-like, stays text. Nothing is parsed as
 * markup at run time.
 */

afterEach(() => {
  mount(null, document.body);
  document.body.replaceChildren();
});

const MARKDOWN = [
  '# Everything {#topic/everything}',
  '',
  'The summary.',
  '',
  '## A heading',
  '',
  'Plain, **bold**, *italic*, `code` and a [link to pin](#help/key/pin) with `<b>not bold</b>` & `<script>x()</script>`.',
  '',
  '### A smaller heading',
  '',
  '- one',
  '- two with `code`',
  '  - nested',
  '',
  '1. first',
  '2. second',
  '',
  '| Key | Meaning |',
  '| --- | --- |',
  '| `@pin` | **fixes** a node |',
  '',
  '> **Note.** A note with *emphasis*.',
  '',
  '```text',
  'plain <code> text',
  '```',
  '',
  '```sgl example title="An example"',
  'a -> b',
  '```',
  '',
  '```sgl snippet title="A snippet"',
  'a: { @pin: { x: 1, y: 2 } }',
  '```',
  '',
].join('\n');

function entry(): HelpEntry {
  const content = compileHelp([{ path: 'topics/everything.md', text: MARKDOWN }], { knownIds: new Set(['key/pin']) });
  return content.entries[0]!;
}

function show(onLink: (id: string) => void = () => undefined, example?: (spec: ExampleSpec) => ReturnType<typeof h>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  mount(h(Blocks, { blocks: entry().blocks, onLink, ...(example !== undefined && { example }) }), host);
  return host;
}

describe('the entry renderer (DD-13 P13)', () => {
  it('headings, paragraphs, lists (two levels, ordered and not), tables, notes and code each become their own elements', () => {
    const host = show();
    expect([...host.querySelectorAll('h4, h5')].map((e) => [e.tagName, e.textContent])).toEqual([
      ['H4', 'A heading'],
      ['H5', 'A smaller heading'],
    ]);
    const ul = host.querySelector('ul')!;
    expect([...ul.children].map((li) => li.firstChild?.textContent)).toEqual(['one', 'two with ']);
    expect(ul.querySelector('li ul li')!.textContent).toBe('nested');
    expect([...host.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['first', 'second']);
    expect([...host.querySelectorAll('table thead th')].map((th) => th.textContent)).toEqual(['Key', 'Meaning']);
    expect(host.querySelector('table tbody td code')!.textContent).toBe('@pin');
    expect(host.querySelector('table tbody td strong')!.textContent).toBe('fixes');
    const note = host.querySelector('.help-note')!;
    expect(note.getAttribute('role')).toBe('note');
    expect(note.querySelector('em')!.textContent).toBe('emphasis');
    expect(host.querySelector('pre.help-code code')!.textContent).toBe('plain <code> text\n'.trimEnd());
  });

  it('runs: bold, italic and code are strong, em and code; text that looks like markup stays text', () => {
    const host = show();
    const p = [...host.querySelectorAll('p')].find((e) => e.textContent!.startsWith('Plain'))!;
    expect(p.querySelector('strong')!.textContent).toBe('bold');
    expect(p.querySelector('em')!.textContent).toBe('italic');
    expect(p.querySelector('code')!.textContent).toBe('code');
    expect(p.querySelector('b, script')).toBeNull();
    expect(p.textContent).toContain('<b>not bold</b> & <script>x()</script>');

    // The compiler refuses raw HTML outside code; a run whose text looks like
    // markup (a tree built by hand) is still only text.
    const q = document.createElement('p');
    document.body.append(q);
    mount(h(Runs, { runs: [{ text: '<img src=x onerror=alert(1)>' }], onLink: () => undefined }), q);
    expect(q.querySelector('img')).toBeNull();
    expect(q.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('a link is an <a href="#help/…"> whose click follows it in help, not the browser', () => {
    const followed: string[] = [];
    const host = show((id) => followed.push(id));
    const a = host.querySelector<HTMLAnchorElement>('a')!;
    expect(a.getAttribute('href')).toBe('#help/key/pin');
    expect(a.textContent).toBe('link to pin');
    const before = location.hash;
    a.click();
    expect(followed).toEqual(['key/pin']);
    expect(location.hash).toBe(before);
  });

  it('an sgl fence is highlighted from its build-time tokens; an example goes to the example renderer, a snippet is shown as code', () => {
    const seen: string[] = [];
    const host = show(undefined, (spec) => {
      seen.push(`${spec.mode}:${spec.title}`);
      return h('div', { class: 'stub-example' }, spec.source);
    });
    expect(seen).toEqual(['example:An example']);
    expect(host.querySelector('.stub-example')!.textContent).toBe('a -> b');
    const snippet = host.querySelector('.help-snippet')!;
    expect(snippet.querySelector('.help-snippet-title')!.textContent).toBe('A snippet');
    const code = snippet.querySelector('pre code')!;
    expect(code.textContent).toBe('a: { @pin: { x: 1, y: 2 } }');
    expect(code.querySelectorAll('span[class^="tok-"]').length).toBeGreaterThan(2);
  });

  it('without an example renderer, an example is shown as its code', () => {
    const host = show();
    expect([...host.querySelectorAll('pre code')].map((c) => c.textContent)).toContain('a -> b');
  });

  it('Runs alone renders inline content with no wrapper element', () => {
    const host = document.createElement('p');
    document.body.append(host);
    mount(h(Runs, { runs: [{ text: 'a ' }, { text: 'b', strong: true, em: true }, { link: 'key/pin', runs: [{ text: 'c', code: true }] }], onLink: () => undefined }), host);
    expect(host.innerHTML).toBe('a <strong><em>b</em></strong><a href="#help/key/pin"><code>c</code></a>');
  });
});
