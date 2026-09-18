import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LINK_SCHEMES } from '../src/security.js';
import { renderCorpusDoc } from './pipeline.js';

/**
 * The injection suite (DD-07 §11, DD-09 §3.3 invariant 6): parse the rendered
 * SVG as XML and assert no `<script>` element, no `on*` attribute, and every
 * `href` on the allowlist — against every corpus/injection/*.sgl document, one
 * hostile string per markup context.
 */

const injectionDir = fileURLToPath(new URL('../../../corpus/injection/', import.meta.url));
const INJECTION_DOCS = readdirSync(injectionDir)
  .filter((f) => f.endsWith('.sgl'))
  .map((f) => `injection/${f}`)
  .sort();

interface XmlNode {
  readonly [tag: string]: unknown;
  readonly ':@'?: Readonly<Record<string, unknown>>;
}

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_' });

function walk(nodes: readonly XmlNode[], visit: (tag: string, attrs: Readonly<Record<string, string>>) => void): void {
  for (const n of nodes) {
    for (const key of Object.keys(n)) {
      if (key === ':@') continue;
      if (key === '#text') continue;
      const attrs: Record<string, string> = {};
      const raw = n[':@'];
      if (raw !== undefined) {
        for (const [k, v] of Object.entries(raw)) attrs[k.replace(/^@_/, '')] = String(v);
      }
      visit(key, attrs);
      const children = n[key];
      if (Array.isArray(children)) walk(children as readonly XmlNode[], visit);
    }
  }
}

describe('injection suite: the rendered SVG is well-formed XML', () => {
  for (const doc of INJECTION_DOCS) {
    it(`${doc}: parses as valid XML`, async () => {
      const { rendered } = await renderCorpusDoc(doc);
      const result = XMLValidator.validate(rendered.svg);
      expect(result).toBe(true);
    });
  }

  it('every clean corpus document also parses as valid XML (not just the injection set)', async () => {
    const { rendered } = await renderCorpusDoc('checkout.sgl');
    expect(XMLValidator.validate(rendered.svg)).toBe(true);
  });
});

describe('injection suite: no script element, no on* attribute, every href on the allowlist', () => {
  for (const doc of INJECTION_DOCS) {
    it(`${doc}: produces no executable content`, async () => {
      const { rendered } = await renderCorpusDoc(doc);
      const tree = parser.parse(rendered.svg) as XmlNode[];

      const tags: string[] = [];
      const eventAttrs: string[] = [];
      const hrefs: string[] = [];

      walk(tree, (tag, attrs) => {
        tags.push(tag);
        for (const [name, value] of Object.entries(attrs)) {
          if (/^on/i.test(name)) eventAttrs.push(`${tag}[${name}]`);
          if (name === 'href') hrefs.push(value);
        }
      });

      expect(tags).not.toContain('script');
      expect(eventAttrs).toEqual([]);
      for (const href of hrefs) {
        expect(ALLOWED_LINK_SCHEMES.some((scheme) => href.startsWith(scheme))).toBe(true);
      }
    });
  }

  it('js-url-link.sgl: the javascript: link is dropped and SGL6001 is reported', async () => {
    const { rendered } = await renderCorpusDoc('injection/js-url-link.sgl');
    expect(rendered.svg).not.toContain('<a ');
    expect(rendered.svg).not.toContain('javascript:');
    expect(rendered.diagnostics.some((d) => d.code === 'SGL6001')).toBe(true);
  });

  it('script-in-label.sgl: the literal </text><script> never closes the real <text> element', async () => {
    const { rendered } = await renderCorpusDoc('injection/script-in-label.sgl');
    const tree = parser.parse(rendered.svg) as XmlNode[];
    const tags: string[] = [];
    walk(tree, (tag) => tags.push(tag));
    expect(tags).not.toContain('script');
    expect(rendered.svg).toContain('&lt;/text&gt;&lt;script&gt;');
  });

  it('cdata-in-label.sgl: a CDATA-close/open pair in the label text is escaped, not parsed as CDATA', async () => {
    const { rendered } = await renderCorpusDoc('injection/cdata-in-label.sgl');
    expect(rendered.svg).not.toContain('<![CDATA[');
    expect(rendered.svg).not.toContain(']]>');
    expect(XMLValidator.validate(rendered.svg)).toBe(true);
  });

  it('entity-in-label.sgl: pre-encoded entities are double-escaped, not decoded and re-interpreted', async () => {
    const { rendered } = await renderCorpusDoc('injection/entity-in-label.sgl');
    // The label's literal text is "&lt;script&gt;..."; escapeXml must turn the
    // leading & into &amp; so a viewer's XML parser never decodes it back down
    // to a live "<script>" tag.
    expect(rendered.svg).toContain('&amp;lt;script&amp;gt;');
    const tree = parser.parse(rendered.svg) as XmlNode[];
    const tags: string[] = [];
    walk(tree, (tag) => tags.push(tag));
    expect(tags).not.toContain('script');
  });

  it('attr-break-in-key.sgl: a quote-and-onload key text cannot break out of an attribute value', async () => {
    const { rendered } = await renderCorpusDoc('injection/attr-break-in-key.sgl');
    const tree = parser.parse(rendered.svg) as XmlNode[];
    const eventAttrs: string[] = [];
    walk(tree, (_tag, attrs) => {
      for (const name of Object.keys(attrs)) if (/^on/i.test(name)) eventAttrs.push(name);
    });
    expect(eventAttrs).toEqual([]);
  });
});
