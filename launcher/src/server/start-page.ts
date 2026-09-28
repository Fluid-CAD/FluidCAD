import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { thumbnailsDir } from '../paths.ts';
import { THUMBNAIL_FILE_NAME, type ThumbnailStamp } from '../previews/thumbnails.ts';
import { START_PAGE_FILE, contentTypeFor, startPageCsp, startPageFile, startPageHeaders, withTheme } from '../start/page-files.ts';
import { readSavedTheme } from '../start/theme.ts';
import { mayActOnPageLoad, type LauncherAuth } from './auth.ts';

/**
 * The start page over HTTP: the same `ui/dist-start` build the desktop app
 * serves over `fluidcad-app:`, mapped onto disk by the same rules
 * (`start/page-files.ts`), with the saved theme on `<html>` before the first
 * paint and the same CSP. Previews come from `/thumbnails/`, behind the
 * session cookie.
 *
 * `/` is the start screen. `/?project=<path>` is the tab a project opens in:
 * the same page, showing that project's progress until it runs.
 */

export const START_PAGE_CSP = startPageCsp();

/** Where the start page loads a project's preview from; the mtime keeps a fresh one out of the image cache. */
export function thumbnailUrl(stamp: ThumbnailStamp): string {
  return `/thumbnails/${stamp.fileName}?v=${Math.round(stamp.mtimeMs)}`;
}

function notFound(response: Response): void {
  response.status(404).type('text/plain').send('Not found');
}

async function sendFile(response: Response, file: string, contentType: string): Promise<void> {
  let body: Buffer;
  try {
    body = await fs.promises.readFile(file);
  } catch {
    notFound(response);
    return;
  }
  response.set(startPageHeaders(contentType)).send(body);
}

export function createStartPageRouter(options: { root: string; auth: LauncherAuth }): Router {
  const { root, auth } = options;
  const router = Router();

  const sendPage = async (request: Request, response: Response): Promise<void> => {
    // A link from another page may show the start screen, but not act: only
    // the start page itself (or the user, reloading) opens projects by URL.
    if (request.query.project !== undefined && !mayActOnPageLoad(request)) {
      response.redirect(302, '/');
      return;
    }
    let html: string;
    try {
      html = await fs.promises.readFile(path.join(root, START_PAGE_FILE), 'utf8');
    } catch {
      response.status(500).type('text/plain').send('This FluidCAD install has no start page. Reinstall the fluidcad package.');
      return;
    }
    response.set(startPageHeaders('text/html; charset=utf-8', START_PAGE_CSP)).send(withTheme(html, readSavedTheme()));
  };

  router.get(['/', `/${START_PAGE_FILE}`], auth.pageLogin, (request, response) => void sendPage(request, response));

  router.get('/thumbnails/:file', auth.requireSession, (request, response) => {
    const name = String(request.params.file);
    if (!THUMBNAIL_FILE_NAME.test(name)) {
      notFound(response);
      return;
    }
    void sendFile(response, path.join(thumbnailsDir(), name), 'image/png');
  });

  // The page's scripts, styles and logo: the same for everyone, so no session needed.
  router.get(/^\/(assets\/.+|logo\.svg)$/, (request, response) => {
    const file = startPageFile(root, request.path);
    if (!file) {
      notFound(response);
      return;
    }
    void sendFile(response, file, contentTypeFor(file));
  });

  return router;
}
