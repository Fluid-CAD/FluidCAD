import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { loadPreferences, preferredNewProjectUnit, resetPreferences, savePreferences } from '../src/preferences.ts';
import { createPreferencesRouter } from '../src/routes/preferences.ts';

// The preferences file lives under the platform config dir; on Linux that is
// $XDG_CONFIG_HOME, so each test gets a fresh temp dir and touches nothing
// of the developer's own.

let tmp: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-prefs-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
});

afterEach(() => {
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const onLinux = process.platform === 'linux';

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPreferencesRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await run(`http://127.0.0.1:${port}/api`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

describe.runIf(onLinux)('preferences — the Settings dialog keys', () => {
  it('starts from the defaults the dialog shows', async () => {
    const prefs = await loadPreferences();
    expect(prefs.editorFontFamily).toBe('');
    expect(prefs.editorFontSize).toBe(13);
    expect(prefs.editorWordWrap).toBe(false);
    expect(prefs.snapRadiusPx).toBe(15);
    expect(prefs.pickRadiusPx).toBe(12);
    expect(prefs.defaultProjectUnit).toBe('mm');
    expect(prefs.editorOpen).toBe(false);
  });

  it('merges one key per POST, clamps the numbers and refuses a font family that is not a plain name', async () => {
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, { editorFontSize: 400 });
      expect(prefs.editorFontSize).toBe(40);
      prefs = await post(`${base}/preferences`, { snapRadiusPx: 0.4, pickRadiusPx: 9.6 });
      expect(prefs.snapRadiusPx).toBe(2);
      expect(prefs.pickRadiusPx).toBe(10);
      prefs = await post(`${base}/preferences`, { editorFontFamily: 'JetBrains Mono' });
      expect(prefs.editorFontFamily).toBe('JetBrains Mono');
      prefs = await post(`${base}/preferences`, { editorFontFamily: 'x; url(evil)' });
      expect(prefs.editorFontFamily).toBe('JetBrains Mono');
      prefs = await post(`${base}/preferences`, { editorWordWrap: true });
      expect(prefs.editorWordWrap).toBe(true);
      prefs = await post(`${base}/preferences`, { editorWordWrap: 'yes' });
      expect(prefs.editorWordWrap).toBe(true);
      prefs = await post(`${base}/preferences`, { defaultProjectUnit: 'in' });
      expect(prefs.defaultProjectUnit).toBe('in');
      prefs = await post(`${base}/preferences`, { defaultProjectUnit: 'furlong' });
      expect(prefs.defaultProjectUnit).toBe('in');
      // Every earlier key survived the later merges.
      expect(prefs.editorFontSize).toBe(40);
      expect(prefs.snapRadiusPx).toBe(2);
    });
  });

  it('reset puts the file back to the defaults and answers with them', async () => {
    await withServer(async (base) => {
      await post(`${base}/preferences`, { theme: 'fluidcad-light', editorFontSize: 20, defaultProjectUnit: 'ft', showGrid: false });
      const reset = await post(`${base}/preferences/reset`, {});
      expect(reset.theme).toBe('fluidcad-dark');
      expect(reset.editorFontSize).toBe(13);
      expect(reset.defaultProjectUnit).toBe('mm');
      expect(reset.showGrid).toBe(true);
      const onDisk = await loadPreferences();
      expect(onDisk).toEqual(reset);
    });
  });

  it('the unit for new projects is null for mm and the stored unit otherwise', async () => {
    expect(await preferredNewProjectUnit()).toBeNull();
    const prefs = await loadPreferences();
    await savePreferences({ ...prefs, defaultProjectUnit: 'in' });
    expect(await preferredNewProjectUnit()).toBe('in');
    await resetPreferences();
    expect(await preferredNewProjectUnit()).toBeNull();
  });
});
