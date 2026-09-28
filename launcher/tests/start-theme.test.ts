import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { preferencesFile, readSavedTheme, themeBackground, toTheme } from '../src/start/theme';

// The shell reads one key of the engine's preference file. Each platform
// branch must land where `getConfigDir()` in server/src/preferences.ts does.

describe('preferencesFile', () => {
  it('uses %APPDATA% on Windows, with the roaming profile as its fallback', () => {
    expect(preferencesFile('win32', { APPDATA: 'D:\\Profiles\\you\\AppData\\Roaming' }, 'C:\\Users\\you', path.win32)).toBe(
      'D:\\Profiles\\you\\AppData\\Roaming\\fluidcad\\preferences.json',
    );
    expect(preferencesFile('win32', {}, 'C:\\Users\\you', path.win32)).toBe(
      'C:\\Users\\you\\AppData\\Roaming\\fluidcad\\preferences.json',
    );
  });

  it('uses Application Support on macOS, whatever XDG says', () => {
    expect(preferencesFile('darwin', { XDG_CONFIG_HOME: '/elsewhere' }, '/Users/you', path.posix)).toBe(
      '/Users/you/Library/Application Support/fluidcad/preferences.json',
    );
  });

  it('uses $XDG_CONFIG_HOME or ~/.config elsewhere', () => {
    expect(preferencesFile('linux', { XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/you', path.posix)).toBe('/tmp/xdg/fluidcad/preferences.json');
    expect(preferencesFile('linux', {}, '/home/you', path.posix)).toBe('/home/you/.config/fluidcad/preferences.json');
    expect(preferencesFile('freebsd', {}, '/home/you', path.posix)).toBe('/home/you/.config/fluidcad/preferences.json');
  });
});

describe('readSavedTheme', () => {
  let dir: string;
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function file(content: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-theme-'));
    const target = path.join(dir, 'preferences.json');
    fs.writeFileSync(target, content);
    return target;
  }

  it('reads the saved theme', () => {
    expect(readSavedTheme(file(JSON.stringify({ theme: 'fluidcad-light', showGrid: true })))).toBe('fluidcad-light');
    expect(readSavedTheme(file(JSON.stringify({ theme: 'fluidcad-dark' })))).toBe('fluidcad-dark');
  });

  it('falls back to dark for anything unexpected', () => {
    expect(readSavedTheme(path.join(os.tmpdir(), 'no-such-dir-fluidcad', 'preferences.json'))).toBe('fluidcad-dark');
    expect(readSavedTheme(file('{ not json'))).toBe('fluidcad-dark');
    expect(readSavedTheme(file(JSON.stringify({ theme: 'solarized' })))).toBe('fluidcad-dark');
    expect(readSavedTheme(file(JSON.stringify({ theme: 42 })))).toBe('fluidcad-dark');
    expect(readSavedTheme(file('null'))).toBe('fluidcad-dark');
  });

  it('only ever yields one of the two names', () => {
    expect(toTheme('fluidcad-light"><x')).toBe('fluidcad-dark');
    expect(toTheme(' fluidcad-light ')).toBe('fluidcad-light');
  });

  it("paints each theme's base colour", () => {
    expect(themeBackground('fluidcad-dark')).toBe('#1e1e1e');
    expect(themeBackground('fluidcad-light')).toBe('#ffffff');
  });
});
