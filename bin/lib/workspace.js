import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Shared by `pack` and `publish`: both resolve the entry `.fluid.js` the same
// way and stamp the same fluidcad version onto the package.

/** The installed fluidcad version (from the package's own package.json). */
export function readPackageVersion() {
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Read the MODEL workspace's own `package.json` for publish prefills: name and
 * description (→ short description). Distinct from `readPackageVersion`, which
 * reads the fluidcad engine's version. Missing/unreadable fields come back
 * undefined. (The published version number is hub-assigned, not read here.)
 */
export function readWorkspacePackage(workspace) {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
    return {
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
    };
  } catch {
    return {};
  }
}

/** Resolve the entry `.fluid.js`: the override if given, else the sole one. */
export function findEntry(workspace, override) {
  if (override) {
    const abs = resolve(workspace, override);
    if (!existsSync(abs)) {
      throw new Error(`Entry file not found: ${abs}`);
    }
    return abs;
  }
  const candidates = readdirSync(workspace).filter((f) => f.endsWith('.fluid.js'));
  if (candidates.length === 0) {
    throw new Error('No .fluid.js files found in the workspace. Pass --entry to specify one.');
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple .fluid.js files found: ${candidates.join(', ')}. Pass --entry to choose one.`,
    );
  }
  return resolve(workspace, candidates[0]);
}
