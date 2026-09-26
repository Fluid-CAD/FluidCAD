import { protocol } from 'electron';
import fs from 'fs';
import { APP_SCHEME, resolveAppRequest, responseHeaders, withTheme, type AppRoots } from './protocol';
import { readSavedTheme } from './theme';

/**
 * Registers `fluidcad-app:` with the privileges the start page needs. Must run
 * before the app is ready — Electron only accepts it then.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * Serves `fluidcad-app:` on the default session: the start page's files, and
 * project previews. The start page's HTML carries the saved theme and the CSP;
 * see `protocol.ts` for the mapping and every header.
 */
export function handleAppScheme(roots: AppRoots): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppRequest(request.url, roots);
    if (!resolved) {
      return notFound();
    }
    let body: Buffer;
    try {
      body = await fs.promises.readFile(resolved.file);
    } catch {
      return notFound();
    }
    const payload = resolved.isStartPage ? withTheme(body.toString('utf8'), readSavedTheme()) : new Uint8Array(body);
    return new Response(payload, { status: 200, headers: responseHeaders(resolved) });
  });
}
