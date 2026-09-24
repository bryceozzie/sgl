/**
 * Escaping, sanitisation and the link allowlist (DD-07 §8).
 *
 * There is no path by which document text becomes markup: every string that
 * reaches the output passes through exactly one of these. The injection corpus
 * (DD-09 §3.3 invariant 6) asserts it by parsing the result as XML.
 */

import { fnv1a64 } from '@sgl/core';

/**
 * Escape a string for a text node or attribute value. Every string that reaches
 * markup goes through here; link schemes are allowlisted separately (DD-07 §8).
 *
 * DD-07 §8 splits this into `escText` (`& < >`) and `escAttr` (`& < > " '`). One
 * function that always does the attribute set is a strict superset of both, and
 * one function is one thing to audit — the extra `&quot;`/`&apos;` in text content
 * is legal XML and renders identically.
 */
export function escapeXml(s: string): string {
  return stripControl(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * XML 1.0 forbids most C0 control characters outright — a document containing one
 * is not ill-formed markup, it is *unparseable*, which would turn a hostile label
 * into a denial of service on every consumer of the exported file. They are
 * dropped rather than escaped, because there is no escape that makes them legal.
 */
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** `@link` is restricted to these (language spec §4); anything else is dropped with
 *  SGL6001. */
export const ALLOWED_LINK_SCHEMES: readonly string[] = ['https:', 'mailto:'];

export interface SafeUrl {
  /** The URL to emit, or `null` when it was rejected. */
  readonly href: string | null;
  /** The scheme as written, for the SGL6001 message. `''` when there was none. */
  readonly scheme: string;
}

/**
 * Allowlist a `@link` value by scheme.
 *
 * Deliberately conservative about what counts as a scheme: anything up to the
 * first `:` that looks like one is treated as one, so `java\nscript:alert(1)`,
 * `JavaScript:`, a scheme split by a control character, and `  javascript:` are
 * than normalised into something a browser would happily run. A value with no
 * scheme at all — including a protocol-relative `//evil.test` — is rejected too,
 * because resolution against the embedding document is exactly the ambiguity an
 * exported SVG must not carry into a tool we do not control (DD-09 §1.3).
 */
export function safeUrl(raw: string): SafeUrl {
  // Strip the characters browsers strip before scheme detection, so the scheme we
  // test is the scheme they would act on.
  // eslint-disable-next-line no-control-regex
  const url = raw.replace(/[\x00-\x20]/g, '');
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  const hasScheme = colon > 0 && (slash === -1 || colon < slash);
  if (!hasScheme) return { href: null, scheme: '' };

  const scheme = url.slice(0, colon + 1).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme)) return { href: null, scheme: scheme.slice(0, -1) };
  if (!ALLOWED_LINK_SCHEMES.includes(scheme)) return { href: null, scheme: scheme.slice(0, -1) };

  // The scheme is on the allowlist; the rest is escaped as an attribute value like
  // any other string, so it cannot break out of the attribute whatever it holds.
  return { href: url, scheme: scheme.slice(0, -1) };
}

const ID_SAFE = /^[A-Za-z0-9_.-]*$/;
const ID_UNSAFE_CHAR = /[^A-Za-z0-9_.-]/g;

/**
 * DD-07 §6. Replace any character outside `[A-Za-z0-9_.-]` with `_`, and if that
 * changed anything append `-` + 6 hex of `fnv1a64(original)`, so `a b` and `a_b`
 * cannot both become `a_b`.
 */
export function sanitizeId(raw: string): string {
  if (ID_SAFE.test(raw)) return raw;
  return `${raw.replace(ID_UNSAFE_CHAR, '_')}-${fnv1a64(raw).slice(0, 6)}`;
}

/** Element id for a node: `n-` + the sanitised `NodeId` (DD-07 §6). */
export function nodeElementId(id: string): string {
  return `n-${sanitizeId(id)}`;
}

/** Element id for an edge: `e-` + the hash part of the `EdgeId` (DD-07 §6). The
 *  compiler already mints `e-<hash>`, so the `e-` is not doubled. */
export function edgeElementId(id: string): string {
  return `e-${sanitizeId(id.startsWith('e-') ? id.slice(2) : id)}`;
}

/** A generated class-name suffix. Hashes should already be hex, but a hash is a
 *  string like any other and this is the only place that assumption is load-bearing. */
export function hashToken(raw: string): string {
  return /^[a-f0-9]{1,32}$/.test(raw) ? raw : sanitizeId(raw).slice(0, 32) || '0';
}

const CSS_COLOR_KEYWORDS: readonly string[] = ['none', 'transparent', 'currentColor'];
const CSS_HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CSS_COLOR_FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-zA-Z.,%/\s+-]{1,64}\)$/;

/**
 * DD-07 §8, CSS values. Colours must match `#hex` or an `rgb()/hsl()` grammar.
 *
 * `SGL5004` is an *upstream* code — the theme resolver rejects a bad value long
 * before it reaches here — so a value that fails at this point is a renderer-side
 * last line of defence, not a diagnostic: it becomes the registry's loud fallback
 * so the mistake is visible rather than silent. `'unsafe-inline'` for styles is
 * the one CSP concession (DD-09 §1.2), which is precisely why this check exists.
 */
export function cssColor(raw: string): string {
  if (CSS_COLOR_KEYWORDS.includes(raw)) return raw;
  if (CSS_HEX.test(raw)) return raw;
  if (CSS_COLOR_FN.test(raw)) return raw;
  return '#FF00FF';
}

const CSS_BARE_FAMILY = /^[A-Za-z0-9_ -]{1,64}$/;

/**
 * A font stack, re-quoted family by family. Anything that is not a plain family
 * name or a cleanly quoted one is dropped; if that empties the stack, the generic
 * `sans-serif` is left, because a `font-family` declaration with no value would
 * make the whole rule invalid and take the colour down with it.
 */
export function cssFontFamily(raw: string): string {
  const families: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const unquoted =
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
        ? trimmed.slice(1, -1)
        : trimmed;
    if (!CSS_BARE_FAMILY.test(unquoted)) continue;
    families.push(unquoted.includes(' ') ? `'${unquoted}'` : unquoted);
  }
  return families.length > 0 ? families.join(', ') : 'sans-serif';
}

/** A CSS identifier-shaped keyword (`normal`, `italic`, `round`). */
export function cssKeyword(raw: string): string | null {
  return /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(raw) ? raw : null;
}
