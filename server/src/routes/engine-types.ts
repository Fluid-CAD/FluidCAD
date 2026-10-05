import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { ENGINE_NAMESPACE_SPECIFIERS } from '../../../lib/dist/browser/linking.js';
import { listEngineSymbols, type EngineSymbol } from '../lint-fluid-js.ts';

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
  /**
   * The import linter's symbol→module table, so the page's auto-import
   * completions offer exactly the names the `missing-imports` guard knows.
   */
  symbols: EngineSymbol[];
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
    // `index.d.ts` for the root, `core.d.ts` for `fluidcad/core`,
    // `sdk/kernel.d.ts` for `fluidcad/sdk/kernel` — the file names node
    // resolution looks for when it walks up to `node_modules`. A nested shim
    // climbs back to the package root before naming the declaration.
    const name = subpath === '.' ? 'index' : subpath.slice(2);
    const root = '../'.repeat(name.split('/').length - 1) || './';
    const declaration = `${root}${target.replace(/^\.\//, '').replace(/\.js$/, '')}`;
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
  cached = {
    files,
    symbols: listEngineSymbols(),
    bytes: files.reduce((sum, file) => sum + file.content.length, 0),
  };
  return cached;
}

/**
 * Where the declarations of the OpenCascade binding the engine runs on
 * (`ocjs-fluidcad`) are published for Monaco: node resolution from
 * `fluidcad/lib/dist/sdk/occt.d.ts` walks up to this `node_modules` entry.
 */
const OCCT_LIB_ROOT = 'file:///node_modules/ocjs-fluidcad';

/** The binding's own declarations, in its package's `dist`: the entry and the generated module it re-exports. */
const OCCT_DECLARATIONS = ['index.d.ts', 'opencascade.fluidcad.multi-threaded.d.ts'];

/**
 * The binding's package directory as the engine resolves it: the nearest
 * `node_modules/ocjs-fluidcad` up from `lib/dist`, the way Node finds it for
 * `lib/dist/oc/init.js` (a hoisted install puts it higher up).
 */
function findOcctPackage(): string | null {
  let dir = LIB_DIST;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'ocjs-fluidcad');
    if (fs.existsSync(path.join(candidate, 'dist', 'index.d.ts'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

let occtCached: EngineTypesPayload | null = null;

/**
 * The declarations of raw OpenCascade (`fluidcad/sdk/occt`): the binding's
 * whole API, about 2 MB, so the page asks for them only once a file imports
 * that entry — every other file completes without them. Null when the
 * binding's declarations can't be found.
 */
export function readOcctTypes(): EngineTypesPayload | null {
  if (occtCached) {
    return occtCached;
  }
  const pkg = findOcctPackage();
  if (!pkg) {
    return null;
  }
  const files: EngineTypeFile[] = [{
    uri: `${OCCT_LIB_ROOT}/package.json`,
    content: JSON.stringify({ name: 'ocjs-fluidcad', types: './dist/index.d.ts' }),
  }];
  for (const name of OCCT_DECLARATIONS) {
    try {
      files.push({ uri: `${OCCT_LIB_ROOT}/dist/${name}`, content: fs.readFileSync(path.join(pkg, 'dist', name), 'utf8') });
    } catch {
      return null;
    }
  }
  occtCached = { files, symbols: [], bytes: files.reduce((sum, file) => sum + file.content.length, 0) };
  return occtCached;
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

  router.get('/engine/types/occt', (_req, res) => {
    try {
      const payload = readOcctTypes();
      if (!payload) {
        res.status(404).json({ error: 'The OpenCascade binding\'s declarations are not installed with this engine.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.json({ version, ...payload });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
