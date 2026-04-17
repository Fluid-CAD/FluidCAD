import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface Preferences {
  theme: string;
  showGrid: boolean;
  cameraMode: 'perspective' | 'orthographic';
  showBuildTimings: boolean;
}

const DEFAULTS: Preferences = {
  theme: 'fluidcad-dark',
  showGrid: true,
  cameraMode: 'orthographic',
  showBuildTimings: false,
};

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fluidcad');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'fluidcad');
  }
  // Linux / other
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'fluidcad');
}

function getPreferencesPath(): string {
  return path.join(getConfigDir(), 'preferences.json');
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    const data = await fs.readFile(getPreferencesPath(), 'utf-8');
    const parsed = JSON.parse(data);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function savePreferences(prefs: Preferences): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getPreferencesPath(), JSON.stringify(prefs, null, 2), 'utf-8');
}
