import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shared by the commands: the fluidcad version they stamp onto what they
// make, and how `export` resolves the entry script.

/** Script suffixes an entry can have — mirrors the server's file-kind table. */
const SCRIPT_SUFFIXES = ['.part.js', '.assembly.js', '.fluid.js'];

/** The installed fluidcad version (from the package's own package.json). */
export function readPackageVersion() {
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Resolve the entry script: the override if given, else the sole one. */
export function findEntry(workspace, override) {
  if (override) {
    const abs = resolve(workspace, override);
    if (!existsSync(abs)) {
      throw new Error(`Entry file not found: ${abs}`);
    }
    return abs;
  }
  const candidates = readdirSync(workspace)
    .filter((f) => SCRIPT_SUFFIXES.some((suffix) => f.endsWith(suffix)));
  if (candidates.length === 0) {
    throw new Error('No .part.js, .assembly.js or .fluid.js files found in the workspace. Pass --entry to specify one.');
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple model files found: ${candidates.join(', ')}. Pass --entry to choose one.`,
    );
  }
  return resolve(workspace, candidates[0]);
}
