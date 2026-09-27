import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP, CSP_DIRECTIVES, HEADERS_FILE, META_CSP, headersFor, parseHeadersFile } from '../build/headers.js';

/** J4: the `_headers` file and its CSP, held to the design documents' own
 *  text so neither can drift from them silently. */

const doc = (path: string): string => readFileSync(new URL(`../../../docs/detailed-design/${path}`, import.meta.url), 'utf8');

/** The first fenced block after `heading` in `text`. */
function fencedBlockAfter(text: string, heading: string): string {
  const from = text.indexOf(heading);
  expect(from, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const m = /```[a-z]*\n([\s\S]*?)```/.exec(text.slice(from));
  expect(m, `code block after ${heading}`).not.toBeNull();
  return m![1]!.replace(/\r\n/g, '\n');
}

describe('CSP (DD-09 §1.2)', () => {
  it('is exactly the policy DD-09 §1.2 specifies, directive for directive', () => {
    const block = fencedBlockAfter(doc('09-security-performance-testing.md'), '### 1.2 Content Security Policy');
    const directives = block
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter((d) => d !== '');
    expect(CSP_DIRECTIVES).toEqual(directives);
    expect(CSP).toBe(directives.join('; '));
  });

  it("the <meta> mirror drops only what a <meta> policy cannot carry", () => {
    expect(META_CSP).not.toContain('frame-ancestors');
    expect(META_CSP.split('; ')).toEqual(CSP_DIRECTIVES.filter((d) => !d.startsWith('frame-ancestors')));
  });
});

describe('_headers (DD-10 §5)', () => {
  it('is DD-10 §5 verbatim with the CSP filled in', () => {
    const block = fencedBlockAfter(doc('10-build-and-deploy.md'), '`_headers` in `dist/`');
    expect(HEADERS_FILE).toBe(block.replace('<DD-09 §1.2>', CSP));
  });

  it('parses into rules, and every matching rule applies', () => {
    const rules = parseHeadersFile(HEADERS_FILE);
    expect(rules.map((r) => r.pattern)).toEqual(['/*', '/assets/*', '/sw.js']);

    const root = Object.fromEntries(headersFor(rules, '/'));
    expect(root['Content-Security-Policy']).toBe(CSP);
    expect(root['Cache-Control']).toBeUndefined();

    const asset = Object.fromEntries(headersFor(rules, '/assets/index-abc.js'));
    expect(asset['Content-Security-Policy']).toBe(CSP);
    expect(asset['Cache-Control']).toBe('public, max-age=31536000, immutable');

    expect(Object.fromEntries(headersFor(rules, '/sw.js'))['Cache-Control']).toBe('no-cache');
    expect(Object.fromEntries(headersFor(rules, '/sw.jsx'))['Cache-Control']).toBeUndefined();
  });

  it('rejects a header line outside any rule', () => {
    expect(() => parseHeadersFile('  X-Orphan: 1\n')).toThrow();
  });
});

describe('wrangler.toml (DD-10 §5)', () => {
  it('is DD-10 §5 verbatim', () => {
    const block = fencedBlockAfter(doc('10-build-and-deploy.md'), '## 5. Deploy');
    const file = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(file).toBe(block);
  });
});
