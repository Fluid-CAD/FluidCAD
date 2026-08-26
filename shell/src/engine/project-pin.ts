import fs from 'fs';
import path from 'path';

/**
 * Reading and writing a project's `fluidcad.json` engine pin.
 *
 * This is a deliberate re-implementation of `server/src/project-config.ts`
 * rather than an import of it. The shell has to read the pin *before* it knows
 * which engine to load, and the whole point of the pin is that the engine on
 * the other side may be any version — including one older than this shell. The
 * shell must therefore not depend on engine code for it. The file format is
 * frozen by that same constraint: one key, `engine`, a version string.
 */

export const PROJECT_CONFIG_FILENAME = 'fluidcad.json';

export type ProjectPin = {
  /** The pinned version, or null when the project doesn't pin one. */
  engine: string | null;
  /** Which file the pin came from. */
  source: 'fluidcad.json' | 'package.json' | null;
};

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function asVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** `fluidcad.json` wins over `package.json`'s `{ "fluidcad": { "engine": … } }`. */
export function readProjectPin(workspacePath: string): ProjectPin {
  const config = readJson(path.join(workspacePath, PROJECT_CONFIG_FILENAME));
  const configured = asVersion(config?.engine);
  if (configured) {
    return { engine: configured, source: 'fluidcad.json' };
  }

  const pkg = readJson(path.join(workspacePath, 'package.json'));
  const fromPackage = asVersion(pkg?.fluidcad?.engine);
  if (fromPackage) {
    return { engine: fromPackage, source: 'package.json' };
  }

  return { engine: null, source: null };
}

/**
 * Write the pin, preserving every other key in the file. Always targets
 * `fluidcad.json` — a `package.json` belongs to npm, and we don't rewrite it.
 */
export function writeProjectPin(workspacePath: string, version: string): string {
  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const existing = readJson(configPath);
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  fs.writeFileSync(configPath, JSON.stringify({ ...base, engine: version }, null, 2) + '\n');
  return configPath;
}

/** The version a project's own `node_modules/fluidcad` reports, if it has one. */
export function projectInstalledEngine(workspacePath: string): string | null {
  const pkg = readJson(path.join(workspacePath, 'node_modules', 'fluidcad', 'package.json'));
  return asVersion(pkg?.version);
}
