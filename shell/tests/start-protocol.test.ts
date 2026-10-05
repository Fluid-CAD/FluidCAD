import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { startPageRoot } from '../src/start/page-source';
import {
  START_PAGE_CSP,
  contentTypeFor,
  isStartPageUrl,
  resolveAppRequest,
  responseHeaders,
  thumbnailUrl,
  withTheme,
} from '../src/start/protocol';

// `fluidcad-app:` maps URLs onto two directories on disk. Nothing a URL can
// spell may reach outside them, on either path flavour — the Windows mapping
// is checked from Linux through `path.win32`.

const SHA = '0123456789abcdef0123456789abcdef01234567';

const flavours = [
  { name: 'posix', impl: path.posix, roots: { start: '/app/engine/ui/dist-start', thumbnails: '/home/you/.fluidcad/thumbnails' } },
  {
    name: 'win32',
    impl: path.win32,
    roots: { start: 'C:\\Program Files\\FluidCAD\\resources\\engine\\ui\\dist-start', thumbnails: 'C:\\Users\\you\\.fluidcad\\thumbnails' },
  },
] as const;

describe.each(flavours)('resolveAppRequest ($name)', ({ impl, roots }) => {
  const resolve = (url: string) => resolveAppRequest(url, roots, impl);

  it('serves the start page and its assets from the page root', () => {
    expect(resolve('fluidcad-app://start/start.html')).toEqual({
      file: impl.join(roots.start, 'start.html'),
      contentType: 'text/html; charset=utf-8',
      isStartPage: true,
    });
    expect(resolve('fluidcad-app://start/')!.file).toBe(impl.join(roots.start, 'start.html'));
    expect(resolve('fluidcad-app://start/assets/start-abc.js')).toEqual({
      file: impl.join(roots.start, 'assets', 'start-abc.js'),
      contentType: 'text/javascript; charset=utf-8',
      isStartPage: false,
    });
    expect(resolve('fluidcad-app://start/logo.svg')!.contentType).toBe('image/svg+xml');
    expect(resolve('fluidcad-app://start/assets/start-abc.css?v=1#x')!.file).toBe(impl.join(roots.start, 'assets', 'start-abc.css'));
  });

  it('serves a thumbnail only by its exact hashed name', () => {
    expect(resolve(`fluidcad-app://thumbnails/${SHA}.png?v=123`)).toEqual({
      file: impl.join(roots.thumbnails, `${SHA}.png`),
      contentType: 'image/png',
      isStartPage: false,
    });
    expect(resolve('fluidcad-app://thumbnails/desktop.json')).toBeNull();
    expect(resolve(`fluidcad-app://thumbnails/${SHA.toUpperCase()}.png`)).toBeNull();
    expect(resolve(`fluidcad-app://thumbnails/sub/${SHA}.png`)).toBeNull();
  });

  it('refuses every way out of the root', () => {
    for (const url of [
      'fluidcad-app://start/..%2fsecret',
      'fluidcad-app://start/..%5csecret',
      'fluidcad-app://start/assets%5c..%5c..%5cwin.ini',
      'fluidcad-app://start/C:%5cWindows%5cwin.ini',
      'fluidcad-app://start/c:/Windows/win.ini',
      'fluidcad-app://start/a%00b.html',
      'fluidcad-app://start//etc/passwd',
      'fluidcad-app://start/%zz',
      `fluidcad-app://thumbnails/%2e%2e%2f${SHA}.png`,
      `fluidcad-app://thumbnails/..%5c${SHA}.png`,
    ]) {
      expect(resolve(url), url).toBeNull();
    }
  });

  it('keeps what the URL parser folds inside the root', () => {
    // WHATWG URLs fold `..`, `%2e%2e` and friends as dot segments before this
    // code sees the path; whatever is left must still land inside the root.
    for (const url of [
      'fluidcad-app://start/../../etc/passwd',
      'fluidcad-app://start/%2e%2e/secret.txt',
      'fluidcad-app://start/assets/%2E%2E/%2E%2E/x',
      'fluidcad-app://start/assets/./../../../x',
    ]) {
      const resolved = resolve(url);
      expect(resolved === null || resolved.file.startsWith(roots.start + impl.sep), url).toBe(true);
    }
  });

  it('knows no other host or scheme', () => {
    expect(resolve('fluidcad-app://engines/0.0.45/package.json')).toBeNull();
    expect(resolve('file:///etc/passwd')).toBeNull();
    expect(resolve('not a url')).toBeNull();
  });

  it('serves nothing from start when there is no page', () => {
    expect(resolveAppRequest('fluidcad-app://start/start.html', { ...roots, start: null }, impl)).toBeNull();
  });
});

