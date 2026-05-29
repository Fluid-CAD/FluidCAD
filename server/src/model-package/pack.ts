import { build, type Plugin } from 'esbuild';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import JSZip from 'jszip';
import ignoreFactory, { type Ignore } from 'ignore';
import { normalizePath } from '../normalize-path.ts';
import { getBlockedNodeModule } from '../host/blocked-imports.ts';
import type { ParamDefinition } from '../../../lib/dist/index.js';
import {
  ASSETS_PREFIX,
  BUNDLE_FILENAME,
  FILES_PREFIX,
  MANIFEST_FILENAME,
  type ModelPackageCamera,
  type ModelPackageManifest,
  type ParamValue,
} from './types.ts';

export interface PackInputs {
  entryPath: string;
  workspacePath: string;
  fluidcadVersion: string;
  name?: string;
  description?: string;
  paramOverrides?: Record<string, ParamValue>;
  /**
   * Full param schema to embed in the manifest. `fluidcad publish` renders the
   * model once to capture this (see `capture-params.ts`); `fluidcad pack` omits
   * it. Kept as an input (rather than rendering inside `packModel`) so packing
   * stays a pure, engine-free file producer.
   */
  paramDefinitions?: ParamDefinition[];
  camera?: ModelPackageCamera;
}

export interface PackResult {
  manifest: ModelPackageManifest;
  zip: Buffer;
}

/**
 * Reject Node.js builtins that are off-limits in `.fluid.js` code. Same
 * defence the LocalSceneHost applies at SSR transform time; here it runs
 * at pack time so the produced bundle is verified before it ships.
 */
function blockNodeBuiltinsPlugin(): Plugin {
  return {
    name: 'block-node-builtins',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const blocked = getBlockedNodeModule(args.path);
        if (!blocked) return null;
        return {
          errors: [
            {
              text:
                `Module "${args.path}" is not allowed in FluidCAD scripts. ` +
                `Access to Node.js "${blocked}" module is restricted for security.`,
            },
          ],
        };
      });
    },
  };
}

/**
 * Bundle the model into a single ES module via a virtual wrapper. When
 * `init.js` exists it runs FIRST (its side effects set up the engine) and
 * its `default` export is forwarded as the bundle's `default` export so
 * the hub-side loader has a handle on the SceneManager. When there's no
 * init.js, the entry is bundled directly.
 *
 * The bundle is self-contained — every transitively-imported workspace file
 * is inlined (npm deps too). The original file text the hub displays comes
 * from the `files/` tree, not from this bundle.
 */
async function bundleModel(
  entryAbs: string,
  initAbs: string | null,
  workspaceAbs: string,
): Promise<string> {
  const entryRel = './' + normalizePath(relative(workspaceAbs, entryAbs));
  const initRel = initAbs ? './' + normalizePath(relative(workspaceAbs, initAbs)) : null;
  const wrapperSource = initRel
    ? `import sceneManager from ${JSON.stringify(initRel)};\n` +
      `import ${JSON.stringify(entryRel)};\n` +
      `export default sceneManager;\n`
    : `export * from ${JSON.stringify(entryRel)};\n`;

  const result = await build({
    stdin: {
      contents: wrapperSource,
      resolveDir: workspaceAbs,
      sourcefile: '__fluidpkg_entry__.js',
      loader: 'js',
    },
    format: 'esm',
    bundle: true,
    write: false,
    platform: 'node',
    external: ['fluidcad', 'fluidcad/*'],
    plugins: [blockNodeBuiltinsPlugin()],
    logLevel: 'silent',
  });
  if (result.errors.length) {
    throw new Error(result.errors.map((e) => e.text).join('\n'));
  }
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error(`esbuild produced no output for ${entryAbs}`);
  }

  return result.outputFiles[0].text;
}

async function collectImportAssetPaths(workspacePath: string): Promise<string[]> {
  // STEP imports are stored as cached `.brep` (+ `.colors.json` sidecar) under
  // `imports/` — the engine reads those at render time, not the original
  // `.step` files. Walk the whole workspace so any `.brep`/`.colors.json` is
  // captured; also include any `.step`/`.stp` originals the user kept around
  // (for display in the hub's file viewer; the engine ignores them).
  const out: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        const lower = entry.toLowerCase();
        const ext = extname(lower);
        const isColors = lower.endsWith('.colors.json');
        if (ext === '.step' || ext === '.stp' || ext === '.brep' || isColors) {
          out.push(normalizePath(relative(workspacePath, full)));
        }
      }
    }
  }

  await walk(workspacePath);
  return out.sort();
}

