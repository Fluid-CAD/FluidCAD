import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPreferencesRouter } from '../../src/routes/preferences.ts';
import { loadPreferences } from '../../src/preferences.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { normalizePath } from '../../src/normalize-path.ts';

// Settings → Packages: `packageLibraryPath` and `packageInstallTarget`
// through POST /api/preferences. The preferences file lives under the
// platform config dir, found from HOME (macOS), XDG_CONFIG_HOME (Linux) or
// APPDATA (Windows); all three point at a temp folder here, as do
// FLUIDCAD_HOME and FLUIDCAD_PACKAGES, so nothing of the developer's is read
// or written.

const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let server: http.Server;
let base: string;

async function post(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-package-prefs-'))));
  const home = path.posix.join(tmp, 'home');
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  process.env.APPDATA = home;
  process.env.FLUIDCAD_HOME = path.posix.join(tmp, 'fluidcad-home');
  delete process.env.FLUIDCAD_PACKAGES;
  PackageRoots.forget();

  const app = express();
  app.use(express.json());
  app.use('/api', createPreferencesRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  PackageRoots.forget();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('packageLibraryPath', () => {
  it('defaults to empty, the library then being $FLUIDCAD_HOME/packages', async () => {
    expect((await loadPreferences()).packageLibraryPath).toBe('');
    expect(PackageRoots.libraryPath()).toBe(path.posix.join(tmp, 'fluidcad-home', 'packages'));
  });

  it('saves an absolute folder it can create, and the library follows at once', async () => {
    const folder = path.posix.join(tmp, 'team', 'packages');
    const { status, body } = await post({ packageLibraryPath: folder });

    expect(status).toBe(200);
    expect(body.packageLibraryPath).toBe(folder);
    expect((await loadPreferences()).packageLibraryPath).toBe(folder);
    expect(PackageRoots.libraryPath()).toBe(folder);
    // Nothing is created until a package is installed there.
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('answers the reason for a path that cannot be the library, and saves nothing', async () => {
    fs.writeFileSync(path.join(tmp, 'a-file'), '');
    for (const [value, reason] of [
      ['relative/packages', /must be an absolute path/],
      [path.join(tmp, 'a-file'), /is a file, not a folder/],
      [path.join(tmp, 'a-file', 'packages'), /can't be created/],
    ] as const) {
      const { status, body } = await post({ packageLibraryPath: value, showGrid: false });
      expect(status).toBe(400);
      expect(body).toEqual({ error: expect.stringMatching(reason), key: 'packageLibraryPath' });
    }
    const prefs = await loadPreferences();
    expect(prefs.packageLibraryPath).toBe('');
    expect(prefs.showGrid).toBe(true);
  });

  it('puts the library back at its default when emptied', async () => {
    await post({ packageLibraryPath: path.posix.join(tmp, 'elsewhere') });
    const { status, body } = await post({ packageLibraryPath: '' });

    expect(status).toBe(200);
    expect(body.packageLibraryPath).toBe('');
    expect(PackageRoots.libraryPath()).toBe(path.posix.join(tmp, 'fluidcad-home', 'packages'));
  });
});

describe('packageInstallTarget', () => {
  it('takes library or project and drops anything else', async () => {
    expect((await loadPreferences()).packageInstallTarget).toBe('library');
    expect((await post({ packageInstallTarget: 'project' })).body.packageInstallTarget).toBe('project');
    expect((await post({ packageInstallTarget: 'desktop' })).body.packageInstallTarget).toBe('project');
    expect((await post({ packageInstallTarget: 'library' })).body.packageInstallTarget).toBe('library');
  });
});
