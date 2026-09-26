import path from 'path';

/**
 * The `fluidcad-app:` scheme: how the shell serves the start screen without a
 * process behind it.
 *
 *   fluidcad-app://start/…                   → <built-in engine>/ui/dist-start/…
 *   fluidcad-app://thumbnails/<sha1>.png     → ~/.fluidcad/thumbnails/<sha1>.png
 *
 * Registered as `standard` (so `/assets/…` resolves against the page's own
 * origin, and Vite's `crossorigin` module scripts are same-origin requests)
 * and `secure` (so the page is a secure context). Nothing else: the P4-0 spike
 * showed module scripts, modulepreload and CSS all load with just these.
 *
 * Everything here is pure — the mapping from a URL to a file and the headers a
 * response carries — so it is tested on both path flavours from Linux; the
 * Electron wiring is in `app-protocol.ts`.
 */

export const APP_SCHEME = 'fluidcad-app';
export const START_ORIGIN = `${APP_SCHEME}://start`;
export const START_PAGE_FILE = 'start.html';
export const START_URL = `${START_ORIGIN}/${START_PAGE_FILE}`;

/**
 * The start page's Content-Security-Policy, sent as a response header (a
 * `<meta>` cannot carry `frame-ancestors`). No inline script or style; images
 * from the page itself, `data:`, the feed's https pictures and the thumbnails
 * host; and no page anywhere may frame it — a project page in the same window
 * must not be able to embed the one page that holds the shell bridge.
 */
export const START_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' data: https: ${APP_SCHEME}:`,
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

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

const THUMBNAIL_NAME = /^[0-9a-f]{40}\.png$/;

export type AppRoots = {
  /** The start page's directory, or null when there is none to serve. */
  start: string | null;
  thumbnails: string;
};

export type AppFile = {
  file: string;
  contentType: string;
  /** The start page's HTML document gets the CSP and the theme; nothing else does. */
  isStartPage: boolean;
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
function safeSegments(pathname: string): string[] | null {
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
function inside(root: string, segments: string[], pathImpl: path.PlatformPath): string | null {
  const base = pathImpl.resolve(root);
  const file = pathImpl.resolve(base, ...segments);
  return file.startsWith(base + pathImpl.sep) ? file : null;
}

/** The file a `fluidcad-app:` URL names, or null for a 404. */
export function resolveAppRequest(url: string, roots: AppRoots, pathImpl: path.PlatformPath = path): AppFile | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:`) {
    return null;
  }
  if (parsed.host === 'start') {
    if (!roots.start) {
      return null;
    }
    // The bare origin is the page itself.
    const segments = parsed.pathname === '/' || parsed.pathname === '' ? [START_PAGE_FILE] : safeSegments(parsed.pathname);
    if (!segments) {
      return null;
    }
    const file = inside(roots.start, segments, pathImpl);
    if (!file) {
      return null;
    }
    return {
      file,
      contentType: contentTypeFor(file, pathImpl),
      isStartPage: segments.length === 1 && segments[0] === START_PAGE_FILE,
    };
  }
  if (parsed.host === 'thumbnails') {
    const segments = safeSegments(parsed.pathname);
    if (!segments || segments.length !== 1 || !THUMBNAIL_NAME.test(segments[0])) {
      return null;
    }
    const file = inside(roots.thumbnails, segments, pathImpl);
    return file ? { file, contentType: 'image/png', isStartPage: false } : null;
  }
  return null;
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

/** The headers a served file carries. */
export function responseHeaders(resolved: AppFile): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': resolved.contentType,
    'x-content-type-options': 'nosniff',
    // Every file comes off the local disk; revalidating costs nothing, and a
    // start page from before an update must never be served from a cache.
    'cache-control': 'no-cache',
  };
  if (resolved.isStartPage) {
    headers['content-security-policy'] = START_PAGE_CSP;
  }
  return headers;
}

/** True for the start page's own documents, whatever query or hash they carry. */
export function isStartPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === 'start';
  } catch {
    return false;
  }
}

/** A cache-busting URL for a thumbnail file, by its modification time. */
export function thumbnailUrl(fileName: string, mtimeMs: number): string {
  return `${APP_SCHEME}://thumbnails/${fileName}?v=${Math.round(mtimeMs)}`;
}
