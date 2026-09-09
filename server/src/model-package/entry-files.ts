import { build } from 'esbuild';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { PROJECT_CONFIG_FILENAME, readProjectConfig } from '../project-config.ts';
import { blockNodeBuiltinsPlugin } from './esbuild-plugins.ts';

/** The virtual entry that imports init.js and the model — never a shipped file. */
const WRAPPER_NAME = '__share_entry__.js';

/** A model's source tree as a viewer link carries it: workspace-relative path → text. */
export type EntryFiles = Record<string, string>;

/**
 * The workspace files one model transitively imports, including itself and
 * `init.js` when the workspace has one — the minimum a viewer needs to
 * recompile the model, which is what a share-by-link ships (a `.fluidpkg`
 * ships the whole workspace instead; see {@link collectWorkspaceFiles}).
 *
 * Resolution is esbuild's, the same the packer bundles with, read off its
 * metafile: `fluidcad/*` stays external (the viewer links its own engine),
 * Node built-ins are refused, and anything resolved outside the workspace
 * or into `node_modules` is an error — a link cannot carry an npm
 * dependency, and the viewer would fail to link it anyway.
 *
 * When the project sets a document unit (`fluidcad.json`, or package.json's
 * `fluidcad.unit`), the tree also carries a `fluidcad.json` holding ONLY
 * `{ "unit" }` — never the workspace's own file, which binds the project to
 * a hub model (`modelId`) and may hold whatever else the user put there.
 * The browser host reads the unit from that file; without it a model
 * follows mm, or its own `unit()` statement.
 */
export async function collectEntryFiles(entryAbs: string, workspaceAbs: string): Promise<EntryFiles> {
  const workspace = normalizePath(workspaceAbs);
  const entryRel = './' + normalizePath(relative(workspace, normalizePath(entryAbs)));
  const initAbs = join(workspace, 'init.js');
  const imports = [entryRel];
  if (existsSync(initAbs)) {
    imports.unshift('./init.js');
  }
  const result = await build({
    stdin: {
      contents: imports.map((rel) => `import ${JSON.stringify(rel)};\n`).join(''),
      resolveDir: workspace,
      sourcefile: WRAPPER_NAME,
      loader: 'js',
    },
    absWorkingDir: workspace,
    format: 'esm',
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    external: ['fluidcad', 'fluidcad/*'],
    plugins: [blockNodeBuiltinsPlugin()],
    logLevel: 'silent',
  });
  if (result.errors.length) {
    throw new Error(result.errors.map((e) => e.text).join('\n'));
  }
  const files: EntryFiles = {};
  for (const input of Object.keys(result.metafile.inputs)) {
    // The virtual wrapper lists itself under its sourcefile name.
    if (input === WRAPPER_NAME || input === '<stdin>') {
      continue;
    }
    const rel = normalizePath(input);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new Error(`${rel} lies outside the workspace and cannot be shared by link`);
    }
    if (rel.split('/').includes('node_modules')) {
      throw new Error(`${rel} is an npm dependency; a link cannot carry it — share the model as a package instead`);
    }
    files[rel] = await readFile(join(workspace, rel), 'utf8');
  }
  const unit = readProjectConfig(workspace).unit;
  if (unit !== null) {
    files[PROJECT_CONFIG_FILENAME] = JSON.stringify({ unit });
  } else {
    delete files[PROJECT_CONFIG_FILENAME];
  }
  return files;
}
