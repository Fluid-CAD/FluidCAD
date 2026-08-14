import fs from 'fs';
import path from 'path';

/**
 * The project descriptor at a workspace root:
 *
 * ```json
 * { "engine": "0.0.41" }
 * ```
 *
 * The pin records which FluidCAD engine a project's geometry was authored
 * against. Nothing here re-execs a different version — that is the desktop
 * shell's job. What the pin buys today is that `npx fluidcad serve`, which
 * resolves to *latest* whenever the npx cache turns over, can say so out loud
 * instead of silently rebuilding a model on a kernel it has never seen.
 *
 * Deliberately dependency-free (node builtins only): this module is imported
 * by the server (TS) and, as compiled JS out of `server/dist`, by the plain-JS
 * CLI in `bin/`.
 */

/** `package.json` is supported as an alternative home for the same pin. */
export type EnginePinSource = 'fluidcad.json' | 'package.json';

export type ProjectConfig = {
  /** The pinned engine version, or null when the project doesn't pin one. */
  engine: string | null;
  /** Which file the pin came from; null when there is no pin. */
  source: EnginePinSource | null;
  /** Absolute path of the file the pin came from; null when there is no pin. */
  filePath: string | null;
  /**
   * Why a config file that exists was not usable (unparseable JSON, an
   * `engine` that isn't a string). A workspace with no config at all leaves
   * this undefined — that is the normal case, not a problem.
   */
  error?: string;
};

const EMPTY: ProjectConfig = { engine: null, source: null, filePath: null };

export const PROJECT_CONFIG_FILENAME = 'fluidcad.json';

function readJson(filePath: string): { value: unknown } | { error: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null; // Absent (or unreadable) — indistinguishable, and both mean "no pin".
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (err: any) {
    return { error: `${path.basename(filePath)} is not valid JSON: ${err?.message ?? err}` };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read the workspace's engine pin. `fluidcad.json` wins over `package.json`'s
 * `{ "fluidcad": { "engine": "…" } }`; a workspace with neither reads back as
 * an empty config, which every caller must treat as "behave exactly as before
 * pins existed".
 */
export function readProjectConfig(workspacePath: string): ProjectConfig {
  if (!workspacePath) {
    return EMPTY;
  }

  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const config = readJson(configPath);
  if (config !== null) {
    if ('error' in config) {
      return { ...EMPTY, error: config.error };
    }
    const record = asRecord(config.value);
    const engine = record?.engine;
    if (typeof engine === 'string' && engine.trim() !== '') {
      return { engine: engine.trim(), source: 'fluidcad.json', filePath: configPath };
    }
    if (engine !== undefined) {
      return {
        ...EMPTY,
        error: `${PROJECT_CONFIG_FILENAME} has an "engine" that is not a version string.`,
      };
    }
    // A `fluidcad.json` with no `engine` key is legal — later phases add other
    // fields — so fall through to package.json rather than reporting an error.
  }

  const pkgPath = path.join(workspacePath, 'package.json');
  const pkg = readJson(pkgPath);
  if (pkg && 'value' in pkg) {
    const engine = asRecord(asRecord(pkg.value)?.fluidcad)?.engine;
    if (typeof engine === 'string' && engine.trim() !== '') {
      return { engine: engine.trim(), source: 'package.json', filePath: pkgPath };
    }
  }
  // An unparseable workspace `package.json` is not ours to complain about.

  return EMPTY;
}

/**
 * Write `engine` into the workspace's `fluidcad.json`, preserving any other
 * keys already in the file. Writing always targets `fluidcad.json` even when
 * the current pin came from `package.json` — we don't rewrite a file whose
 * other contents belong to npm.
 */
export function writeEnginePin(workspacePath: string, version: string): string {
  const configPath = path.join(workspacePath, PROJECT_CONFIG_FILENAME);
  const existing = readJson(configPath);
  const base = existing && 'value' in existing ? asRecord(existing.value) : null;
  const next = { ...(base ?? {}), engine: version };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  return configPath;
}

/**
 * The one-line warning for a project whose pin doesn't match the engine that
 * is actually running, or null when they agree (or there is no pin). Kept here
 * so every entry point words it the same way.
 */
export function describeEnginePinMismatch(
  config: ProjectConfig,
  runningVersion: string,
): string | null {
  if (config.error) {
    return `FluidCAD: ${config.error} Ignoring the engine pin.`;
  }
  if (!config.engine || config.engine === runningVersion) {
    return null;
  }
  return (
    `FluidCAD: this project pins engine ${config.engine} ` +
    `(${config.source}), but ${runningVersion} is running. ` +
    `Geometry may differ from what the project was authored against.`
  );
}
