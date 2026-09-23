/**
 * The response headers the deployed app is served with (DD-10 §5's `_headers`,
 * carrying DD-09 §1.2's Content-Security-Policy), from one definition:
 *
 * - `vite build` writes `dist/_headers` from `HEADERS_FILE` (Cloudflare's
 *   format — J4: the file is produced; deploying it is a human step);
 * - the built `index.html` carries the CSP as a `<meta>` too, per DD-09 §1.2
 *   ("mirrored as a `<meta>` for local file previews"), minus the directives a
 *   `<meta>` policy cannot carry;
 * - `vite preview` serves the build with the headers `dist/_headers` itself
 *   declares (`parseHeadersFile` + `headersFor`), so the Playwright suite runs
 *   the production build under the production CSP.
 *
 * `apps/web/test/headers.test.ts` holds `CSP_DIRECTIVES` to DD-09 §1.2's text
 * and `HEADERS_FILE` to DD-10 §5's, so neither can drift from the design.
 */

/** DD-09 §1.2, directive by directive. */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

export const CSP = CSP_DIRECTIVES.join('; ');

/** CSP 3 §6.4: `frame-ancestors` (and `report-uri`, `sandbox`) are ignored in a
 *  `<meta>` policy, and Chromium logs an error for each — so the meta mirror
 *  leaves them out. The header still carries them. */
const META_UNSUPPORTED = ['frame-ancestors', 'report-uri', 'sandbox'];

export const META_CSP = CSP_DIRECTIVES.filter((d) => !META_UNSUPPORTED.includes(d.split(' ')[0]!)).join('; ');

/** DD-10 §5, verbatim but for the CSP placeholder. */
export const HEADERS_FILE = `/*
  Content-Security-Policy: ${CSP}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/sw.js
  Cache-Control: no-cache
`;

export interface HeaderRule {
  readonly pattern: string;
  readonly headers: readonly (readonly [string, string])[];
}

/** Cloudflare's `_headers` format, the subset DD-10 §5 uses: an unindented
 *  URL pattern line, then indented `Name: value` lines; `#` comments. */
export function parseHeadersFile(text: string): readonly HeaderRule[] {
  const rules: { pattern: string; headers: [string, string][] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    const colon = raw.indexOf(':');
    if (rule === undefined || colon < 0) throw new Error(`_headers: unexpected line ${JSON.stringify(raw)}`);
    rule.headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()]);
  }
  return rules;
}

/** A pattern is an exact path, or a prefix ending in the `*` splat. Every
 *  matching rule applies, in file order, as on Cloudflare. */
export function headersFor(rules: readonly HeaderRule[], pathname: string): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const rule of rules) {
    const matches = rule.pattern.endsWith('*') ? pathname.startsWith(rule.pattern.slice(0, -1)) : pathname === rule.pattern;
    if (matches) out.push(...rule.headers);
  }
  return out;
}
