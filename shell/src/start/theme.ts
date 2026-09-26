import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The saved light or dark theme, read by the shell from the engine's own
 * preference file.
 *
 * A frozen contract of one key, re-implemented here rather than imported for
 * the same reason `engine/project-pin.ts` re-implements the pin: the shell
 * must not depend on engine code. The location mirrors `getConfigDir()` in
 * `server/src/preferences.ts` branch for branch — `%APPDATA%` on Windows,
 * `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` or
 * `~/.config` elsewhere — and the key is `theme`. Every engine version writes
 * that file the same way; if one ever stops, this reads the default and the
 * start screen is dark, which is a cosmetic miss and nothing more.
 *
 * Only these two names are ever returned: the value lands in an HTML
 * attribute and a window colour, and the file is user-editable.
 */

export const THEMES = ['fluidcad-dark', 'fluidcad-light'] as const;
export type ThemeName = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeName = 'fluidcad-dark';

/** Each theme's `--color-base-100`, from `ui/src/styles.css`: the colour a window shows before its page paints. */
const BACKGROUNDS: Record<ThemeName, string> = {
  'fluidcad-dark': '#1e1e1e',
  'fluidcad-light': '#ffffff',
};

export function preferencesFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  pathImpl: path.PlatformPath = path,
): string {
  let configDir: string;
  if (platform === 'win32') {
    configDir = pathImpl.join(env.APPDATA || pathImpl.join(home, 'AppData', 'Roaming'), 'fluidcad');
  } else if (platform === 'darwin') {
    configDir = pathImpl.join(home, 'Library', 'Application Support', 'fluidcad');
  } else {
    configDir = pathImpl.join(env.XDG_CONFIG_HOME || pathImpl.join(home, '.config'), 'fluidcad');
  }
  return pathImpl.join(configDir, 'preferences.json');
}

/** A theme name from anything; dark for whatever is not exactly one of {@link THEMES}. */
export function toTheme(value: unknown): ThemeName {
  const name = typeof value === 'string' ? value.replace(/[^\w-]/g, '') : '';
  return (THEMES as readonly string[]).includes(name) ? (name as ThemeName) : DEFAULT_THEME;
}

export function readSavedTheme(file: string = preferencesFile()): ThemeName {
  try {
    return toTheme(JSON.parse(fs.readFileSync(file, 'utf8'))?.theme);
  } catch {
    return DEFAULT_THEME;
  }
}

export function themeBackground(theme: ThemeName): string {
  return BACKGROUNDS[theme];
}
