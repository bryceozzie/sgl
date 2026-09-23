import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFor, parseHeadersFile } from '../build/headers.js';

/**
 * A throwaway static server for the build in `dist/`, with `dist/_headers`
 * applied and the single-page fallback — for the one test that has to take
 * the network away completely by *stopping the server* (criterion 5 in
 * WebKit, where Playwright can neither `setOffline` nor route a request
 * without also blocking what the service worker would have answered).
 */

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

/** `noStore`: every response says `Cache-Control: no-store` (over whatever
 *  `_headers` declares), so the browser's HTTP cache never holds a copy that
 *  could answer once the server is stopped — only the service worker can. */
export async function serveDist(options: { readonly noStore?: boolean } = {}): Promise<StaticServer> {
  const rules = parseHeadersFile(readFileSync(join(DIST, '_headers'), 'utf8'));
  const server: Server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(DIST, pathname));
    if (!file.startsWith(normalize(DIST)) || !isFile(file)) file = join(DIST, 'index.html');
    for (const [name, value] of headersFor(rules, pathname)) res.setHeader(name, value);
    if (options.noStore === true) res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
