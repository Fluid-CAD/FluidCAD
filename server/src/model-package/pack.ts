import { build, type Plugin } from 'esbuild';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve as pathResolve } from 'path';
import JSZip from 'jszip';
import { normalizePath } from '../normalize-path.ts';
import { getBlockedNodeModule } from '../host/blocked-imports.ts';
import {
  ASSETS_PREFIX,
  BUNDLE_FILENAME,
  MANIFEST_FILENAME,
  SOURCES_PREFIX,
  type ModelPackageCamera,
  type ModelPackageManifest,
  type ParamValue,
} from './types.ts';

interface BundleResult {
  bundle: string;
  // Workspace-absolute paths of source files the entry transitively imports.
  // npm deps under node_modules are filtered out.
  sourceFiles: string[];
}

export interface PackInputs {
  entryPath: string;
  workspacePath: string;
  fluidcadVersion: string;
  name?: string;
  description?: string;
  paramOverrides?: Record<string, ParamValue>;
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
 * The metafile output is what drives source preservation downstream —
 * every workspace file the wrapper transitively pulls in gets shipped
 * under `src/`, while npm deps stay inlined inside the bundle.
 */
async function bundleModel(
  entryAbs: string,
  initAbs: string | null,
  workspaceAbs: string,
): Promise<BundleResult> {
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
    metafile: true,
    logLevel: 'silent',
  });
  if (result.errors.length) {
    throw new Error(result.errors.map((e) => e.text).join('\n'));
  }
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error(`esbuild produced no output for ${entryAbs}`);
  }

  // metafile.inputs lists every file esbuild resolved into the bundle.
  // Paths are relative to cwd (or absolute if outside) — resolve them, then
  // keep only workspace files that aren't in node_modules and actually exist
  // on disk (filters out the synthetic stdin wrapper). Those are the user's
  // own sources, suitable for the hub's "view file" tree.
  const sourceFiles: string[] = [];
  const inputs = result.metafile?.inputs ?? {};
  for (const raw of Object.keys(inputs)) {
    const abs = normalizePath(isAbsolute(raw) ? raw : pathResolve(raw));
    if (!abs.startsWith(workspaceAbs)) continue;
    if (abs.includes('/node_modules/')) continue;
    if (!existsSync(abs)) continue;
    sourceFiles.push(abs);
  }

  return { bundle: result.outputFiles[0].text, sourceFiles };
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

export async function packModel(inputs: PackInputs): Promise<PackResult> {
  const entryAbs = normalizePath(inputs.entryPath);
  const workspaceAbs = normalizePath(inputs.workspacePath);

  const initPath = join(workspaceAbs, 'init.js');
  const initAbs = existsSync(initPath) ? normalizePath(initPath) : null;

  const bundleResult = await bundleModel(entryAbs, initAbs, workspaceAbs);
  const assetPaths = await collectImportAssetPaths(workspaceAbs);

  const sourcePaths = [...new Set(bundleResult.sourceFiles)]
    .map((abs) => normalizePath(relative(workspaceAbs, abs)))
    .sort();

  const entryRelative = normalizePath(relative(workspaceAbs, entryAbs));
  const defaultName = basename(entryAbs).replace(/\.fluid\.js$/i, '');

  const manifest: ModelPackageManifest = {
    schemaVersion: 1,
    name: inputs.name ?? defaultName,
    fluidcadVersion: inputs.fluidcadVersion,
    createdAt: new Date().toISOString(),
    entry: entryRelative,
    hasInit: !!initAbs,
    sources: sourcePaths,
    assets: assetPaths,
  };
  if (inputs.description) manifest.description = inputs.description;
  if (inputs.paramOverrides && Object.keys(inputs.paramOverrides).length > 0) {
    manifest.params = inputs.paramOverrides;
  }
  if (inputs.camera) manifest.camera = inputs.camera;

  const zip = new JSZip();
  zip.file(MANIFEST_FILENAME, JSON.stringify(manifest, null, 2));
  zip.file(BUNDLE_FILENAME, bundleResult.bundle);
  for (const relPath of sourcePaths) {
    const bytes = await readFile(join(workspaceAbs, relPath));
    zip.file(SOURCES_PREFIX + relPath, bytes);
  }
  for (const relPath of assetPaths) {
    const bytes = await readFile(join(workspaceAbs, relPath));
    zip.file(ASSETS_PREFIX + relPath, bytes);
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { manifest, zip: buffer };
}
