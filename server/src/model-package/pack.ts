import { build } from 'esbuild';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import JSZip from 'jszip';
import { normalizePath } from '../normalize-path.ts';
import { EsbuildPlugins } from '../packages/esbuild-plugins.ts';
import { WorkspaceFiles } from '../files/workspace-files.ts';
import { isScriptPath, readDeclaredUnit } from '../file-unit.ts';
import { readProjectConfig, type LengthUnit } from '../project-config.ts';
import type { ParamDefinition } from '../../../lib/dist/index.js';
import {
  ASSETS_PREFIX,
  BUNDLE_FILENAME,
  FILES_PREFIX,
  MANIFEST_FILENAME,
  type ModelPackageCamera,
  type ModelPackageConfigurations,
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
   * model once to capture this (see `capture-params.ts`); a caller that skips
   * the render omits it. Kept as an input (rather than rendering inside `packModel`) so packing
   * stays a pure, engine-free file producer.
   */
  paramDefinitions?: ParamDefinition[];
  /**
   * The `configurations()` row the package opens on and the table it was
   * read from — captured with `paramDefinitions` by `fluidcad publish`, or
   * taken from the live session by `POST /api/pack`. Recorded only when the
   * model declares a table.
   */
  configuration?: string;
  configurations?: ModelPackageConfigurations;
  camera?: ModelPackageCamera;
  /**
   * The project unit to record in the manifest. Callers that already hold
   * the workspace config pass it; when omitted the packer reads
   * `fluidcad.json` itself (`mm` when unset), so a programmatic caller that
   * predates units still produces a complete v3 manifest.
   */
  unit?: LengthUnit;
}

export interface PackResult {
  manifest: ModelPackageManifest;
  zip: Buffer;
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
    plugins: [EsbuildPlugins.blockNodeBuiltins()],
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

/**
 * Every shipped script's `unit()` declaration, keyed by its `files` path.
 * Static (tree-sitter) so packing stays engine-free; a file that declares
 * nothing is simply absent. Null when no file declares a unit, so an
 * all-project-unit package carries no empty map.
 */
async function collectFileUnits(
  workspaceAbs: string,
  filePaths: string[],
): Promise<Record<string, LengthUnit> | null> {
  const units: Record<string, LengthUnit> = {};
  let any = false;
  for (const relPath of filePaths) {
    if (!isScriptPath(relPath)) {
      continue;
    }
    const code = await readFile(join(workspaceAbs, relPath), 'utf8');
    const unit = await readDeclaredUnit(code);
    if (unit) {
      units[relPath] = unit;
      any = true;
    }
  }
  return any ? units : null;
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
  const filePaths = (await WorkspaceFiles.collect(workspaceAbs)).filter((p) => !assetSet.has(p));

  const entryRelative = normalizePath(relative(workspaceAbs, entryAbs));
  const defaultName = basename(entryAbs).replace(/\.fluid\.js$/i, '');

  const projectConfig = readProjectConfig(workspaceAbs);
  const manifest: ModelPackageManifest = {
    schemaVersion: 3,
    name: inputs.name ?? defaultName,
    fluidcadVersion: inputs.fluidcadVersion,
    createdAt: new Date().toISOString(),
    entry: entryRelative,
    hasInit: !!initAbs,
    unit: inputs.unit ?? projectConfig.unit ?? 'mm',
    assets: assetPaths,
    files: filePaths,
  };
  const fileUnits = await collectFileUnits(workspaceAbs, filePaths);
  if (fileUnits) {
    manifest.fileUnits = fileUnits;
  }
  if (projectConfig.materials) {
    manifest.materials = projectConfig.materials;
  }
  if (inputs.description) manifest.description = inputs.description;
  if (inputs.paramOverrides && Object.keys(inputs.paramOverrides).length > 0) {
    manifest.params = inputs.paramOverrides;
  }
  if (inputs.paramDefinitions && inputs.paramDefinitions.length > 0) {
    manifest.paramDefinitions = inputs.paramDefinitions;
  }
  if (inputs.configurations && inputs.configurations.names.length > 0) {
    manifest.configurations = { names: inputs.configurations.names, rows: inputs.configurations.rows };
    manifest.configuration = inputs.configuration ?? 'Default';
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
