import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { ENGINE_NAMESPACE_SPECIFIERS } from '../../../lib/dist/browser/linking.js';

/**
 * The engine's own TypeScript declarations, for the in-page editor's language
 * service. This is the reason Monaco was chosen over CodeMirror: `lib/dist`
 * already ships ~360 `.d.ts` files, so `extrude(`, `.startEdges()` and
 * `edge().onPlane(` get real signature help for free.
 *
 * **Read from the root the server itself resolved lib from**, never a
 * hardcoded path — the completions must describe the engine that is actually
 * running, which is the same reasoning as the one-lib-copy invariant.
 */

/** Where `server/dist/index.js` imports `../../lib/dist/index.js` from. */
const LIB_DIST = path.resolve(import.meta.dirname, '../../../lib/dist');
const PACKAGE_ROOT = path.resolve(LIB_DIST, '../..');

/**
 * Monaco's TS worker backs `fileExists`/`readFile` with the extra-lib map, so
 * declarations published under a `node_modules` path are found by ordinary
 * node module resolution walking up from the model's `file:///…` URI.
 */
const EXTRA_LIB_ROOT = 'file:///node_modules/fluidcad';

export type EngineTypeFile = {
  /** The `file:///…` URI to register the declaration under. */
  uri: string;
  content: string;
};

export type EngineTypesPayload = {
  files: EngineTypeFile[];
  /** Total bytes, so the page can log what it paid for. */
  bytes: number;
};

function listDeclarations(dir: string, relPrefix = ''): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      // `package.json#files` excludes these from the published package; a dev
      // checkout has them and they are pure noise for the language service.
      if (rel === 'tests') {
        continue;
      }
      found.push(...listDeclarations(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * One shim per public subpath, so `import { extrude } from 'fluidcad/core'`
 * resolves. The subpath list is `ENGINE_NAMESPACE_SPECIFIERS` — the same list
 * the in-browser viewer links model code against — and each one's target comes
 * from the package's own `exports` map, so there is no second copy of either
 * fact to drift.
 */
function buildSubpathShims(): EngineTypeFile[] {
  let exportsMap: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    exportsMap = pkg?.exports ?? {};
  } catch {
    return [];
  }

  const shims: EngineTypeFile[] = [];
  for (const specifier of ENGINE_NAMESPACE_SPECIFIERS) {
    const subpath = specifier === 'fluidcad' ? '.' : `.${specifier.slice('fluidcad'.length)}`;
    const target = exportsMap[subpath];
    if (typeof target !== 'string' || !target.endsWith('.js')) {
      continue;
    }
    const declaration = `./${target.replace(/^\.\//, '').replace(/\.js$/, '')}`;
    // `index.d.ts` for the root, `core.d.ts` for `fluidcad/core` — the file
    // names node resolution looks for when it walks up to `node_modules`.
    const name = subpath === '.' ? 'index' : subpath.slice(2);
    shims.push({
      uri: `${EXTRA_LIB_ROOT}/${name}.d.ts`,
      content: `export * from '${declaration}';\n`,
    });
  }
  return shims;
}

let cached: EngineTypesPayload | null = null;

/** The payload changes only when the engine does, so it is built once. */
export function readEngineTypes(): EngineTypesPayload {
  if (cached) {
    return cached;
  }
  const files: EngineTypeFile[] = [];
  for (const rel of listDeclarations(LIB_DIST)) {
    try {
      files.push({
        uri: `${EXTRA_LIB_ROOT}/lib/dist/${rel}`,
        content: fs.readFileSync(path.join(LIB_DIST, rel), 'utf8'),
      });
    } catch {
      // A declaration that vanished mid-read just isn't offered.
    }
  }
  files.push(...buildSubpathShims());
  cached = { files, bytes: files.reduce((sum, file) => sum + file.content.length, 0) };
  return cached;
}

export function createEngineTypesRouter(version: string): Router {
  const router = Router();

  router.get('/engine/types', (_req, res) => {
    try {
      const payload = readEngineTypes();
      // Immutable for a given engine build: the page can keep it across
      // reloads and only re-fetch when the version in the URL changes.
      res.setHeader('Cache-Control', 'no-cache');
      res.json({ version, ...payload });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