describe('responses', () => {
  it('always name their content type', () => {
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
    expect(contentTypeFor('x.unknown')).toBe('application/octet-stream');
    expect(responseHeaders({ file: '/x.js', contentType: 'text/javascript; charset=utf-8', isStartPage: false })).toEqual({
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });
  });

  it('put the CSP on the start page only', () => {
    const headers = responseHeaders({ file: '/start.html', contentType: 'text/html; charset=utf-8', isStartPage: true });
    expect(headers['content-security-policy']).toBe(START_PAGE_CSP);
    expect(START_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(START_PAGE_CSP).toContain("script-src 'self'");
    expect(START_PAGE_CSP).not.toContain('unsafe-inline');
    expect(START_PAGE_CSP).toContain("img-src 'self' data: https: fluidcad-app:");
  });

  it('put the saved theme on <html> before the first paint', () => {
    const html = '<html lang="en" class="h-full" data-theme="fluidcad-dark"><body data-theme="fluidcad-dark">';
    expect(withTheme(html, 'fluidcad-light')).toBe('<html lang="en" class="h-full" data-theme="fluidcad-light"><body data-theme="fluidcad-dark">');
    expect(withTheme(html, '"><script>x</script>')).toContain('data-theme="scriptxscript"');
    expect(withTheme(html, '')).toBe(html);
  });
});

describe('start page URLs', () => {
  it('recognises only the start host', () => {
    expect(isStartPageUrl('fluidcad-app://start/start.html?x#y')).toBe(true);
    expect(isStartPageUrl('fluidcad-app://thumbnails/x.png')).toBe(false);
    expect(isStartPageUrl('http://127.0.0.1:3100/')).toBe(false);
    expect(isStartPageUrl('')).toBe(false);
  });

  it('bust the image cache with the mtime', () => {
    expect(thumbnailUrl({ fileName: `${SHA}.png`, mtimeMs: 1727000000123.4 })).toBe(`fluidcad-app://thumbnails/${SHA}.png?v=1727000000123`);
  });
});

describe('startPageRoot', () => {
  let dir: string;
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function pageAt(root: string): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'start.html'), '<html>');
  }

  it("uses the built-in engine's ui/dist-start", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-start-root-'));
    pageAt(path.join(dir, 'ui', 'dist-start'));
    expect(startPageRoot({ packaged: true, env: {}, builtinPackageRoot: dir })).toBe(path.join(dir, 'ui', 'dist-start'));
  });

  it('is null without a page, or without a built-in engine', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-start-root-'));
    expect(startPageRoot({ packaged: true, env: {}, builtinPackageRoot: dir })).toBeNull();
    expect(startPageRoot({ packaged: true, env: {}, builtinPackageRoot: null })).toBeNull();
  });

  it('honours FLUIDCAD_START_UI only in a development run', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-start-root-'));
    const override = path.join(dir, 'dev-build');
    pageAt(override);
    expect(startPageRoot({ packaged: false, env: { FLUIDCAD_START_UI: override }, builtinPackageRoot: null })).toBe(override);
    expect(startPageRoot({ packaged: true, env: { FLUIDCAD_START_UI: override }, builtinPackageRoot: null })).toBeNull();
  });
});
