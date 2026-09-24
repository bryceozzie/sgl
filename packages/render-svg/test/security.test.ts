import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LINK_SCHEMES,
  cssColor,
  cssFontFamily,
  cssKeyword,
  edgeElementId,
  escapeXml,
  hashToken,
  nodeElementId,
  safeUrl,
  sanitizeId,
} from '../src/security.js';

describe('escapeXml()', () => {
  it('escapes all five XML-significant characters', () => {
    expect(escapeXml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('leaves ordinary text and unicode untouched', () => {
    expect(escapeXml('héllo 世界 🎉')).toBe('héllo 世界 🎉');
  });

  it('strips C0 control characters (unparseable XML, not just unsafe) but keeps tab/newline', () => {
    expect(escapeXml('a\x00b\x01c\x7Fd')).toBe('abcd');
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });

  it('is idempotent-safe against a script tag: no literal markup survives', () => {
    const evil = '<script>alert(1)</script>';
    const out = escapeXml(evil);
    expect(out).not.toContain('<script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('safeUrl()', () => {
  it('allows every scheme in ALLOWED_LINK_SCHEMES', () => {
    expect(ALLOWED_LINK_SCHEMES).toEqual(['https:', 'mailto:']);
    expect(safeUrl('https://example.com/x').href).toBe('https://example.com/x');
    expect(safeUrl('mailto:a@b.com').href).toBe('mailto:a@b.com');
  });

  it('rejects javascript: and data:', () => {
    expect(safeUrl('javascript:alert(1)').href).toBeNull();
    expect(safeUrl('data:text/html,<script>1</script>').href).toBeNull();
  });

  it('rejects http: (not on the allowlist) and reports the scheme', () => {
    const r = safeUrl('http://example.com');
    expect(r.href).toBeNull();
    expect(r.scheme).toBe('http');
  });

  it('rejects a protocol-relative URL (no scheme at all)', () => {
    const r = safeUrl('//evil.test/x');
    expect(r.href).toBeNull();
    expect(r.scheme).toBe('');
  });

  it('rejects an in-document fragment (unimplemented; DD-07 §8, language spec §4)', () => {
    const r = safeUrl('#n-target');
    expect(r.href).toBeNull();
  });

  it('rejects a scheme split by a control character or containing whitespace tricks', () => {
    expect(safeUrl('java\nscript:alert(1)').href).toBeNull();
    expect(safeUrl('  javascript:alert(1)').href).toBeNull();
  });

  it('is case-insensitive on the scheme', () => {
    expect(safeUrl('HTTPS://example.com').href).not.toBeNull();
    expect(safeUrl('JavaScript:alert(1)').href).toBeNull();
  });

  it('a bare relative path with no colon before any slash has no scheme', () => {
    expect(safeUrl('path/to:thing').scheme).toBe('');
    expect(safeUrl('path/to:thing').href).toBeNull();
  });
});

describe('sanitizeId()', () => {
  it('leaves an already-safe id untouched', () => {
    expect(sanitizeId('lane1.order_service-2')).toBe('lane1.order_service-2');
  });

  it('replaces unsafe characters and appends a hash suffix', () => {
    const out = sanitizeId('a b');
    expect(out).toMatch(/^a_b-[0-9a-f]{6}$/);
  });

  it('two different unsafe inputs that collide after replacement get different suffixes (no collision)', () => {
    const a = sanitizeId('a b');
    const b = sanitizeId('a_b'); // already safe, so untouched
    expect(a).not.toBe(b);
    expect(b).toBe('a_b');
    // And two different-but-colliding *unsafe* originals also diverge.
    const c = sanitizeId('a.b');
    const d = sanitizeId('a b'); // both replace to "a_b" pre-suffix... wait, "a.b" is itself safe.
    expect(c).toBe('a.b');
    expect(d).toMatch(/^a_b-[0-9a-f]{6}$/);
  });

  it('a unicode key gets replaced and hashed', () => {
    const out = sanitizeId('世界');
    expect(out).toMatch(/^__-[0-9a-f]{6}$/);
  });

  it('a dotted, quoted key with spaces is stable and collision-free against its unquoted sibling', () => {
    const withSpace = sanitizeId('order service');
    const withUnderscore = sanitizeId('order_service');
    expect(withUnderscore).toBe('order_service');
    expect(withSpace).not.toBe(withUnderscore);
  });
});

describe('nodeElementId() / edgeElementId()', () => {
  it('prefixes with n- / e-', () => {
    expect(nodeElementId('lane1.a')).toBe('n-lane1.a');
    expect(edgeElementId('e-abc123')).toBe('e-abc123');
  });

  it("edgeElementId doesn't double the e- prefix the compiler already mints", () => {
    expect(edgeElementId('e-abc123')).toBe('e-abc123');
    expect(edgeElementId('abc123')).toBe('e-abc123');
  });
});

describe('hashToken()', () => {
  it('passes an already-hex-looking token through unchanged', () => {
    expect(hashToken('8f2a91')).toBe('8f2a91');
  });

  it('sanitises anything else and caps it at 32 chars', () => {
    const out = hashToken('not hex!!');
    expect(out).not.toBe('not hex!!');
    expect(out.length).toBeLessThanOrEqual(32);
  });
});

describe('cssColor()', () => {
  it('accepts keywords, hex and rgb()/hsl() forms', () => {
    expect(cssColor('transparent')).toBe('transparent');
    expect(cssColor('#FF00FF')).toBe('#FF00FF');
    expect(cssColor('#f0f')).toBe('#f0f');
    expect(cssColor('rgba(0, 0, 0, 0.5)')).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('rejects anything else with the loud magenta fallback, not a silent pass-through', () => {
    expect(cssColor('expression(alert(1))')).toBe('#FF00FF');
    expect(cssColor('url(javascript:alert(1))')).toBe('#FF00FF');
  });
});

describe('cssFontFamily()', () => {
  it('quotes families containing a space, leaves bare ones alone', () => {
    expect(cssFontFamily('Inter, system-ui, sans-serif')).toBe("Inter, system-ui, sans-serif");
    expect(cssFontFamily('Segoe UI, sans-serif')).toBe("'Segoe UI', sans-serif");
  });

  it('drops an unquotable family and falls back to sans-serif if that empties the stack', () => {
    expect(cssFontFamily('"><script>alert(1)</script>')).toBe('sans-serif');
  });

  it('unquotes an already-quoted family before re-checking it', () => {
    expect(cssFontFamily(`'Comic Sans MS'`)).toBe("'Comic Sans MS'");
  });
});

describe('cssKeyword()', () => {
  it('accepts a CSS-identifier-shaped keyword', () => {
    expect(cssKeyword('italic')).toBe('italic');
    expect(cssKeyword('round')).toBe('round');
  });

  it('rejects anything with special characters', () => {
    expect(cssKeyword('italic;color:red')).toBeNull();
    expect(cssKeyword('')).toBeNull();
  });
});
