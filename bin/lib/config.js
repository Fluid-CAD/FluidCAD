import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';

// Where the CLI keeps its hub credentials. XDG-ish; one file, mode 0600.
const CONFIG_DIR = join(homedir(), '.config', 'fluidcad');
export const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');

const DEFAULT_HUB_URL = 'https://hub.fluidcad.io';

/** Resolve the hub base URL: explicit override → $FLUIDCAD_HUB_URL → default. */
export function getHubUrl(override) {
  const url = override || process.env.FLUIDCAD_HUB_URL || DEFAULT_HUB_URL;
  return url.replace(/\/+$/, '');
}

/** Read saved credentials, or null if not logged in / unreadable. */
export function readCredentials() {
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    return creds && creds.token ? creds : null;
  } catch {
    return null;
  }
}

/** Persist credentials at mode 0600 (re-chmod in case the file pre-existed). */
export function writeCredentials(creds) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CREDENTIALS_PATH, 0o600);
}

/** Forget saved credentials (used by `logout`). */
export function clearCredentials() {
  if (existsSync(CREDENTIALS_PATH)) {
    writeFileSync(CREDENTIALS_PATH, '{}\n', { mode: 0o600 });
  }
}
