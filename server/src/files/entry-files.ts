import { readFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { join, relative } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { PROJECT_CONFIG_FILENAME, readProjectConfig } from '../project-config.ts';
import { ModuleClosure, ModuleClosurePackageError } from '../packages/module-closure.ts';
import { RenderAssets } from './render-assets.ts';

/** The virtual entry that imports init.js and the model — never a shipped file. */
const WRAPPER_NAME = '__share_entry__.js';

/**
 * A binary file in the tree (a workspace font): its bytes as standard
 * base64, the form a viewer link's `#files=` map carries one in.
 */
export type BinaryEntryFile = { b64: string };

/** One file of the tree: its text, or a binary file's bytes. */
export type EntryFile = string | BinaryEntryFile;

/** A model's source tree as a viewer link carries it: workspace-relative path → content. */
export type EntryFiles = Record<string, EntryFile>;

/**
 * The model's workspace-relative path, the key it has in
 * {@link collectEntryFiles}' tree. Read through symlinks on both sides, so
 * the workspace and the model may arrive spelled differently (one through a
 * link, one by its real path) and still meet.
 */
export function entryPath(entryAbs: string, workspaceAbs: string): string {
  return normalizePath(relative(normalizePath(realpathSync(workspaceAbs)), normalizePath(realpathSync(entryAbs))));
}

/**
 * The workspace files one model transitively imports, including itself and
 * `init.js` when the workspace has one — the minimum a viewer needs to
 * recompile the model, which is what a share-by-link ships.
 *
 * Resolution is esbuild's ({@link ModuleClosure}), the same the packers
 * use: `fluidcad/*` stays external (the viewer links its own engine), Node
 * built-ins are refused, and anything resolved outside the workspace or
 * into `node_modules` is an error — a link cannot carry an npm dependency,
 * and the viewer would fail to link it anyway. An import of a package the
 * project pins (`@acme/gears`) is refused by name: its files live in an
 * installed package directory, and links can't carry packages yet.
 *
 * When the project sets a document unit or its own materials
 * (`fluidcad.json`, or package.json's `fluidcad.unit` / `fluidcad.materials`),
 * the tree also carries a `fluidcad.json` holding ONLY `{ "unit",
 * "materials" }` (each only when set) — never the workspace's own file,
 * which binds the project to a hub model (`modelId`) and may hold whatever
 * else the user put there. The browser host reads both from that file;
 * without it a model follows mm, or its own `unit()` statement, and the
 * built-in materials alone.
 *
 * `options.assets` are the files the model's render read that no import
 * shows — a `load()`'s imported `.brep` and its sidecars, a `text()`'s
 * workspace font — as absolute paths (`FluidCadServer.getRenderAssets`).
 * Those that exist travel too, keyed by their workspace path
 * (`imports/motor.brep`, `fonts/Brand.ttf`), which is the path the viewer's
 * engine asks its asset provider for: as text when the file is UTF-8 (a
 * `.brep` is ASCII), else as a {@link BinaryEntryFile}. Source files are
 * always text. They are what the render read, not a
 * scan of the source for `load("…")` (which would miss a computed name) or
 * of the workspace (which would leak files the model never touches). One
 * resolved outside the workspace, or into `node_modules`, is refused like a
 * module would be.
 */
export async function collectEntryFiles(
  entryAbs: string,
  workspaceAbs: string,
  options: { assets?: readonly string[] } = {},
): Promise<EntryFiles> {
  // The workspace is taken as its real path: esbuild resolves absWorkingDir
  // and every imported file through symlinks but names the stdin wrapper by
  // the resolveDir it was given, so a workspace reached through a link
  // (macOS's /var, /tmp) would list the wrapper as a path outside itself.
  const workspace = normalizePath(realpathSync(workspaceAbs));
  const entryRel = './' + entryPath(entryAbs, workspaceAbs);
  const initAbs = join(workspace, 'init.js');
  const imports = [entryRel];
  if (existsSync(initAbs)) {
    imports.unshift('./init.js');
  }
  const config = readProjectConfig(workspace);
  let closure: ModuleClosure;
  try {
    closure = await ModuleClosure.of(workspace, {
      entries: imports,
      wrapperName: WRAPPER_NAME,
      pinnedPackages: Object.keys(config.dependencies ?? {}),
    });
  } catch (err) {
    if (err instanceof ModuleClosurePackageError) {
      throw new Error(`Links can't carry packages yet (\`${err.packageName}\`).`);
    }
    throw err;
  }
  const files: EntryFiles = {};
  for (const rel of closure.files) {
    if (ModuleClosure.isOutsideWorkspace(rel)) {
      throw new Error(`${rel} lies outside the workspace and cannot be shared by link`);
    }
    if (ModuleClosure.isInNodeModules(rel)) {
      throw new Error(`${rel} is an npm dependency; a link cannot carry it — share the model as a package instead`);
    }
    files[rel] = await readFile(join(workspace, rel), 'utf8');
  }
  for (const asset of options.assets ?? []) {
    const rel = EntryAssets.workspacePath(asset, workspace);
    if (rel !== null && !(rel in files)) {
      files[rel] = EntryAssets.content(await readFile(join(workspace, rel)));
    }
  }
  const { unit, materials } = config;
  if (unit !== null || materials !== null) {
    files[PROJECT_CONFIG_FILENAME] = JSON.stringify({
      ...(unit !== null ? { unit } : {}),
      ...(materials !== null ? { materials } : {}),
    });
  } else {
    delete files[PROJECT_CONFIG_FILENAME];
  }
  return files;
}

/** The files a render read beside its modules, as {@link collectEntryFiles} ships them. */
class EntryAssets {
  /**
   * The asset's workspace-relative POSIX path ({@link RenderAssets.locate}),
   * or null when it does not exist (a sidecar the engine looked for and did
   * not find). Throws for one outside the workspace or inside
   * `node_modules`: the module closure's refusals, for the same reason — a
   * link must not carry files from beyond the model's workspace.
   */
  static workspacePath(assetAbs: string, workspace: string): string | null {
    const location = RenderAssets.locate(assetAbs, workspace);
    switch (location.kind) {
      case 'missing':
        return null;
      case 'outside':
        throw new Error(`${normalizePath(assetAbs)} lies outside the workspace and cannot be shared by link`);
      case 'node-modules':
        throw new Error(`${location.path} lies in node_modules and cannot be shared by link — copy it into the workspace`);
      case 'workspace':
        return location.path;
    }
  }

  /**
   * An asset's bytes as the tree carries them: its text when they are UTF-8
   * — decoding and re-encoding gives the same bytes back, so the viewer
   * reads exactly what the desktop read — else base64.
   */
  static content(bytes: Uint8Array): EntryFile {
    try {
      return EntryAssets.utf8.decode(bytes);
    } catch {
      return { b64: Buffer.from(bytes).toString('base64') };
    }
  }

  private static readonly utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
}
