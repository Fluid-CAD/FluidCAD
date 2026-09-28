import path from 'path';

/**
 * Serving the start page's files: the built `ui/dist-start` of the engine
 * that ships with the launcher. The desktop app serves them over its
 * `fluidcad-app:` scheme (`shell/src/start/protocol.ts`), `npx fluidcad` over
 * HTTP (`server/start-page.ts`); both map a URL onto that one directory by the
 * rules here, and send the same headers.
 *
 * Everything here is pure, so the Windows mapping is tested from Linux
 * through `path.win32`.
 */

export const START_PAGE_FILE = 'start.html';

/**
 * The start page's Content-Security-Policy, sent as a response header (a
 * `<meta>` cannot carry `frame-ancestors`). No inline script or style; images
 * from the page itself, `data:`, the feed's https pictures, and whatever
 * `extraImageSources` the launcher serves previews from; and no page anywhere
 * may frame it — the start page is the one page that can open projects.
 */
export function startPageCsp(extraImageSources: string[] = []): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    ["img-src 'self' data: https:", ...extraImageSources].join(' '),
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export function contentTypeFor(file: string, pathImpl: path.PlatformPath = path): string {
  return CONTENT_TYPES[pathImpl.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * A URL's path as segments that are safe to join under a root, or null.
 * Decoded exactly once; `..`, `.`, empty segments, backslashes, NUL and
 * drive-letter or absolute segments are all refused rather than normalised,
 * so nothing a URL spells can climb out of the root.
 */
export function safeSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split('/').slice(1);
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      /^[a-zA-Z]:/.test(segment)
    ) {
      return null;
    }
  }
  return segments;
}

/** `segments` joined under `root`, or null if the result is not strictly inside it. */
export function fileInside(root: string, segments: string[], pathImpl: path.PlatformPath = path): string | null {
  const base = pathImpl.resolve(root);
  const file = pathImpl.resolve(base, ...segments);
  return file.startsWith(base + pathImpl.sep) ? file : null;
}

/**
 * The start-page file a URL path names under `root`, or null for a 404. The
 * bare path is the page itself.
 */
export function startPageFile(root: string, pathname: string, pathImpl: path.PlatformPath = path): string | null {
  const segments = pathname === '/' || pathname === '' ? [START_PAGE_FILE] : safeSegments(pathname);
  return segments ? fileInside(root, segments, pathImpl) : null;
}

/**
 * Put the saved theme on `<html>` before the first paint, the way the engine's
 * `sendIndexHtml` does for the product page: `ui/start.html` carries the
 * literal `data-theme="fluidcad-dark"`, and this replaces exactly that.
 */
export function withTheme(html: string, theme: string): string {
  const safe = theme.replace(/[^\w-]/g, '') || 'fluidcad-dark';
  return html.replace('data-theme="fluidcad-dark"', `data-theme="${safe}"`);
}

/**
 * The headers a served file carries; `csp` goes on the start page's own
 * document. Every file comes off the local disk, so revalidating costs
 * nothing, and a start page from before an update must never be served from a
 * cache.
 */
export function startPageHeaders(contentType: string, csp: string | null = null): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  };
  if (csp) {
    headers['content-security-policy'] = csp;
  }
  return headers;
}
