import path from 'path';
import { THUMBNAIL_FILE_NAME, type ThumbnailStamp } from '../../../launcher/src/previews/thumbnails';
import {
  START_PAGE_FILE,
  contentTypeFor,
  fileInside,
  safeSegments,
  startPageCsp,
  startPageFile,
  startPageHeaders,
} from '../../../launcher/src/start/page-files';

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
 * The mapping onto disk and the headers are the launcher's, shared with
 * `npx fluidcad` (`launcher/src/start/page-files.ts`); this adds the scheme.
 * Everything here is pure, so it is tested on both path flavours from Linux;
 * the Electron wiring is in `app-protocol.ts`.
 */

export const APP_SCHEME = 'fluidcad-app';
export const START_ORIGIN = `${APP_SCHEME}://start`;
export const START_URL = `${START_ORIGIN}/${START_PAGE_FILE}`;

/** The start page's CSP here: previews come from the `fluidcad-app:` thumbnails host. */
export const START_PAGE_CSP = startPageCsp([`${APP_SCHEME}:`]);

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

export { contentTypeFor, withTheme } from '../../../launcher/src/start/page-files';

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
    const file = startPageFile(roots.start, parsed.pathname, pathImpl);
    if (!file) {
      return null;
    }
    return {
      file,
      contentType: contentTypeFor(file, pathImpl),
      isStartPage: file === pathImpl.join(pathImpl.resolve(roots.start), START_PAGE_FILE),
    };
  }
  if (parsed.host === 'thumbnails') {
    const segments = safeSegments(parsed.pathname);
    if (!segments || segments.length !== 1 || !THUMBNAIL_FILE_NAME.test(segments[0])) {
      return null;
    }
    const file = fileInside(roots.thumbnails, segments, pathImpl);
    return file ? { file, contentType: 'image/png', isStartPage: false } : null;
  }
  return null;
}

/** The headers a served file carries. */
export function responseHeaders(resolved: AppFile): Record<string, string> {
  return startPageHeaders(resolved.contentType, resolved.isStartPage ? START_PAGE_CSP : null);
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

/** A cache-busting URL for a project's preview, by its modification time. */
export function thumbnailUrl(stamp: ThumbnailStamp): string {
  return `${APP_SCHEME}://thumbnails/${stamp.fileName}?v=${Math.round(stamp.mtimeMs)}`;
}