// Enforced on top of any `.gitignore`: dependency trees and prior pack outputs
// (the latter would otherwise recurse into the next pack). `node_modules` is
// also pruned during the walk for speed. Hidden dot-entries are excluded by the
// walk directly (see below), so VCS metadata (`.git`) and secrets (`.env`) need
// no pattern here.
const ALWAYS_EXCLUDE = ['node_modules', '*.fluidpkg'];

// `ignore` ships a CJS `module.exports = factory`, but its bundled types use
// `export default`, which loses the call signature under `module: nodenext`.
// Pin the factory's real signature; the runtime value is the callable factory.
const ignore = ignoreFactory as unknown as (options?: object) => Ignore;

/**
 * Pack v2 file selection: every non-ignored file in the workspace, so the hub
 * ships the whole project (README, package.json, configs, sources) — not just
 * the entry's transitive imports.
 *
 * A root `.gitignore` is honored via the mature `ignore` package (same matcher
 * eslint/prettier use). Hidden dot-entries (names starting with `.`) are ALWAYS
 * excluded — `.git`, `.env`, and tool/editor state like `.claude`/`.vscode` are
 * never model content and may hold secrets — regardless of whether they're
 * gitignored. `node_modules` is pruned too; `ALWAYS_EXCLUDE` (prior `.fluidpkg`
 * outputs) is enforced on top of any `.gitignore`. We walk and filter per-file
 * rather than pruning ignored directories so negation rules (`!keep/this`) work.
 */
async function collectWorkspaceFiles(workspaceAbs: string): Promise<string[]> {
  const gitignorePath = join(workspaceAbs, '.gitignore');
  const hasGitignore = existsSync(gitignorePath);
  const ig = ignore().add(ALWAYS_EXCLUDE);
  if (hasGitignore) {
    ig.add(await readFile(gitignorePath, 'utf8'));
  }

  const out: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      // Skip dependency trees and ALL hidden dot-entries (VCS metadata, secrets,
      // editor/tool state) — never packaged, gitignore or not.
      if (name === 'node_modules' || name.startsWith('.')) continue;

      const full = join(dir, name);
      const rel = normalizePath(relative(workspaceAbs, full));
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (ig.ignores(rel)) continue;
        out.push(rel);
      }
    }
  }

  await walk(workspaceAbs);
  return out.sort();
}

export async function packModel(inputs: PackInputs): Promise<PackResult> {
  const entryAbs = normalizePath(inputs.entryPath);
  const workspaceAbs = normalizePath(inputs.workspacePath);

  const initPath = join(workspaceAbs, 'init.js');
  const initAbs = existsSync(initPath) ? normalizePath(initPath) : null;

  const bundle = await bundleModel(entryAbs, initAbs, workspaceAbs);
  const assetPaths = await collectImportAssetPaths(workspaceAbs);

  // The full human tree, minus anything already shipped under assets/ (so large
  // brep/STEP bytes aren't duplicated). assets + files together = the package.
  const assetSet = new Set(assetPaths);
  const filePaths = (await collectWorkspaceFiles(workspaceAbs)).filter((p) => !assetSet.has(p));

  const entryRelative = normalizePath(relative(workspaceAbs, entryAbs));
  const defaultName = basename(entryAbs).replace(/\.fluid\.js$/i, '');

  const manifest: ModelPackageManifest = {
    schemaVersion: 2,
    name: inputs.name ?? defaultName,
    fluidcadVersion: inputs.fluidcadVersion,
    createdAt: new Date().toISOString(),
    entry: entryRelative,
    hasInit: !!initAbs,
    assets: assetPaths,
    files: filePaths,
  };
  if (inputs.description) manifest.description = inputs.description;
  if (inputs.paramOverrides && Object.keys(inputs.paramOverrides).length > 0) {
    manifest.params = inputs.paramOverrides;
  }
  if (inputs.paramDefinitions && inputs.paramDefinitions.length > 0) {
    manifest.paramDefinitions = inputs.paramDefinitions;
  }
  if (inputs.camera) manifest.camera = inputs.camera;

  const zip = new JSZip();
  zip.file(MANIFEST_FILENAME, JSON.stringify(manifest, null, 2));
  zip.file(BUNDLE_FILENAME, bundle);
  for (const relPath of assetPaths) {
    const bytes = await readFile(join(workspaceAbs, relPath));
    zip.file(ASSETS_PREFIX + relPath, bytes);
  }
  for (const relPath of filePaths) {
    const bytes = await readFile(join(workspaceAbs, relPath));
    zip.file(FILES_PREFIX + relPath, bytes);
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { manifest, zip: buffer };
}
