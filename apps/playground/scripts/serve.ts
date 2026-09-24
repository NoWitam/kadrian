/**
 * A local static server for the playground (D25.9). It serves only the page,
 * the playground's own build, the built output of the packages the page needs,
 * and the runtime build artifact — nothing else in the repository, and never a
 * path outside those directories.
 *
 *   node --run build && node --experimental-strip-types apps/playground/scripts/serve.ts
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** URL prefix → directory under the repository root. */
export const ROUTES: Readonly<Record<string, string>> = {
  '/app/': 'apps/playground/dist',
  '/pkg/ai-sdk/': 'packages/ai-sdk/dist',
  '/pkg/editor-sdk/': 'packages/editor-sdk/dist',
  '/pkg/player/': 'packages/player/dist',
  '/pkg/renderer-dom/': 'packages/renderer-dom/dist',
  '/pkg/runtime/': 'packages/runtime/dist',
  '/pkg/schema/': 'packages/schema/dist',
  '/pkg/test-fixtures/': 'packages/test-fixtures/dist',
};

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * The page's own policy. The render page is a `srcdoc` of this page and
 * inherits it, so it must admit inline script and style and `data:` images
 * (D23.6, D25.2); `connect-src 'self'` lets the page fetch the artifact.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** The file for a request path, or `null` for anything that is not served. */
export function resolveRequest(pathname: string): string | null {
  if (pathname === '/') return join(repoRoot, 'apps', 'playground', 'index.html');
  for (const [prefix, directory] of Object.entries(ROUTES)) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    if (rest === '' || rest.includes('\\') || rest.split('/').includes('..')) return null;
    const base = join(repoRoot, ...directory.split('/'));
    const file = normalize(join(base, ...rest.split('/')));
    if (!file.startsWith(base + sep)) return null;
    if (!(extname(file) in TYPES)) return null;
    return file;
  }
  return null;
}

function serve(port: number): void {
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const file = request.method === 'GET' ? resolveRequest(url.pathname) : null;
    if (file === null || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    response
      .writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-security-policy': PAGE_POLICY,
        'cache-control': 'no-store',
      })
      .end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => {
    console.log(`Kadrion playground on http://127.0.0.1:${String(port)}/`);
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  normalize(invokedPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
) {
  serve(Number(process.env.PORT ?? '4520'));
}
